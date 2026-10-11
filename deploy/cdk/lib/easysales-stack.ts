import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Aspects, CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface EasySalesProps extends StackProps {
    // full ARN of the Secrets Manager secret (JSON) written by deploy.mjs: generated keys plus app.env values
    secretArn: string;
    // the JSON keys in that secret; each becomes an environment variable of the containers
    secretKeys: string[];
    instanceType: string;
    // fingerprint of the configuration: a new value rolls out new tasks with the new secrets
    configVersion: string;
}

/*
    One-command deployment on a normal AWS account:
      Docker image (built locally) -> ECR -> ECS on one EC2 instance (task: API + agent worker + MongoDB)
      -> Application Load Balancer (only CloudFront may reach it) -> CloudFront: the https URL.
*/
export class EasySalesStack extends Stack {
    constructor(scope: Construct, id: string, props: EasySalesProps) {
        super(scope, id, props);

        // public subnets only: no NAT gateway to pay for; the instance accepts traffic only from the load balancer
        const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }] });

        const cluster = new ecs.Cluster(this, "Cluster", { vpc });
        cluster.addCapacity("Instances", {
            instanceType: new ec2.InstanceType(props.instanceType),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
            minCapacity: 1, maxCapacity: 1,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, associatePublicIpAddress: true,
        });
        // instance metadata only with session tokens (IMDSv2)
        Aspects.of(this).add(new autoscaling.AutoScalingGroupRequireImdsv2Aspect());

        /* ---------- the https URL: load balancer behind CloudFront (its certificate, no domain needed) ---------- */

        const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", { vpc, internetFacing: true });
        const listener = alb.addListener("Http", { port: 80, open: false });
        // only CloudFront may reach the load balancer (AWS-managed prefix list, looked up at deploy time)
        const prefixList = new cr.AwsCustomResource(this, "CloudFrontPrefixList", {
            onUpdate: {
                service: "EC2", action: "describeManagedPrefixLists",
                parameters: { Filters: [{ Name: "prefix-list-name", Values: ["com.amazonaws.global.cloudfront.origin-facing"] }] },
                physicalResourceId: cr.PhysicalResourceId.of("cloudfront-origin-facing"),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
            installLatestAwsSdk: false,
        });
        alb.connections.allowFrom(ec2.Peer.prefixList(prefixList.getResponseField("PrefixLists.0.PrefixListId")), ec2.Port.tcp(80), "CloudFront only");

        // nothing is cached: it is an app, every request goes to the server
        const distribution = new cloudfront.Distribution(this, "Cdn", {
            defaultBehavior: {
                origin: new origins.LoadBalancerV2Origin(alb, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY, readTimeout: Duration.seconds(60) }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
            },
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        });
        const url = `https://${distribution.distributionDomainName}`;

        /* ---------- the task: API, agent worker and MongoDB on the instance ---------- */

        // built from the repository's Dockerfile and pushed to ECR by `cdk deploy`
        const image = ecs.ContainerImage.fromAsset(REPO_ROOT, {
            platform: Platform.LINUX_AMD64,
            exclude: ["**/node_modules", "**/dist", "**/.env", "**/.env.*", "!**/.env.example", ".git", "deploy", "**/coverage", "**/*.log", ".idea"],
        });
        const secret = secretsmanager.Secret.fromSecretCompleteArn(this, "AppSecret", props.secretArn);
        const secrets = Object.fromEntries(props.secretKeys.map((k) => [k, ecs.Secret.fromSecretsManager(secret, k)]));
        const environment = { CONFIG_VERSION: props.configVersion, NODE_ENV: "production", MONGO_URI: "mongodb://mongodb:27017/easysales", FRONTEND_URL: url, CORS_ORIGIN: url, PUBLIC_API_URL: url };
        const logging = (prefix: string) => ecs.LogDrivers.awsLogs({ streamPrefix: prefix, logRetention: logs.RetentionDays.ONE_MONTH });

        const task = new ecs.Ec2TaskDefinition(this, "Task", { networkMode: ecs.NetworkMode.BRIDGE });
        // ponytail: MongoDB keeps its data on the instance's disk (survives task restarts and redeploys, not a
        // replaced instance); set MONGO_URI to Atlas or DocumentDB when the data must outlive the instance
        task.addVolume({ name: "mongo-data", host: { sourcePath: "/data/easysales-mongo" } });

        const mongo = task.addContainer("mongodb", {
            image: ecs.ContainerImage.fromRegistry("mongo:7"),
            command: ["mongod", "--quiet", "--wiredTigerCacheSizeGB", "0.25"],
            memoryReservationMiB: 400,
            logging: logging("mongodb"),
            healthCheck: { command: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' || exit 1"], interval: Duration.seconds(15), retries: 5, startPeriod: Duration.seconds(30) },
        });
        mongo.addMountPoints({ containerPath: "/data/db", sourceVolume: "mongo-data", readOnly: false });

        // migrations run before every start; a failed one stops the deploy and the circuit breaker rolls back
        const api = task.addContainer("api", {
            image, secrets, environment: { ...environment, RUN_WORKER: "false" },
            command: ["sh", "-c", "node dist/migrate.js && node dist/server.js"],
            memoryReservationMiB: 400,
            portMappings: [{ containerPort: 5000 }],
            logging: logging("api"),
        });
        api.addLink(mongo, "mongodb");
        api.addContainerDependencies({ container: mongo, condition: ecs.ContainerDependencyCondition.HEALTHY });

        // the agents: research, outreach, follow-ups, inbox reading, daily lead finder, prototypes
        const worker = task.addContainer("worker", {
            image, secrets, environment,
            command: ["node", "dist/worker.js"],
            memoryReservationMiB: 350,
            logging: logging("worker"),
        });
        worker.addLink(mongo, "mongodb");
        worker.addContainerDependencies({ container: api, condition: ecs.ContainerDependencyCondition.START });

        const service = new ecs.Ec2Service(this, "Service", {
            cluster, taskDefinition: task, desiredCount: 1,
            // one MongoDB on one host volume: the old task stops before the new one starts
            minHealthyPercent: 0, maxHealthyPercent: 100,
            circuitBreaker: { rollback: true },
            healthCheckGracePeriod: Duration.minutes(3),
        });
        listener.addTargets("Api", {
            port: 80,
            targets: [service.loadBalancerTarget({ containerName: "api", containerPort: 5000 })],
            healthCheck: { path: "/api/health", healthyHttpCodes: "200", interval: Duration.seconds(30) },
            deregistrationDelay: Duration.seconds(15),
        });

        new CfnOutput(this, "Url", { value: url, description: "easySales (https)" });
    }
}

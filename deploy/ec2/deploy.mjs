// One command for an EC2-only AWS account:  npm run deploy  (from deploy/ec2)
// Uses EC2 API calls only (no CloudFormation, ECR or ECS). First run launches the instance; later runs update it.
//  1. finds the VPC (Hackathon_VPC) and a public subnet, the latest Amazon Linux 2023 image
//  2. creates (once) a key pair saved in deploy/ec2/.ssh and a security group: 80/443 open, 22 from your IP only
//  3. launches one instance with user-data.sh (or reuses the running one: never a second instance)
//  4. sends app.env over SSH (never in user data), pulls the latest code, rebuilds, prints the https URL
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import {
    AuthorizeSecurityGroupIngressCommand, CreateKeyPairCommand, CreateSecurityGroupCommand, DescribeImagesCommand,
    DescribeInstancesCommand, DescribeKeyPairsCommand, DescribeRouteTablesCommand, DescribeSecurityGroupsCommand,
    DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client, RunInstancesCommand, waitUntilInstanceRunning,
} from "@aws-sdk/client-ec2";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const VPC_NAME = process.env.VPC_NAME || "Hackathon_VPC";
const TYPE = process.env.INSTANCE_TYPE || "t3.small";
const NAME = "easysales";
const KEY_NAME = process.env.KEY_NAME || "easysales-key";
const KEY_FILE = `${DIR}.ssh/${KEY_NAME}.pem`;
const ec2 = new EC2Client({ region });

const say = (m) => console.log(`\n▶ ${m}`);
function fail(m) { console.error(`\n✖ ${m}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- configuration to send ---------- */
if (!existsSync(`${DIR}app.env`)) fail("Create deploy/ec2/app.env first: copy app.env.example and fill it in (at least ADMIN_EMAILS).");
const OWNED_BY_SERVER = new Set(["NODE_ENV", "MONGO_URI", "FRONTEND_URL", "CORS_ORIGIN", "PUBLIC_API_URL", "PREVIEW_BASE_URL", "RUN_WORKER", "PORT",
    "ACCESS_TOKEN_SECRET", "REFRESH_TOKEN_SECRET", "ENCRYPTION_KEY", "BILLING_WEBHOOK_SECRET"]);
const appEnv = readFileSync(`${DIR}app.env`, "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m) => m && m[2] !== "" && !OWNED_BY_SERVER.has(m[1]))
    .map((m) => `${m[1]}=${m[2].replace(/^(["'])(.*)\1$/, "$2")}`);
const adminEmail = appEnv.find((l) => l.startsWith("ADMIN_EMAILS="))?.split("=")[1].split(",")[0].trim();
if (!adminEmail) fail("Set ADMIN_EMAILS (your email) in deploy/ec2/app.env.");

/* ---------- ssh ---------- */
function ssh(ip, command, input) {
    const r = spawnSync("ssh", ["-i", KEY_FILE, "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${DIR}.ssh/known_hosts`,
        "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", `ec2-user@${ip}`, command], { input, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });
    return r.status === 0;
}
// the key must be readable by you only, or ssh refuses it (Windows needs ACLs, not chmod)
function lockDown(file) {
    if (process.platform === "win32") {
        spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], { stdio: "ignore" });
    } else chmodSync(file, 0o600);
}

/* ---------- network, image, key, firewall ---------- */
say(`Checking access (${region})`);
let vpc;
try {
    vpc = (await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "tag:Name", Values: [VPC_NAME] }] }))).Vpcs?.[0];
} catch (error) {
    fail(`AWS refused the request: ${error.message}\n  Set an access key first (aws configure, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).`);
}
if (!vpc) fail(`No VPC named ${VPC_NAME} in ${region}.`);

const existing = (await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "tag:Name", Values: [NAME] }, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }] })))
    .Reservations?.flatMap((r) => r.Instances ?? [])[0];
if (existing && existing.State?.Name !== "running" && existing.State?.Name !== "pending") fail(`Instance ${existing.InstanceId} is ${existing.State?.Name}. Start it in the console (its IP and URL will change), then run again.`);

if (!existsSync(KEY_FILE)) {
    if (existing) fail(`The instance exists but its key ${KEY_FILE} is missing on this computer. Copy the .pem here from the computer that launched it.`);
    const known = await ec2.send(new DescribeKeyPairsCommand({ Filters: [{ Name: "key-name", Values: [KEY_NAME] }] }));
    if (known.KeyPairs?.length) fail(`Key pair ${KEY_NAME} exists in AWS but not in ${KEY_FILE}. Set KEY_NAME=easysales-key-2 and run again.`);
    say(`Creating key pair ${KEY_NAME}`);
    const key = await ec2.send(new CreateKeyPairCommand({ KeyName: KEY_NAME, KeyType: "ed25519" }));
    mkdirSync(`${DIR}.ssh`, { recursive: true });
    writeFileSync(KEY_FILE, key.KeyMaterial.endsWith("\n") ? key.KeyMaterial : `${key.KeyMaterial}\n`);
    lockDown(KEY_FILE);
}

const myIp = (await (await fetch("https://checkip.amazonaws.com")).text()).trim();
let sg = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "vpc-id", Values: [vpc.VpcId] }, { Name: "group-name", Values: [`${NAME}-sg`] }] }))).SecurityGroups?.[0];
if (!sg) {
    say("Creating security group (80/443 open, SSH from your IP only)");
    const id = (await ec2.send(new CreateSecurityGroupCommand({ GroupName: `${NAME}-sg`, Description: "easySales: web open, SSH from the deployer only", VpcId: vpc.VpcId }))).GroupId;
    sg = { GroupId: id, IpPermissions: [] };
}
const has = (port, cidr) => sg.IpPermissions?.some((p) => p.FromPort === port && p.IpRanges?.some((r) => r.CidrIp === cidr));
const rules = [[80, "0.0.0.0/0"], [443, "0.0.0.0/0"], [22, `${myIp}/32`]].filter(([port, cidr]) => !has(port, cidr));
if (rules.length) {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: sg.GroupId,
        IpPermissions: rules.map(([port, cidr]) => ({ IpProtocol: "tcp", FromPort: port, ToPort: port, IpRanges: [{ CidrIp: cidr, Description: port === 22 ? "deployer" : "web" }] })),
    }));
}

/* ---------- the instance: launch once, reuse after ---------- */
let instance = existing;
if (!instance) {
    // a public subnet routes 0.0.0.0/0 to an internet gateway
    const subnets = (await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [vpc.VpcId] }] }))).Subnets ?? [];
    const tables = (await ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [vpc.VpcId] }] }))).RouteTables ?? [];
    const toIgw = (t) => t.Routes?.some((r) => r.DestinationCidrBlock === "0.0.0.0/0" && r.GatewayId?.startsWith("igw-"));
    const main = tables.find((t) => t.Associations?.some((a) => a.Main));
    const isPublic = (s) => { const t = tables.find((x) => x.Associations?.some((a) => a.SubnetId === s.SubnetId)) ?? main; return t && toIgw(t); };
    const subnet = subnets.find(isPublic);
    if (!subnet) fail(`No public subnet (route to an internet gateway) in ${VPC_NAME}.`);

    const image = (await ec2.send(new DescribeImagesCommand({ Owners: ["amazon"], Filters: [{ Name: "name", Values: ["al2023-ami-2023.*-kernel-*-x86_64"] }, { Name: "state", Values: ["available"] }] })))
        .Images?.sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))[0];
    if (!image) fail("Amazon Linux 2023 image not found.");

    // user data carries only the email; keys follow over SSH
    const userData = readFileSync(`${DIR}user-data.sh`, "utf8").replace(/^ADMIN_EMAIL=.*$/m, `ADMIN_EMAIL="${adminEmail.replace(/[^\w.@+-]/g, "")}"`);
    say(`Launching ${TYPE} in ${VPC_NAME} (${subnet.SubnetId})`);
    instance = (await ec2.send(new RunInstancesCommand({
        ImageId: image.ImageId, InstanceType: TYPE, KeyName: KEY_NAME, MinCount: 1, MaxCount: 1,
        NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: subnet.SubnetId, Groups: [sg.GroupId], AssociatePublicIpAddress: true }],
        BlockDeviceMappings: [{ DeviceName: image.RootDeviceName ?? "/dev/xvda", Ebs: { VolumeSize: 20, VolumeType: "gp3", DeleteOnTermination: true } }],
        MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
        UserData: Buffer.from(userData).toString("base64"),
        TagSpecifications: [{ ResourceType: "instance", Tags: [{ Key: "Name", Value: NAME }] }],
    }))).Instances[0];
    await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, { InstanceIds: [instance.InstanceId] });
}
instance = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instance.InstanceId] }))).Reservations[0].Instances[0];
const ip = instance.PublicIpAddress;
if (!ip) fail(`Instance ${instance.InstanceId} has no public IP.`);
console.log(`  instance ${instance.InstanceId} at ${ip}`);

/* ---------- configure and (re)deploy over SSH ---------- */
say("Waiting for SSH");
for (let i = 0; i < 40 && !ssh(ip, "true"); i++) await sleep(10_000);
say("Waiting for the first-boot install to finish (about 10 minutes on a new instance)");
if (!ssh(ip, "sudo cloud-init status --wait >/dev/null; test -f /opt/easysales/server/.env")) fail("First-boot install did not finish. See: ssh in and run  sudo tail -50 /var/log/easysales-setup.log");

say("Sending configuration and updating to the latest code");
// keys arrive on stdin and are merged into server/.env in place (values are never parsed by a shell)
const merge = `import sys,re
p='/opt/easysales/server/.env'; s=open(p).read()
for line in sys.stdin.read().splitlines():
    k,v=line.split('=',1)
    s=re.sub(r'(?m)^'+k+'=.*$', lambda m: k+'='+v, s) if re.search(r'(?m)^'+k+'=', s) else s+('' if s.endswith('\\n') else '\\n')+k+'='+v+'\\n'
open(p,'w').write(s)`;
// the script travels base64-encoded so no shell ever interprets it
const script = Buffer.from(merge).toString("base64");
if (!ssh(ip, `echo ${script} | base64 -d > /tmp/easysales-merge.py && sudo python3 /tmp/easysales-merge.py; rc=$?; rm -f /tmp/easysales-merge.py; exit $rc`, appEnv.join("\n") + "\n")) fail("Could not write the configuration.");
if (!ssh(ip, "cd /opt/easysales && sudo git pull --ff-only && sudo bash deploy/ec2/setup.sh")) fail("Deploy failed on the server. Logs: ssh in and run  sudo docker compose -f /opt/easysales/deploy/ec2/docker-compose.yml logs --tail 100");

const domain = `${ip.replaceAll(".", "-")}.sslip.io`;
console.log(`\n✔ easySales is live at https://${domain}\n  SSH: ssh -i ${KEY_FILE} ec2-user@${ip}\n`);

import { App } from "aws-cdk-lib";
import { EasySalesStack } from "../lib/easysales-stack.js";

const app = new App();
// set by deploy.mjs: the keys present in the app secret (each becomes a container environment variable)
const secretKeys = String(app.node.tryGetContext("secretKeys") ?? "").split(",").filter(Boolean);

new EasySalesStack(app, "EasySales", {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
    // placeholder only for `cdk synth` without deploy.mjs
    secretArn: app.node.tryGetContext("secretArn") ?? "arn:aws:secretsmanager:us-east-1:000000000000:secret:easysales/app-AbCdEf",
    secretKeys,
    instanceType: app.node.tryGetContext("instanceType") ?? "t3.small",
    configVersion: app.node.tryGetContext("configVersion") ?? "synth",
});

// One command:  npm run deploy  (from deploy/cdk)
// 1. stores app.env + generated keys in Secrets Manager (never in templates or the image)
// 2. cdk bootstrap (first time only) and cdk deploy: Docker build -> ECR -> ECS on EC2 -> ALB -> CloudFront
// 3. prints the https URL
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const here = (p) => new URL(p, import.meta.url);
const region = (process.env.AWS_REGION ||= process.env.AWS_DEFAULT_REGION || "us-east-1");
process.env.AWS_DEFAULT_REGION = region;
const SECRET = process.env.SECRET_NAME || "easysales/app";

// set by the stack itself; they must not come from app.env
const OWNED_BY_STACK = new Set(["NODE_ENV", "MONGO_URI", "FRONTEND_URL", "CORS_ORIGIN", "PUBLIC_API_URL", "PREVIEW_BASE_URL", "RUN_WORKER", "PORT"]);
// created once and kept across deploys (rotating ENCRYPTION_KEY would make stored credentials unreadable)
const GENERATED = ["ACCESS_TOKEN_SECRET", "REFRESH_TOKEN_SECRET", "ENCRYPTION_KEY", "BILLING_WEBHOOK_SECRET"];

function fail(message) {
    console.error(`\n✖ ${message}`);
    process.exit(1);
}
function run(cmd, args) {
    const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", cwd: fileURLToPath(here(".")) });
    if (r.status !== 0) fail(`${cmd} ${args[0]} failed`);
}

if (!existsSync(here("app.env"))) fail("Create deploy/cdk/app.env first: copy app.env.example and fill in your keys.");
if (spawnSync("docker", ["info"], { stdio: "ignore", shell: process.platform === "win32" }).status !== 0) fail("Docker is not running; start Docker Desktop and run again.");

const fromFile = Object.fromEntries(readFileSync(here("app.env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m) => m && m[2] !== "" && !OWNED_BY_STACK.has(m[1]))
    .map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")]));
if (!fromFile.LLM_API_KEY) console.warn("! LLM_API_KEY is empty: the app runs, but no AI agent can work until you set it.");

console.log(`\n▶ Storing configuration in Secrets Manager (${SECRET}, ${region})`);
const sm = new SecretsManagerClient({ region });
let existing = null;
try {
    existing = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET }))).SecretString || "{}");
} catch (error) {
    if (error.name !== "ResourceNotFoundException") fail(`Cannot read ${SECRET}: ${error.message}. Are your AWS credentials set (aws configure)?`);
}
const generated = Object.fromEntries(GENERATED.map((k) => [k, existing?.[k] || randomBytes(32).toString("hex")]));
const value = JSON.stringify({ ...generated, ...fromFile });
const saved = existing
    ? await sm.send(new PutSecretValueCommand({ SecretId: SECRET, SecretString: value }))
    : await sm.send(new CreateSecretCommand({ Name: SECRET, SecretString: value, Description: "easySales app configuration (written by deploy/cdk/deploy.mjs)" }));
const keys = Object.keys(JSON.parse(value)).join(",");
// ECS reads secrets only when a task starts: a changed configuration must roll out new tasks
const configVersion = createHash("sha256").update(value).digest("hex").slice(0, 12);

console.log("\n▶ Bootstrapping CDK (only does work the first time)");
run("npx", ["cdk", "bootstrap", "--quiet"]);

console.log("\n▶ Building the image and deploying (first deploy takes 10-15 minutes, mostly CloudFront)");
run("npx", ["cdk", "deploy", "EasySales", "--require-approval", "never", "--outputs-file", "cdk-outputs.json", "-c", `secretKeys=${keys}`, "-c", `secretArn=${saved.ARN}`, "-c", `configVersion=${configVersion}`]);

const url = JSON.parse(readFileSync(here("cdk-outputs.json"), "utf8")).EasySales?.Url;
console.log(`\n✔ easySales is live at ${url}\n  (the first start runs migrations; give it a minute if it shows 502/503)\n`);

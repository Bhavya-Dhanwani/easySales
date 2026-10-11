# One-command deploy to AWS (CDK)

For a **normal AWS account** (your own). The hackathon account only allows EC2, so use [EC2.md](EC2.md) there.

```
npm run deploy
   ├─ Secrets Manager: your app.env + generated keys (never in templates or the image)
   ├─ Docker build (repository Dockerfile) ─► ECR
   ├─ ECS cluster on one EC2 instance ─► task: API + agent worker + MongoDB
   ├─ Application Load Balancer (reachable only from CloudFront)
   └─ CloudFront ─► https://dxxxxxxxx.cloudfront.net   ← printed at the end
```

The worker runs on the server, so the agents keep working (daily lead finder, outreach, follow-ups, inbox, replies) when your laptop is closed.

## You need
- An AWS account with administrator access, and the AWS CLI signed in (`aws configure` or `aws sso login`).
- Docker Desktop running, because the image is built on your machine.
- Node 22.

## Deploy

```bash
cd deploy/cdk
npm ci
cp app.env.example app.env      # then fill in LLM_API_KEY, SMTP_*, ADMIN_EMAILS, optional TAVILY_API_KEY
npm run deploy
```

After the first time, `npm run deploy` is the only command: it rebuilds the image, updates the configuration and rolls out. The first deploy takes 10–15 minutes, mostly waiting for CloudFront. The region is `us-east-1` unless `AWS_REGION` is set.

What it does:
1. Stores `app.env` in the Secrets Manager secret `easysales/app`, together with keys generated once and kept across deploys: `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `ENCRYPTION_KEY`, `BILLING_WEBHOOK_SECRET`. Never rotate `ENCRYPTION_KEY` by hand, because stored mailbox credentials would become unreadable.
2. Runs `cdk bootstrap` (the first time only), then `cdk deploy`. CDK builds the Docker image and pushes it to ECR. CloudFormation creates the VPC, the ECS cluster with one `t3.small`, the task, the service, the load balancer and CloudFront.
3. Prints the HTTPS URL. The app sets its own `FRONTEND_URL`, `CORS_ORIGIN` and `PUBLIC_API_URL` to it.

Then open the URL, sign up, and set up the agent as in [EC2.md, step 3](EC2.md#3-set-up-the-agent-in-the-app-once).

## Security
- The load balancer only accepts CloudFront (AWS-managed prefix list). The instance only accepts the load balancer, and only on ECS's dynamic ports. MongoDB isn't exposed at all.
- The instance requires IMDSv2. Only the task execution role can read the app secret. Containers get the secret values as environment variables at start.
- A deploy whose new task fails its health checks is rolled back automatically (ECS circuit breaker).

## Costs (us-east-1, approximate)

| Item | Per month |
|---|---|
| EC2 `t3.small` | ≈ $15 |
| Application Load Balancer | ≈ $17 |
| Public IPv4 addresses (load balancer and instance) | ≈ $11 |
| CloudFront, Secrets Manager, CloudWatch Logs, ECR | ≈ $1–2 (CloudFront free tier covers a small app) |
| **Total** | **≈ $45 / month** (≈ $15 for 10 days) |

For a bigger instance: `npx cdk deploy -c instanceType=t3.medium ...`, or edit `bin/app.ts`.

## Operate
- **Logs:** CloudWatch → Log groups → `EasySales-Task…` (streams `api/…`, `worker/…`, `mongodb/…`).
- **Change configuration:** edit `app.env` and run `npm run deploy` (the tasks restart with the new values).
- **Remove everything:** `npm run destroy`. Then delete the secret `easysales/app` in Secrets Manager if you won't redeploy. CDK's bootstrap stack (`CDKToolkit`) can stay.

## Limits (deliberate, for a single-instance pilot)
- MongoDB runs in the task, with its data on the instance's disk (`/data/easysales-mongo`). It survives restarts and redeploys, but not the instance being replaced. For data that must last, put a MongoDB Atlas URI in `app.env` as `MONGO_URI`, and remove the `mongodb` container and the `MONGO_URI` default in `lib/easysales-stack.ts`.
- One instance and one task: deploys stop the old task before starting the new one, so there are about two minutes of downtime per deploy.
- The URL is a `cloudfront.net` address. For your own domain, add an ACM certificate (us-east-1) and `domainNames` to the distribution.

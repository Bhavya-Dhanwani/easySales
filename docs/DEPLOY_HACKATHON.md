# Deploying easySales on the hackathon AWS account: step by step

The hackathon account allows only **EC2, Lambda, IAM roles and load balancers**, in **us-east-1**, inside **Hackathon_VPC**, with **one instance**. Everything here uses EC2 only.

There are two ways. Use **A** if you can create an AWS access key, otherwise **B**.

| | A. One command from your laptop | B. AWS console only |
|---|---|---|
| Needs | an AWS access key for your IAM user | only your console login |
| Deploy | `npm run deploy` | launch the instance by hand, paste User data |
| Redeploy | `npm run deploy` again | 2 commands in EC2 Instance Connect |

Cost either way: about **$7 for 10 days** (t3.small + public IP + 20 GB disk) of the $25 allowance.

---

## Part A: one command from your laptop

### A1. One-time: get an access key (5 minutes)
1. Open your private access link, click **Reveal AWS access**, then **Open AWS console**. Sign in with the IAM username and console password shown (enter the account ID if asked).
2. In the search bar at the top, type **IAM** and open it.
3. Left menu: **Users**. Click **your** username (the one you signed in with).
4. Open the **Security credentials** tab and scroll to **Access keys**. Click **Create access key**.
5. Choose **Command Line Interface (CLI)**, tick the confirmation box, click **Next**, then **Create access key**.
6. **Copy both values now**: the *Access key ID* (starts with `AKIA`) and the *Secret access key*. The secret is shown only once. Click **Download .csv file** to keep a copy somewhere safe.
   - Never paste these into chat, code, GitHub or EC2 User data.
   - If you see **"not authorized to perform iam:CreateAccessKey"**, the organisers blocked keys: use **Part B**.

### A2. One-time: prepare your laptop (5 minutes)
You need Node 22 (installed), Git (installed) and OpenSSH (built into Windows 10/11: check with `ssh -V`).

Open **PowerShell** and run:

```powershell
cd D:\work\Projects\clientpipe\deploy\ec2
npm install
copy app.env.example app.env
notepad app.env
```

In Notepad, fill in:

| Line | Value |
|---|---|
| `ADMIN_EMAILS=` | **required**: your email (Operations access and the HTTPS certificate contact) |
| `LLM_API_KEY=`, `LLM_BASE_URL=`, `LLM_MODEL_SMART=`, `LLM_MODEL_FAST=` | your AI provider (can be added later) |
| `SMTP_USER=`, `SMTP_PASS=`, `SENDING_USER=`, `SEND_MAIL=true` | Gmail address + app password (can be added later; without them, sign-up codes go to the server log) |
| `TAVILY_API_KEY=` | your Tavily key (optional) |

Save and close Notepad. `app.env` is git-ignored and never goes to GitHub. The script sends it to the server over SSH.

### A3. Deploy
In the same PowerShell window, give it your access key (for this window only):

```powershell
$env:AWS_ACCESS_KEY_ID = "AKIA...your key id..."
$env:AWS_SECRET_ACCESS_KEY = "...your secret..."
$env:AWS_REGION = "us-east-1"
npm run deploy
```

(If you have the AWS CLI installed, `aws configure` once instead, with region `us-east-1`.)

What you'll see, step by step (first time about 12–15 minutes):

| Output | What is happening |
|---|---|
| `▶ Checking access (us-east-1)` | finds Hackathon_VPC; fails fast if the key is wrong |
| `▶ Creating key pair easysales-key` | creates an SSH key, saved to `deploy\ec2\.ssh\easysales-key.pem` (**back this file up**) |
| `▶ Creating security group` | web ports 80/443 open; SSH (22) only from your current IP |
| `▶ Launching t3.small in Hackathon_VPC` | starts the one instance, 20 GB disk, IMDSv2 |
| `▶ Waiting for SSH` | the instance is booting |
| `▶ Waiting for the first-boot install to finish` | Docker, code download, secret keys, first build (~10 min) |
| `▶ Sending configuration and updating to the latest code` | your `app.env` goes in, `git pull`, rebuild, HTTPS check |
| `✔ easySales is live at https://3-91-20-7.sslip.io` | done: open this link |

### A4. First login
1. Open the printed link and click **Sign up**: your name, email and a password.
2. The verification code:
   - **With SMTP set:** it's in your inbox.
   - **Without SMTP:** read it from the server log. Use the IP from the printed link:
     ```powershell
     ssh -i .ssh\easysales-key.pem ec2-user@3.91.20.7 "sudo docker compose -f /opt/easysales/deploy/ec2/docker-compose.yml logs api | grep 'Mail Mock'"
     ```
     Copy the code from the last line and enter it on the site.
3. Set up the agent (once):
   1. **Business:** services and prices, approved claims, **lead search terms** (e.g. `dentist`) and **areas** (e.g. `Pune`), and **Daily lead finder** on, with the reason you may contact them. Click **Save business brain**.
   2. **Email:** connect your Gmail. Use host `smtp.gmail.com`, port `587`, your Gmail address and the app password, and tick **Read replies from this inbox** (turn IMAP on in Gmail settings first).
   3. **Campaigns → New:** audience **qualified**, then **Start**.
   4. **Operations → flags:** turn on `live_email`. Keep Copilot mode: you approve each email from your phone.
4. Test it: **Leads → Find leads → Search my whole niche**, tick a few and click **Add to leads**. Research runs, and drafts appear for approval.

### A5. Redeploy (every time after)
Same window, or a new one with the three `$env:` lines again:

```powershell
cd D:\work\Projects\clientpipe\deploy\ec2
npm run deploy
```

| You changed… | Do this |
|---|---|
| **code** | push it to GitHub `main` first (the server pulls from GitHub), then `npm run deploy` |
| **keys / settings** | edit `deploy\ec2\app.env`, then `npm run deploy` |
| **your laptop's IP** (new Wi-Fi) | nothing extra: the script adds your new IP for SSH |

A redeploy takes about 2–4 minutes. It reuses the same instance (never a second one), keeps the database, and the URL stays the same.

---

## Part B: AWS console only (no access key)

### B1. Launch the instance (about 5 minutes of clicking)
1. Open your private access link, click **Reveal AWS access**, then **Open AWS console**, and sign in.
2. Top-right region selector: **US East (N. Virginia) us-east-1**.
3. Search bar: **EC2**, then **Instances**, then **Launch instances**.
4. **Name:** `easysales`.
5. **Application and OS Images:** **Amazon Linux**, then **Amazon Linux 2023 AMI** (64-bit x86).
6. **Instance type:** `t3.small`.
7. **Key pair:** **Create new key pair**. Name `easysales-key`, type ED25519, format `.pem`. **Create**, and keep the downloaded file.
8. **Network settings:** click **Edit**.
   - **VPC:** `Hackathon_VPC`
   - **Subnet:** one marked **public** (if unsure, pick one and check that **Auto-assign public IP** can be enabled)
   - **Auto-assign public IP:** **Enable**
   - **Firewall:** **Create security group**, named `easysales-sg`
     - Rule 1: type **SSH**, source **My IP**
     - **Add security group rule:** type **HTTP**, source **Anywhere (0.0.0.0/0)**
     - **Add security group rule:** type **HTTPS**, source **Anywhere (0.0.0.0/0)**
9. **Configure storage:** `20` GiB, **gp3**.
10. **Advanced details:** scroll to the bottom, to **User data**, and paste the whole of [`deploy/ec2/user-data.sh`](../deploy/ec2/user-data.sh). Change only the line `ADMIN_EMAIL="you@example.com"` to your email.
11. Click **Launch instance**, then **View all instances**.

### B2. Wait for it (about 10 minutes)
1. Tick the `easysales` instance and wait for **Instance state: Running** and **Status checks: 2/2**.
2. **Actions → Monitor and troubleshoot → Get system log**. Refresh every couple of minutes until you see `Live at https://<ip-with-dashes>.sslip.io`.

### B3. Add keys and first login
1. Tick the instance, click **Connect**, open the **EC2 Instance Connect** tab, then click **Connect**. A terminal opens in the browser.
   - If that's blocked, use SSH from PowerShell: `ssh -i path\to\easysales-key.pem ec2-user@<public IP>`.
2. Add your keys:
   ```bash
   sudo nano /opt/easysales/server/.env
   ```
   Use the arrow keys to reach each line (`LLM_API_KEY=`, `TAVILY_API_KEY=`, `SMTP_USER=` …) and type the values. Save with **Ctrl+O**, then **Enter**, then exit with **Ctrl+X**.
3. Apply them:
   ```bash
   sudo bash /opt/easysales/deploy/ec2/setup.sh
   ```
4. Open the link, **Sign up**. The verification code (without SMTP):
   ```bash
   sudo docker compose -f /opt/easysales/deploy/ec2/docker-compose.yml logs api | grep 'Mail Mock'
   ```
5. Set up the agent exactly as in **A4, step 3**.

### B4. Redeploy
Connect (B3 step 1), then:

```bash
cd /opt/easysales && sudo git pull && sudo bash deploy/ec2/setup.sh
```

To change keys: `sudo nano /opt/easysales/server/.env`, then `sudo bash /opt/easysales/deploy/ec2/setup.sh`.

---

## Rules that keep it working
- **Don't stop the instance.** A stop/start changes its IP, so the `sslip.io` address changes and links already emailed break. Leave it running.
- **Only one instance.** The account terminates extras. The script never launches a second one, so don't launch one by hand while it exists.
- **The data lives on the instance.** Back it up before terminating:
  ```bash
  sudo docker compose -f /opt/easysales/deploy/ec2/docker-compose.yml exec mongodb mongodump --archive=/backups/easysales-$(date +%F).gz --gzip
  ```
- **When the event ends:** EC2 → Instances → tick `easysales` → **Instance state → Terminate**. That stops all spending.

## Troubleshooting

| Message | Fix |
|---|---|
| `AWS refused the request: ... credentials` | the three `$env:` lines weren't set in this PowerShell window |
| `UnauthorizedOperation` / `not authorized` | the organisers' permissions block that call: use Part B |
| `No VPC named Hackathon_VPC` | check the region is us-east-1 (`$env:AWS_REGION`) |
| `Key pair easysales-key exists in AWS but not in ...` | the `.pem` is on another computer: copy it to `deploy\ec2\.ssh\`, or run with `$env:KEY_NAME = "easysales-key-2"` |
| `Instance ... is stopped` | start it in the console (the URL changes), then run again |
| `First-boot install did not finish` | SSH in and run `sudo tail -50 /var/log/easysales-setup.log`, then send me the output |
| Site shows **502** right after deploy | the app is still starting: wait a minute and refresh |
| HTTPS doesn't come up | `sudo docker compose -f /opt/easysales/deploy/ec2/docker-compose.yml logs caddy`. sslip.io certificates are sometimes rate-limited, and Caddy retries with ZeroSSL automatically |
| AI steps fail with "The AI provider rejected the API key" | `LLM_API_KEY` and `LLM_BASE_URL` don't match: fix them in `app.env` (A) or `server/.env` (B) and redeploy |

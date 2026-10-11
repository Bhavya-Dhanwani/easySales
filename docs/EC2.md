# Running easySales on one EC2 instance

Everything runs on the server: the website, the API, the database and the **agent worker**. The worker finds leads daily, researches them, sends emails and follow-ups, reads replies, and builds prototypes. Once it's set up, you can close the site and your laptop and the work continues. You approve messages from any browser, including your phone.

```
internet ─► Caddy (HTTPS, automatic certificates) ─► API + app ─► MongoDB
                                                     worker ────┘   (all on one instance)
```

## Cost on the hackathon account (us-east-1)

| Item | Price | 10 days |
|---|---|---|
| EC2 `t3.small` (2 GB, recommended) | $0.0208 / hour | ≈ $5.00 |
| Public IPv4 address | $0.005 / hour | ≈ $1.20 |
| 20 GB gp3 disk | $0.08 / GB-month | ≈ $0.55 |
| **Total** | | **≈ $7 of the $25** |

A `t3.medium` (4 GB) costs about $12 for 10 days, if you want more headroom. No load balancer is needed (Caddy does HTTPS on the instance), and the account doesn't allow certificates for a load balancer anyway.

## 1. Launch the instance (AWS console, region us-east-1)

EC2 → **Launch instance**:
- **Name:** `easysales`
- **AMI:** Amazon Linux 2023 (64-bit x86)
- **Instance type:** `t3.small`
- **Key pair:** create one and keep the `.pem` file
- **Network settings → Edit:**
  - **VPC:** `Hackathon_VPC`, a **public** subnet, **Auto-assign public IP: Enable**
  - **Security group:** create a new one with:
    - SSH (22) from **My IP** only
    - HTTP (80) from anywhere, so the certificate can be issued
    - HTTPS (443) from anywhere
- **Storage:** 20 GB gp3 (the limit is 50 GB)

Remember the account allows **one instance**. Terminate a failed one before launching another.

## 2. Install (on the instance)

Connect with **EC2 → Connect → EC2 Instance Connect** (in the browser), or with `ssh -i key.pem ec2-user@<public-ip>`. Then run:

```bash
sudo dnf install -y git
git clone https://github.com/Bhavya-Dhanwani/easySales.git
cd easySales
bash deploy/ec2/setup.sh
```

If the repository is private, clone with a GitHub fine-grained token that has read-only access to that repository only.

The first run installs Docker, adds swap, picks the address `https://<your-ip-with-dashes>.sslip.io`, and creates `server/.env` with fresh secrets. Then it stops so you can fill in the rest:

```bash
nano server/.env
```

| Key | What to put |
|---|---|
| `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL_SMART`, `LLM_MODEL_FAST`) | your AI provider; nothing AI-related runs without it |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SENDING_USER`, `SEND_MAIL=true` | for sign-up and password-reset emails (a Gmail app password on port 587 works; EC2 blocks port 25) |
| `ADMIN_EMAILS` | your email address, which gives you the Operations page |
| `TAVILY_API_KEY` | optional web search |
| `NEATLOGS_API_KEY` | optional AI tracing |

Run the script again. It builds, starts everything and waits until HTTPS answers:

```bash
bash deploy/ec2/setup.sh
```

## 3. Set up the agent (in the app, once)

1. Open `https://<your-ip-with-dashes>.sslip.io`, sign up and verify your email.
2. **Business:** services and prices, approved claims, **lead search terms and areas** (your niche), and **Daily lead finder**: on, with the reason you may contact the businesses it finds.
3. **Email:** connect your mailbox with **Read replies from this inbox** ticked (Gmail or Outlook app password, with IMAP turned on).
4. **Campaigns:** create one for "qualified" leads and start it. New qualified leads join it automatically.
5. **Policies:** keep Copilot mode (you approve each email) or turn on auto-send. **Operations → flags:** turn on `live_email` (and `auto_send` if you want no approvals).

From then on, every day the agent finds new businesses in your niche, researches them, emails the qualified ones, follows up, reads replies and answers them. It sends to your approval queue whatever needs you.

## Day to day

- **Updates:** `cd easySales && git pull && bash deploy/ec2/setup.sh`
- **Logs:** `sudo docker compose -f deploy/ec2/docker-compose.yml logs -f --tail 100 worker` (or `api`, `caddy`)
- **Backup:** `sudo docker compose -f deploy/ec2/docker-compose.yml exec mongodb mongodump --archive=/backups/easysales-$(date +%F).gz --gzip`. The file lands in `deploy/ec2/backups/`.
- **Restart:** `sudo docker compose -f deploy/ec2/docker-compose.yml restart`

## Things to know

- **Don't stop the instance; leave it running.** Without an Elastic IP, a stop/start gives it a new IP, so the address changes and links already emailed (prototype previews, unsubscribe links) break. If the account allows it, attach an **Elastic IP** first.
- **The data lives on the instance's disk.** Terminating the instance deletes it, so take a backup first if you need the data. When the event is over, **terminate the instance** to stop spending.
- **If HTTPS doesn't come up:** sslip.io is shared by many people, so its Let's Encrypt allowance sometimes runs out. Caddy then falls back to ZeroSSL automatically (this is why `ADMIN_EMAILS` is required). If both fail, get a free subdomain at duckdns.org pointing to the IP and use it as your own domain (below). Check with `logs caddy`.
- **Using your own domain:** point an A record at the IP, set `DOMAIN=app.yourdomain.com` and `PREVIEW_DOMAIN=preview.yourdomain.com` in `deploy/ec2/.env`, update `FRONTEND_URL`, `CORS_ORIGIN`, `PUBLIC_API_URL` and `PREVIEW_BASE_URL` in `server/.env`, and run the script again.
- **What's exposed:** only ports 80 and 443 (Caddy) are reachable. MongoDB and the API are on Docker's internal network, and SSH is limited to your IP.

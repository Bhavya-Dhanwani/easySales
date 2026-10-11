#!/bin/bash
# Paste this into EC2 -> Launch instance -> Advanced details -> User data.
# It installs and starts easySales with HTTPS on first boot; nothing else to click.
# Only edit ADMIN_EMAIL. Never put API keys here: user data is readable by anyone who can
# view the instance. Keys go into /opt/easysales/server/.env afterwards (see docs/EC2.md).
ADMIN_EMAIL="you@example.com"

exec > >(tee -a /var/log/easysales-setup.log | logger -t easysales -s 2>/dev/console) 2>&1
set -euo pipefail
dnf install -y git
git clone https://github.com/Bhavya-Dhanwani/easySales.git /opt/easysales
ADMIN_EMAIL="$ADMIN_EMAIL" NONINTERACTIVE=1 bash /opt/easysales/deploy/ec2/setup.sh

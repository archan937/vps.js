#!/bin/bash
# Secure & Idempotent Ubuntu VPS Provisioning Script (Safe First Run)
# Run as root on Ubuntu 20.04 / 22.04 / 24.04

set -euo pipefail

# ======================
# CONFIG
# ======================
USERNAME="${VPS_USER}"
HOSTNAME="${VPS_HOSTNAME}"
TIMEZONE="${VPS_TIMEZONE}"

# ======================
# FUNCTION: WAIT FOR APT LOCK (with timeout)
# ======================
wait_for_apt() {
  echo "[INFO] Waiting for other apt/dpkg processes to finish..."
  local count=0
  local max=60  # 5 minutes max
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || \
        fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    sleep 5
    count=$((count+1))
    echo "[INFO] Still waiting for apt/dpkg to be free..."
    if [ "$count" -ge "$max" ]; then
      echo "[WARN] Timeout waiting for apt lock. Attempting to remove stale locks..."
      rm -f /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock || true
      dpkg --configure -a || true
      break
    fi
  done
}

# ======================
# LOCALE
# ======================
echo "[INFO] Configuring locale..."
wait_for_apt
apt-get update -y
apt-get install -y locales
locale-gen en_US.UTF-8
update-locale LANG=en_US.UTF-8
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LANGUAGE=en_US.UTF-8

# ======================
# SYSTEM UPDATE
# ======================
echo "[INFO] Updating system..."
wait_for_apt
apt-get update -y
apt-get dist-upgrade -y
apt-get autoremove -y
apt-get clean

# ======================
# HOSTNAME
# ======================
if [ "$(hostname)" != "$HOSTNAME" ]; then
  echo "[INFO] Setting hostname..."
  hostnamectl set-hostname "$HOSTNAME"
  echo "$HOSTNAME" > /etc/hostname
fi

# ======================
# USER SETUP
# ======================
if ! id "$USERNAME" &>/dev/null; then
  echo "[INFO] Creating user $USERNAME..."
  adduser --disabled-password --gecos '' "$USERNAME"
  usermod -aG sudo "$USERNAME"
fi

# ======================
# COPY ROOT SSH KEYS TO USER
# ======================
echo "[INFO] Copying root's authorized_keys to $USERNAME..."
mkdir -p /home/$USERNAME/.ssh
cp -n /root/.ssh/authorized_keys /home/$USERNAME/.ssh/authorized_keys || true
chown -R $USERNAME:$USERNAME /home/$USERNAME/.ssh
chmod 700 /home/$USERNAME/.ssh
chmod 600 /home/$USERNAME/.ssh/authorized_keys

# ======================
# VERIFY SSH KEY SETUP BEFORE HARDENING
# ======================
echo "[INFO] Verifying SSH key setup for $USERNAME..."
if [ ! -f "/home/$USERNAME/.ssh/authorized_keys" ]; then
  echo "[ERROR] SSH authorized_keys file does not exist!"
  echo "[ERROR] Cannot proceed with SSH hardening - you would be locked out."
  echo "[ERROR] Please ensure root's authorized_keys exists and contains your public key."
  exit 1
fi

if [ ! -s "/home/$USERNAME/.ssh/authorized_keys" ]; then
  echo "[ERROR] SSH authorized_keys file is empty!"
  echo "[ERROR] Cannot proceed with SSH hardening - you would be locked out."
  exit 1
fi

echo "[OK] SSH authorized_keys file exists and contains keys"
echo "[INFO] Proceeding with SSH hardening (password auth will be disabled)..."

# ======================
# PASSWORDLESS SUDO
# ======================
echo "[INFO] Setting up passwordless sudo for $USERNAME..."
grep -q "^$USERNAME ALL=(ALL) NOPASSWD:ALL" /etc/sudoers || \
  echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# ======================
# SSH HARDENING (Safe)
# ======================
echo "[INFO] Hardening SSH..."
SSH_CONFIG="/etc/ssh/sshd_config"

# Backup original config
SSH_BACKUP="${SSH_CONFIG}.backup.$(date +%Y%m%d_%H%M%S)"
cp "$SSH_CONFIG" "$SSH_BACKUP"

# Function to set SSH option (handles commented lines and existing settings)
set_ssh_option() {
  local key="$1"
  local value="$2"
  
  # Remove any existing line (commented or not) - handle various formats
  # Match: #PasswordAuthentication, PasswordAuthentication, # PasswordAuthentication, etc.
  sed -i "/^[[:space:]]*#*[[:space:]]*${key}[[:space:]]/Id" "$SSH_CONFIG"
  
  # Also check for case variations (though SSH config is case-insensitive, we want to clean it up)
  sed -i "/^[[:space:]]*#*[[:space:]]*$(echo "$key" | tr '[:upper:]' '[:lower:]')[[:space:]]/Id" "$SSH_CONFIG"
  sed -i "/^[[:space:]]*#*[[:space:]]*$(echo "$key" | tr '[:lower:]' '[:upper:]')[[:space:]]/Id" "$SSH_CONFIG"
  
  # Add the new setting at the end
  echo "${key} ${value}" >> "$SSH_CONFIG"
}

set_ssh_option "PermitRootLogin" "no"
set_ssh_option "PasswordAuthentication" "no"
set_ssh_option "ChallengeResponseAuthentication" "no"
set_ssh_option "UseDNS" "no"
set_ssh_option "AllowUsers" "$USERNAME"

# Check for and remove any conflicting settings in sshd_config.d
if [ -d /etc/ssh/sshd_config.d ]; then
  echo "[INFO] Checking for override files in /etc/ssh/sshd_config.d..."
  for override_file in /etc/ssh/sshd_config.d/*.conf; do
    if [ -f "$override_file" ]; then
      # Remove PasswordAuthentication from override files
      sed -i "/^[[:space:]]*#*[[:space:]]*PasswordAuthentication[[:space:]]/Id" "$override_file" 2>/dev/null || true
      sed -i "/^[[:space:]]*#*[[:space:]]*ChallengeResponseAuthentication[[:space:]]/Id" "$override_file" 2>/dev/null || true
    fi
  done
fi

# Test SSH config before restart to avoid lockout
echo "[INFO] Testing SSH configuration..."
if sshd -t; then
  echo "[INFO] SSH config test passed. Restarting SSH service..."
  # Determine the correct service name
  if systemctl list-units --type=service | grep -q "sshd.service"; then
    systemctl restart sshd
  elif systemctl list-units --type=service | grep -q "ssh.service"; then
    systemctl restart ssh
  else
    # Fallback: try both
    systemctl restart sshd 2>/dev/null || systemctl restart ssh
  fi
  echo "[INFO] SSH service restarted successfully"
  
  # Verify the settings were applied
  echo "[INFO] Verifying SSH configuration..."
  SSHD_TEST=$(sshd -T 2>/dev/null)
  if echo "$SSHD_TEST" | grep -qi "^permitrootlogin no" && \
     echo "$SSHD_TEST" | grep -qi "^passwordauthentication no" && \
     echo "$SSHD_TEST" | grep -qi "^challengeresponseauthentication no"; then
    echo "[OK] SSH hardening verified"
  else
    echo "[WARN] SSH config may not have applied correctly. Please verify manually."
  fi
else
  echo "[ERROR] SSH config test failed. Restoring backup..."
  cp "$SSH_BACKUP" "$SSH_CONFIG" 2>/dev/null || true
  echo "[WARN] SSH config test failed. Skipping restart. Please fix manually."
fi

# ======================
# FIREWALL
# ======================
echo "[INFO] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# ======================
# TIMEZONE & NTP
# ======================
echo "[INFO] Setting timezone..."
timedatectl set-timezone "$TIMEZONE"
wait_for_apt
apt-get install -y ntp

NTP_SERVICE=""
if systemctl list-unit-files | grep -q "^ntpsec.service"; then
  NTP_SERVICE="ntpsec"
elif systemctl list-unit-files | grep -q "^ntp.service"; then
  NTP_SERVICE="ntp"
else
  NTP_SERVICE=$(systemctl list-unit-files | grep -E "^ntp" | head -1 | awk '{print $1}' | sed 's/\.service$//' || echo "")
fi

if [ -n "$NTP_SERVICE" ]; then
  echo "[INFO] Enabling NTP service: $NTP_SERVICE"
  systemctl enable "$NTP_SERVICE" 2>/dev/null || true
  systemctl start "$NTP_SERVICE" 2>/dev/null || true
  if systemctl is-active --quiet "$NTP_SERVICE"; then
    echo "[OK] NTP service ($NTP_SERVICE) is running"
  else
    echo "[WARN] NTP service ($NTP_SERVICE) may not be running"
  fi
else
  echo "[WARN] Could not determine NTP service name. Time sync may not be configured."
fi

# ======================
# ESSENTIAL PACKAGES
# ======================
echo "[INFO] Installing base packages..."
wait_for_apt
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  software-properties-common \
  fail2ban \
  unattended-upgrades \
  whois \
  python3-pyasyncore \
  python3-pyinotify

# ======================
# UNATTENDED UPGRADES
# ======================
echo "[INFO] Enabling unattended upgrades..."
DEBIAN_FRONTEND=noninteractive dpkg-reconfigure -plow unattended-upgrades || true
systemctl enable unattended-upgrades
systemctl start unattended-upgrades || true

# ======================
# DOCKER INSTALL
# ======================
echo "[INFO] Installing Docker..."
DOCKER_KEY="/usr/share/keyrings/docker-archive-keyring.gpg"
DOCKER_LIST="/etc/apt/sources.list.d/docker.list"
if [ ! -f "$DOCKER_KEY" ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o "$DOCKER_KEY"
fi
if [ ! -f "$DOCKER_LIST" ]; then
  echo "deb [arch=$(dpkg --print-architecture) signed-by=$DOCKER_KEY] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > "$DOCKER_LIST"
fi
wait_for_apt
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io
systemctl enable --now docker
if ! id -nG "$USERNAME" | grep -qw docker; then
  usermod -aG docker "$USERNAME"
fi

# ======================
# DOCKER HARDENING
# ======================
echo "[INFO] Hardening Docker..."
mkdir -p /etc/docker
DOCKER_DAEMON="/etc/docker/daemon.json"
if [ ! -f "$DOCKER_DAEMON" ]; then
cat > "$DOCKER_DAEMON" <<EOF
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "userns-remap": "default"
}
EOF
  systemctl restart docker
fi

# ======================
# DOCKER COMPOSE
# ======================
echo "[INFO] Installing Docker Compose..."
COMPOSE_BIN="/usr/local/bin/docker-compose"
COMPOSE_VERSION="$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep tag_name | cut -d '"' -f4 | sed 's/^v//')"
INSTALLED_VERSION=$($COMPOSE_BIN --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
if [ ! -f "$COMPOSE_BIN" ] || [ "$INSTALLED_VERSION" != "$COMPOSE_VERSION" ]; then
  curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o "$COMPOSE_BIN"
  chmod +x "$COMPOSE_BIN"
fi

# ======================
# LAZYDOCKER
# ======================
echo "[INFO] Installing LazyDocker..."
LAZYDOCKER_BIN="/usr/local/bin/lazydocker"
TMP_DIR=$(mktemp -d)
LAZYDOCKER_URL=$(curl -s https://api.github.com/repos/jesseduffield/lazydocker/releases/latest \
  | grep browser_download_url \
  | grep "$(uname -s)_$(uname -m).tar.gz" \
  | cut -d '"' -f4)
if [ -n "$LAZYDOCKER_URL" ]; then
  curl -L "$LAZYDOCKER_URL" -o "$TMP_DIR/lazydocker.tar.gz"
  tar -xzf "$TMP_DIR/lazydocker.tar.gz" -C "$TMP_DIR"
  mv "$TMP_DIR/lazydocker" "$LAZYDOCKER_BIN"
  chmod +x "$LAZYDOCKER_BIN"
  rm -rf "$TMP_DIR"
  echo "[INFO] LazyDocker installed successfully."
else
  echo "[WARN] Could not determine LazyDocker download URL for $(uname -s)_$(uname -m)."
fi

# ======================
# FAIL2BAN
# ======================
echo "[INFO] Configuring Fail2Ban..."
FAIL2BAN_LOCAL="/etc/fail2ban/jail.local"
if [ ! -f "$FAIL2BAN_LOCAL" ]; then
cat > "$FAIL2BAN_LOCAL" <<EOF
[sshd]
enabled = true
port = ssh
maxretry = 5
bantime = 1h
EOF
  systemctl enable --now fail2ban
fi

# ======================
# FINISH
# ======================
echo "[DONE] Provisioning complete."
echo "[INFO] Ensuring all services are properly configured..."

if systemctl is-enabled sshd >/dev/null 2>&1 || systemctl is-enabled ssh >/dev/null 2>&1; then
  echo "[OK] SSH service is enabled for boot"
else
  echo "[WARN] SSH service may not be enabled. Enabling now..."
  systemctl enable sshd 2>/dev/null || systemctl enable ssh 2>/dev/null || true
fi

if ufw status | grep -q "Status: active"; then
  echo "[OK] Firewall is active"
else
  echo "[WARN] Firewall may not be active. Enabling now..."
  ufw --force enable || true
fi

echo "[INFO] Waiting 5 seconds before reboot to ensure all changes are saved..."
sleep 5
echo "[INFO] Rebooting VPS to load the latest kernel ..."
echo "[INFO] After the reboot (may take 1-2 minutes), you can SSH in as '$USERNAME' using your SSH key."
reboot

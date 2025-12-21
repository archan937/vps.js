# Ubuntu VPS Provisioning Script

This script securely provisions an Ubuntu VPS with a non-root user, Docker tooling, and sensible security hardening.  
It is designed to be **idempotent**, **minimal**, and **safe to re-run**.

## Features

- Creates a non-root user with sudo access
- Hardens SSH:
  - Disables root login
  - Disables password authentication
  - Enforces key-based login
- Configures UFW firewall (OpenSSH allowed, all other inbound traffic denied)
- Installs Docker, Docker Compose (latest), and LazyDocker
- Sets system timezone and enables NTP
- Enables Fail2Ban and unattended security upgrades
- Hardens Docker daemon (user namespace remap, log rotation)
- Safe to run multiple times without breaking the system

## Usage

### Quick Start (Recommended)

Configure `bin/.env` accordingly and from your local machine, run the following command to copy your SSH key, execute the script, and provision the server in one step:

```bash
ssh-copy-id -i ~/.ssh/id_rsa.pub root@SERVER && ssh root@SERVER 'bash -s' < <(sed "s/\r$//" bin/provision)
```

After provisioning completes, log in as the new user:

```bash
ssh user@SERVER
```

## Run a security audit against the provisioned VPS

Run the following command:

```bash
bin/audit
```

## Notes

- Root SSH login is disabled after provisioning.
- SSH key installation is handled externally (see Quick Start).
- Suited for Ubuntu 20.04 and 22.04 LTS

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

Install Bun dependencies:

```bash
bun install
```

Configure `bin/.env` accordingly and from your local machine, run the following command to copy your SSH key, execute the script, and provision the server in one step:

```bash
bin/provision
```

After provisioning completes, log in as the new user:

```bash
ssh SERVER
```

## Run a security audit against the provisioned VPS

Run the following command:

```bash
bin/audit
```

## Manage docker-compose projects on the VPS

The `bin/compose` command helps you manage docker-compose projects on your provisioned VPS:

### Initialize a new project

```bash
bin/compose init <project-name>
```

### Add services to a project

Supported service types: `bun`, `mysql`

```bash
bin/compose add <project> <type> <alias>
```

Examples:

```bash
bin/compose add myapp bun app
bin/compose add myapp mysql db
```

### Manage project lifecycle

Start, stop, restart, or execute commands in a docker-compose project:

```bash
bin/compose up <project>
bin/compose down <project>
bin/compose restart <project>
bin/compose exec <project> <alias> <command>
```

Example:

```bash
bin/compose exec myapp app bun install
```

## Manage Git repositories in compose projects

The `bin/git` command helps you manage Git repositories within your docker-compose projects:

### Clone a Git repository

Clone a repository into a project's app directory:

```bash
bin/git clone <project> <alias> <url>
```

Example:

```bash
bin/git clone myapp app https://github.com/user/repo.git
```

### Pull latest changes

```bash
bin/git pull <project> <alias>
```

### List branches

```bash
bin/git branch <project> <alias>
```

### Checkout a branch or commit

```bash
bin/git checkout <project> <alias> <ref>
```

Example:

```bash
bin/git checkout myapp app main
```

**Note:** All commands require `VPS_HOST` and `VPS_USER` environment variables (or configuration in `bin/.env`).

## Notes

- Root SSH login is disabled after provisioning.
- Suited for Ubuntu 20.04 and 22.04 LTS

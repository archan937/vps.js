# Commands to setup VPS for PME Discord

## Preparation

Configure `bin/.env` accordingly.

## Installation

Run the following commands:

```bash
ssh-copy-id -i ~/.ssh/id_rsa.pub root@phantom && ssh root@phantom 'bash -s' < bin/provision
ssh phantom     # Just for SSH login testing (disconnect after success)
bin/audit
bin/compose init pme
bin/compose add pme mysql db
bin/compose add pme bun app
```

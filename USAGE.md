# Commands to setup VPS for PME Discord

## Preparation

Configure `bin/.env` accordingly.

## Installation

Run the following commands:

```bash
bin/provision
ssh phantom # Wait 1-2 minutes before testing SSH login (disconnect after success)
bin/audit
bin/compose init pme
bin/compose add pme mysql db
bin/compose add pme bun app
```

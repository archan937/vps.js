# Commands to setup VPS for PME Discord

## Preparation

Configure `bin/.env` accordingly.

## Installation

Run the following commands:

```bash
bin/provision
# Wait 1-2 minutes before proceeding as the VPS reboots
bin/audit
bin/compose init pme
bin/compose add pme mysql db
bin/compose add pme bun bot
bin/compose clone pme bot git@github.com:archan937/sim-racer.git
bin/compose up pme
```

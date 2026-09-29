---
description: Spin up the self-host stack locally and wait for it to become healthy
---

Smoke-test the customer self-host path from the repo root (`Bee-Flow-AI/` in the Windows wrapper
layout; in a cloud session the repo is already the working directory):

1. Run `./selfhost.sh` (pulls public `ghcr.io/bee-flow/*` images via
   `docker-compose.from-registry.yml --profile core`, auto-generates secrets into a
   local `.env`, and waits for `/api/health`).
2. Poll `./selfhost.sh --status` and report container health + the printed URL.
3. If something fails, show `./selfhost.sh --logs` for the failing service.
4. When the user is done, remind them they can tear it down with `./selfhost.sh --down`.

Never read or print the generated `.env` (the secret-guard hook will block it anyway).

Extra args from the user: $ARGUMENTS

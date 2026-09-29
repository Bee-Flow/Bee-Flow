---
description: Build (and optionally push) the dev Docker images to GHCR
---

Build the Bee Flow dev images. Steps:

1. Work from the repo root (`Bee-Flow-AI/` in the Windows wrapper layout; in a cloud session the
   repo is already the working directory).
2. Run `npm run build:dev` (wraps `scripts/build-images.sh build dev`, tags `:dev`).
3. If the user asked to also push, run `npm run push:dev` afterwards.
4. Report which services were rebuilt and any build failures. Do NOT touch prod tags
   (`build:prd` / `push:prd`) unless the user explicitly says so — those are behind a
   confirmation on purpose.

Extra args from the user: $ARGUMENTS

---
description: Build the dev Docker images on GitHub Actions (never locally) and report the run
---

Build Bee Flow dev images with the `Build & Push to GHCR` workflow
(`.github/workflows/build-push-ghcr.yml`). Images are never built on this machine: no
`npm run build:dev`, `scripts/build-images.sh` or `docker build`.

1. Pick the ref: the branch the user names, else the branch of the work at hand. A push to `main`
   already builds `:dev` for every changed service, so on `main` say so and stop unless the user
   still wants a manual run.
2. Make sure that ref is on GitHub (`git ls-remote origin <ref>`). If it is not, ask before
   pushing: a push is the user's call.
3. Start the run:
   `gh workflow run build-push-ghcr.yml --ref <ref> -f channel=dev -f services=<list>`
   `services` is `all` or a comma-separated list of `server,agent-hub,guard,classify,pwt-runner`
   (the workflow default is `server,agent-hub`). Build only what the change touches.
4. Find the run (`gh run list --workflow build-push-ghcr.yml --branch <ref> --limit 1`) and follow
   it in the background (`gh run watch <id> --exit-status`). Report the run URL, then the result
   per service and the `:dev-sha-<sha>` tags it pushed.
5. Never use `channel=prod` here: a prod build is a release step and needs the user's explicit
   ask.

Extra args from the user: $ARGUMENTS

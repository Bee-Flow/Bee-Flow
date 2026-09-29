---
description: How to run BeeFlow locally for development with instant hot-reloading
---
# Running Local Dev Environment
// turbo-all
1. Start the Docker development environment using the dev compose file:
   `docker compose -f docker-compose.dev.yml up --build`
2. Wait for the containers to build. Because of the `--mount=type=cache` BuildKit mounts, subsequent builds will take seconds rather than minutes.
3. Once started, both the frontend and backend will be available with instant hot-reloading (via bind mounts into the workspace directories).
4. The frontend is accessible at `http://localhost:5176`.
5. The backend API is at `http://localhost:3001`.
6. Note: Any changes to `server/package.json` or `agent-hub/package.json` require a quick container rebuild because node_modules are isolated inside the container.

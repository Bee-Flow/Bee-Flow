# ──────────────────────────────────────────────────────────────
# BeeFlow Install Wizard — Docker Image
# Lightweight Node.js + Docker CLI for orchestrating deployment
# ──────────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85

# Install Docker CLI (needed to run docker compose on the host socket)
RUN apk add --no-cache docker-cli docker-cli-compose curl

WORKDIR /wizard

# Install npm dependencies
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund

# Copy wizard source
COPY . .

EXPOSE 9090

CMD ["node", "server.js"]

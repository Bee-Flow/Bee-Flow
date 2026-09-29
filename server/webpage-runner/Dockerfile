# Bee Flow webpage FULL-tier runtime image.
#
# GATED + SECURITY-REVIEW-REQUIRED — see README.md. Runs ONE per-project Vite dev
# server (+ optional Node backend) on an isolated docker network with capped
# resources. Never started unless WEBPAGE_FULL_RUNTIME_ENABLED=1 and the runtime
# manager (server/services/webpageRuntimeManager.js) is wired in by ops.
#
# Mirrors the existing throwaway-container images (server/pwt-runner,
# server/terminal-runner) so operators reason about one container story.

FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

# The runner itself ships Vite + the React plugin so projects don't have to.
# Project dependencies are npm-installed into the bind-mounted /project at runtime.
WORKDIR /runner
COPY package.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force
COPY vite.config.js entrypoint.js ./

# Non-root execution. no-new-privileges + cap-drop ALL are applied by the runtime
# manager at create time (HostConfig); the image just provides a non-root user.
RUN useradd -m -u 10001 runner \
    && mkdir -p /project \
    && chown -R runner:runner /project /runner
USER runner

WORKDIR /project
ENV PORT=5173 HOST=0.0.0.0 NODE_ENV=development
EXPOSE 5173

CMD ["node", "/runner/entrypoint.js"]

# syntax=docker/dockerfile:1.7
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV APP_HOST=0.0.0.0
ENV APP_PORT=23000
EXPOSE 23000

CMD ["node", "src/server.js"]

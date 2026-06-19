# Image for the Manila signing sidecar (sidecar/server.mjs), run as a Cloudflare
# Container. Pinned to linux/amd64 so the Dynamic MPC native binary
# (libmpc_executor_linux_x86_64) matches the container runtime.
FROM --platform=linux/amd64 node:22-slim

# Debian slim ships without CA certs; the sidecar makes HTTPS calls to Dynamic
# (auth, MPC co-signing), which need them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps only. npm ci resolves @dynamic-labs-wallet/node-evm's
# linux/amd64 native binary here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The sidecar is self-contained (imports only the Dynamic SDK + node builtins).
COPY sidecar ./sidecar

# Pinned to the container's defaultPort (see signer-container.ts); also passed
# via envVars at start, this is the in-image default.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "sidecar/server.mjs"]

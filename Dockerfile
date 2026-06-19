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

# Install ONLY the sidecar's single dependency (the Dynamic MPC SDK), via its own
# minimal manifest — not the whole Worker dependency tree. This keeps the
# emulated amd64 build small and fast.
COPY sidecar/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# The sidecar is self-contained (imports only the Dynamic SDK + node builtins).
COPY sidecar/server.mjs ./server.mjs

# Pinned to the container's defaultPort (see signer-container.ts); also passed
# via envVars at start, this is the in-image default.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]

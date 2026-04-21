FROM node:22.22-slim

ARG VERSION=dev
LABEL org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.source="https://github.com/getshrok/shrok" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY package*.json ./
COPY dashboard/package.json dashboard/
# Installs all deps including devDependencies (tsx, typescript, vitest).
# Shrok runs via tsx (no compiled dist/), so devDeps are required at runtime.
# A future multi-stage build could compile to dist/ and prune devDeps.
# Dashboard package.json must be present for workspace deps to resolve.
RUN npm ci

COPY . .

# Build dashboard (deps already installed by npm ci via workspaces)
RUN npm run --workspace=dashboard build

RUN useradd -m -s /bin/bash shrok && \
    mkdir -p workspace/data workspace/skills workspace/identity && \
    chown -R shrok:shrok workspace

USER shrok

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8888/api/theme').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]

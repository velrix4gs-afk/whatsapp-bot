FROM node:22-slim

# Install git (needed for baileys git dependency)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install pnpm and tsx
RUN npm install -g pnpm tsx

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Allow exotic subdependencies and approve build scripts
RUN pnpm config set block-exotic-subdeps false
RUN pnpm config set approve-builds true

# Install dependencies
RUN pnpm install --no-frozen-lockfile

# Copy source code
COPY . .

WORKDIR /app/artifacts/api-server

EXPOSE 8080

CMD ["pnpm", "exec", "tsx", "src/index.ts"]
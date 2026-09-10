FROM node:22-slim

# Install git (needed for baileys git dependency)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install system dependencies (git is required by pnpm for github dependencies), pnpm, and tsx
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm tsx

# Configure git inside the container to force HTTPS instead of SSH
RUN git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Allow exotic subdependencies (git repos in subdeps)
RUN pnpm config set block-exotic-subdeps false

# Install dependencies – skip build scripts to avoid warnings
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Copy source code
COPY . .

<<<<<<< HEAD
=======
# Install all dependencies (all workspaces)
RUN pnpm install --no-frozen-lockfile

# Set working directory to api-server
>>>>>>> 202acdb632378146f876ef7d9d0c2402cb669b2c
WORKDIR /app/artifacts/api-server

EXPOSE 8080

CMD ["pnpm", "exec", "tsx", "src/index.ts"]
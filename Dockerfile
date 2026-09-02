FROM node:20-slim

WORKDIR /app

# Install system dependencies (git is required by pnpm for github dependencies), pnpm, and tsx
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm tsx

# Configure git inside the container to force HTTPS instead of SSH
RUN git config --global url."https://github.com/".insteadOf "git@github.com:"

# Copy all source code
COPY . .

# Bypass pnpm supply-chain checks for exotic subdependencies (required for baileys/libsignal)
ENV pnpm_config_blockExoticSubdeps=false
ENV pnpm_config_minimumReleaseAge=0

# Install all dependencies (all workspaces)
RUN pnpm install --no-frozen-lockfile

# Set working directory to api-server
WORKDIR /app/artifacts/api-server

# Expose port
EXPOSE 8080

# Run with tsx (no build needed)
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

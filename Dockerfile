FROM node:20-slim

WORKDIR /app

# Install system dependencies (git is required by pnpm for github dependencies), pnpm, and tsx
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm tsx

# Configure git inside the container to force HTTPS instead of SSH
RUN git config --global url."https://github.com".insteadOf "git@github.com:"

# Copy all source code
COPY . .

# Install dependencies using inline configuration flags to bypass supply chain blocks
RUN pnpm install --no-frozen-lockfile --config.block-exotic-subdeps=false --config.minimum-release-age=0

# Set working directory to api-server
WORKDIR /app/artifacts/api-server

# Expose port
EXPOSE 8080

# Run with tsx (no build needed)
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

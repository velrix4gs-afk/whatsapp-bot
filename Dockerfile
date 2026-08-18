FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the API server
RUN pnpm --filter @workspace/api-server run build

# Set working directory to api-server
WORKDIR /app/artifacts/api-server

# Expose port
EXPOSE 8080

# Start the bot
CMD ["pnpm", "run", "start"]
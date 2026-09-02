FROM node:20-slim

WORKDIR /app

# Install pnpm and tsx
RUN npm install -g pnpm tsx

# Copy all source code
COPY . .

# Install all dependencies (all workspaces)
RUN pnpm install --no-frozen-lockfile


# Set working directory to api-server
WORKDIR /app/artifacts/api-server

# Expose port
EXPOSE 8080

# Run with tsx (no build needed)
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

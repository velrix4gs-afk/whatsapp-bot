# Force rebuild 2026-08-18
FROM node:20-slim

WORKDIR /app

# Install pnpm and tsx
RUN npm install -g pnpm tsx

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Set working directory to api-server
WORKDIR /app/artifacts/api-server

# Expose port
EXPOSE 8080

# Run with tsx (no build needed)
<<<<<<< HEAD
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
=======
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
>>>>>>> 11d504bba3aeb7ada7cefaf7ebcd33e2b0ce33f5

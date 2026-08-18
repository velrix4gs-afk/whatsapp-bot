# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## WhatsApp Bot

- **Script**: `scripts/src/whatsapp-bot.ts`
- **Run via workflow**: "WhatsApp Bot" (console output type, `autoStart: false`)
- **Or directly**: `pnpm --filter @workspace/scripts run whatsapp-bot`
- **Auth state**: persisted at `auth_state/` (gitignored)
- **Saved media**: stored at `saved_media/`
- **Dependencies**: `@whiskeysockets/baileys`, `qrcode-terminal`, `@hapi/boom`, `@types/qrcode-terminal`

### Features
1. QR code login via terminal (multi-device)
2. Auto-likes all incoming status updates (`👍` reaction)
3. `#saveprofile <phone_number>` — fetches and sends back a contact's profile picture
4. View-once media capture — saves and resends the file to the sender

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

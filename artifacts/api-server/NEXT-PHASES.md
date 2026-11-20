# NovaBot — Build Status

Handoff doc. `artifacts/api-server` is the only service that matters at runtime (Docker runs `tsx src/index.ts`).

## DONE

### Foundation
- Worker spawn dedupe (no storm), QR + pairing code flow, live status (`starting → connecting → qr → connected`).
- Admin panel: token auth, Sessions / AI / Auto-respond / Settings / Files tabs. All old feature toggles present.
- AI providers + reply rules persisted via `/api/settings`; worker replies per `replyMode`.
- View-once auto-save → Supabase `saved_media` → forwarded to the owner's own WhatsApp DM (personal chats only).
- Telegram bot: watchdog restart, /menu + options, link/register/files/AI.

### Phase 1 — menu + per-chat controls + anti-call
- `src/lib/chat-settings.ts` — per-chat toggles `{ vv, anticall, autoreply }` in `data/chat-settings.json`.
  Defaults: personal `vv: true`; groups `vv: false` (forced personal-only design).
- Menu rebuilt (`buildMenu()` in `worker.ts`) with live per-chat state.
- Commands accept `.` `/` `!` prefixes: `/vv on|off`, `/anticall on|off`, `/autoreply on|off` (owner only),
  `/ai <q>`, `/ai/<name> <q>`, `/menu`, `/ping`, `/files`, `/admin`, `/vv`, `/save`, `/savepp`, `/sticker`,
  `/autotyping on|off`, `/presence on|off` (last two owner-only).
- Anti-call: Baileys `call` event → `socket.rejectCall()` when the chat has `anticall` on.
- View-once auto-save gated to personal chats only (never groups, never own messages).

### Phase 4 — personas + per-contact auto-respond
- `src/lib/settings.ts`: `AiPersona { id, name, instructions, providerId? }`, `personas[]` in settings,
  helpers `getPersona()` / `getPersonaProvider()`.
- Admin UI (AI tab): Personas panel + modal (name, instructions, provider). Use in chat as `/ai/<name> <question>`;
  unknown names fall back to the default provider. Personas post-processed through `handleAiQuestion()`.
- `src/lib/auto-respond.ts`: CRUD + `matchAutoRule()` over `data/auto-respond.json`.
  Rule shape: `{ id, contact (digits), triggers[], reply, instructions?, enabled, createdAt }`.
- API (Bearer auth): `GET/POST /api/auto-respond`, `DELETE /api/auto-respond/:id`.
- Admin UI: new **Auto-respond** tab with rule list + modal. Personal chats only, respects the chat `autoreply`
  toggle and `aiChat` feature. `reply` supports `{name}`; when `instructions` is set the AI writes the reply.
- Worker order per message: commands → auto-respond rule → generic AI reply.

## Verified
- `npx tsc -p tsconfig.json --noEmit` clean.
- Live smoke test: server boots, register/login works without DB, worker reaches `qr`, pairing code endpoint works,
  repeat link clicks reuse one worker.
- Persona + auto-respond endpoints round-trip; `matchAutoRule` unit-tested (contact, enabled, trigger matching).
- Per-chat store unit-tested (personal `vv:true`, group `vv:false`, toggle persistence).

## Ideas / not scheduled
- Website read-only view of per-chat toggles.
- Persona/auto-respond management inside the Telegram bot.
- Supabase-backed storage for `chat-settings.json` / `auto-respond.json` (currently file-based under `data/`).

## Real-world testing (needs a linked phone)
1. Link a number via QR/pairing from the admin panel.
2. In a personal chat: `/menu`, `/anticall on`, call yourself from another phone → call is rejected.
3. Send a view-once from another phone → saved to Supabase + forwarded to your DM. Same in a group → ignored.
4. Add a persona → `/ai/nora what does UTC mean`.
5. Add an auto-respond rule for a contact with trigger "hi" → have them send "hi".

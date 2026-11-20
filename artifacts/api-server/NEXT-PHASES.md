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
  `/ai <q>`, `/ai/<name> <q>`, `<persona name> <q>` (persona joins the chat until you say "enough"),
  `/menu`, `/ping`, `/files`, `/vv`, `/save`, `/savepp`, `/sticker`,
  `/autotyping on|off`, `/presence on|off` (last two owner-only). The `/admin` command and its menu entry were
  removed so the admin link is never visible to other users.
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

### Phase 5 — persona conversations + custom commands + thumbnails
- `src/lib/ai-sessions.ts`: per-chat persona sessions in `data/ai-sessions.json` (`persona`, `history`, `startedAt`),
  helpers `startSession` / `getActiveSession` / `appendToSession` / `endSession` / `isStopMessage`.
- Typing a persona's name in chat starts a conversation: the AI receives the real history
  (`callAiProvider` gained a `history` parameter for OpenAI / Anthropic / Gemini / custom providers) and keeps
  replying until the user says `enough` / `stop` / `bye` / `that's all`.
- Custom commands: `data/custom-commands.json` with `{ prefix, response, description? }`, `{time}` / `{name}`
  placeholders. Admin UI under Settings → Custom commands (list, add, edit, delete) via
  `GET/POST /api/settings/custom-commands`.
- `my-files` thumbnails: `src/routes/user-files.ts` returns `type` (`image`/`video`/`audio`/`file`) derived from the
  Supabase MIME type or the filename extension; the page renders image/video previews, an audio player and a
  fallback icon.
- Gemini model names are normalized before the call (`models/` prefix, spaces, casing → e.g. `gemini-2.5-flash`),
  fixing `400 unexpected model name format`.
- `adminNumber` defaults to `2348103077073`.

## Verified
- `npx tsc -p tsconfig.json --noEmit` clean.
- Live smoke test: server boots, register/login works without DB, worker reaches `qr`, pairing code endpoint works,
  repeat link clicks reuse one worker.
- Persona + auto-respond endpoints round-trip; `matchAutoRule` unit-tested (contact, enabled, trigger matching).
- Per-chat store unit-tested (personal `vv:true`, group `vv:false`, toggle persistence).
- AI session store unit-tested (history append, stop-word detection, session end).

### UI redesign (latest)
- `public/styles.css` — single shared design system (tokens, buttons, panels, forms, switches, lists, modals,
  toasts, file grid, admin shell, responsive breakpoints). Served via `express.static` on `public/`.
- Admin panel is now a **sidebar layout**: sticky sidebar (Sessions / AI & Personas / Auto-respond / Settings / Files),
  topbar with page title + context, footer with live connection dot and cross-page links. Sidebar collapses to a
  stacked bar under 960px.
- All public pages share the same header/nav/footer: Link (`/`), My Chats (`/user`), My Files (`/my-files`),
  Login (`/login`), Admin (`/admin`).
- Settings features are grouped into **Media & downloads / Engagement / Safety & AI**.
- `my-files` now renders real thumbnails (the API returns a `type` field derived from MIME or extension).

### Phase 6 — provider pool, human chat, memory (latest)
- Providers: AI21 Labs, Cohere, DashScope, ModelScope, NVIDIA NIM, Ollama (local/tunnel), OpenRouter, Gemini, Groq,
  Mistral, plus Custom (OpenAI-compatible). Presets auto-fill base URL + model in the admin modal; only `ollama`/`custom`
  allow a blank API key. All but Gemini/Anthropic use the OpenAI chat-completions dialect.
- `callAiWithPool()` — sticky failover: preferred → last working → default → rest. Any provider error/quota/timeout
  rotates silently to the next; the working provider is remembered for the next message.
- Replies are always short: system prompt rule, `max_tokens` 220 and `trimReply()` clamp to ~450 chars.
  Personas join only when called by name and chat casually (jokes, flow); "enough"/"stop" makes them leave.
  In groups the AI only answers when mentioned or invited with "ai …".
- Status auto-like now also marks the status as viewed (read receipt + presence to `status@broadcast`).
- Everyone can use the AI by default (`replyMode: "all"`); "Admin only" is still available in Settings.
- Contact memory: `src/lib/memory.ts` — per linked bot (`session_id`) and per contact. Stored in Postgres
  `bot_contact_memory` (auto-created) with a file fallback at `data/sessions/<session>/memory.json`.
  Inbound personal-chat messages feed a rolling transcript; every 6 messages the pool summarises it into facts
  (max 15) that are injected into the AI prompt. Admin → AI → Contact memory lets the owner view/edit/clear notes.
  Each bot user only sees their own session's memory; provider keys and bot-wide settings are owner-only.
- `publicUrl` setting: used for "give me the link" answers, `/files` and media captions. Injected into the AI prompt
  together with the admin number and the owner's last activity. Activity is tracked from both incoming and outgoing
  (fromMe) messages, so "is Velrix online?" answers "looks online right now" when the account was active in the last 5 min.
- `/commands` (or `/cc`) lists the bot's custom commands in chat; the admin panel explains how to create one.

#### Local FreeLLM on your laptop
Render can't reach `localhost`. Run freellmapi on the PC, expose it with a tunnel (`cloudflared tunnel --url
http://localhost:PORT` or `ngrok http PORT`), then add a **Custom (OpenAI-compatible)** provider with the tunnel URL +
`/v1` and the model name your app serves. No API key needed if your app has none. Same pattern works for Ollama.

### Phase 7 — reliable linking, multi-session, file delete (latest)
- A failed/expired pairing no longer deletes the session card: the worker wipes half-written
  credentials, reports the reason (`pairing_error` → shown in the UI) and reconnects into a fresh
  QR instead of silently dying.
- `POST /api/sessions` always starts a fresh pairing attempt unless the session is connected, so
  pressing "Get pairing code" again always produces a new code. New `POST /api/sessions/:id/reset`
  (admin → "New code" button) kills the worker and removes saved credentials for a true clean slate.
- Session list persisted to `data/sessions/index.json`; linked numbers are auto-resumed on startup,
  so multiple users can each link their own number and keep it across restarts (needs a persistent
  disk on Render — without one, `data/` is wiped on every deploy).
- Delete session now removes the whole `data/sessions/<id>/` folder (auth, media, memory).
- My Files page: Delete button + `POST /api/user/files/delete` (phone/PIN auth, path-traversal guarded).

## Ideas / not scheduled
- Website read-only view of per-chat toggles.
- Persona/auto-respond management inside the Telegram bot.
- Supabase-backed storage for `chat-settings.json` / `auto-respond.json` (currently file-based under `data/`).

## Real-world testing (needs a linked phone)
1. Link a number via QR/pairing from the admin panel.
2. In a personal chat: `/menu`, `/anticall on`, call yourself from another phone → call is rejected.
3. Send a view-once from another phone → saved to Supabase + forwarded to your DM. Same in a group → ignored.
4. Add a persona named `nora` → send `nora what does UTC mean` → she answers and stays in the chat;
   send `enough` → she leaves.
5. Add an auto-respond rule for a contact with trigger "hi" → have them send "hi".
6. Add a custom command `.price` in the admin panel → send `.price` in a chat → reply comes back.


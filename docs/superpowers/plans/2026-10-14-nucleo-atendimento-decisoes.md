# Decisões tomadas durante a execução do plano

Registro das decisões ("rulings") do controlador na execução subagent-driven do plano `2026-10-14-nucleo-atendimento.md`, na ordem em que foram tomadas. Cada uma diz o que foi decidido, por quê e o custo se estiver errada.

Revisão final: 18 problemas confirmados e corrigidos (12f2090..867337f); servidor 490 testes, web 117, typecheck e build limpos.

- Ruling: A11 — T11 sendSystemText gets the same echo guard as T10 deliver (delete echo row with same channel/external_id & author null, then set external_id/status) and keeps triage_pending=true after the menu; T10 extracts the shared block into `markSent(db, messageId, channelId, externalId)` in messages/send.ts and rewires triage to call it — spec §5.1 idempotency — cost if wrong: one refactor in T10.
- Ruling: A18 — delete T21 Steps 8a-8e (SPA static/notFound already owned by T14) — duplicate Fastify registration would throw — cost: none.
- Ruling: A19 — T18 uses routes `contacts`, `contacts/new`, navigation `/chats/:id` (T15 sidebar is source of truth) — cost: none.
- Ruling: A2/B8 — delete T8 Step 11 and helpers line (T7 Step 0 already wires hub) — cost: none.
- Ruling: A6 — T8 /ws reads request.user populated by T6 plugin (T6 must populate request.user for every request incl. /ws, 401 only enforced for /api); T8 keeps its Origin check (upgrade is GET, T6 global check covers non-GET only) and drops its own session lookup — cost: if T6 hook skips /ws, T8 test fails and fix loop catches it.
- Ruling: A22 — single `formatPhone` in web/src/lib/format.ts (T15); T16 contactLabel and T18 import it; delete T18 phone.ts formatter — cost: none.
- Ruling: A23 — `TAG_COLORS` (T19's 20 hex values) lives in shared/src/palette.ts created by T15 and exported from shared index; T18/T19/T20 import it — cost: none.
- Ruling: A25 — connection events carry `phone` (from wuid/owner JID) and T9/T14 setChannelStatus stores channels.phone; QR: ingest stores the latest qrcode.updated base64 in an in-memory Map in channels/service (`setChannelQr`/`getChannelQr`), new route GET /api/channels/:id/qr (admin) returns {qrBase64|null}; T19 polls it every 5 s while the channel is not connected (connect response still shows the first QR) — spec §5.6 "QR exibido a partir de qrcode.updated" — cost: one extra route.
- Ruling: C4 — T1 error handler logs only { name, code, stack, correlationId } for 500s — Global Constraint "never log message bodies" — cost: less detail in logs.
- Ruling: C9 — T16/T18/T19 use T15 dark theme tokens only (no bg-white/gray-50/zinc/slate literals) — spec mirrors Umbler dark UI — cost: restyle.
- Ruling: C8 — tests named "concurrent" are renamed "duplicate first messages (sequential)" with a comment that PGlite serializes; real race safety relies on ON CONFLICT — cost: none.
- Ruling: C7 — every module imports `Tx` from db/client (no redeclaration) — cost: none.
- Ruling: C1 — commit trailer stays "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" (current session attribution) — cost: none.
- Ruling: C2/C3 — spec updated: Node 24, integration tests on PGlite (in-process Postgres) — plan reflects reality — cost: none.
- Ruling: C5 — dummyHash computed inside the auth plugin closure — Global Constraint no singletons — cost: none.
- Ruling: A8 — T8 dto.ts computes mediaUnavailable = mediaPath == null && kind in (image,audio,video,document,sticker); T9 sets error 'mídia indisponível' — cost: none.
- Ruling: A15 — T10 assigned event data = {ownerId, previousOwnerId} like T7 — cost: none.
- Ruling: A16 — single `messagePreview(kind, body)` in messages/dto.ts (T8) used by ingest/send/triage — cost: none.
- Ruling: A1/A4/A12/A21/A24/A26/B6/B7 — doc/comment fixes: ctx comments say T7 adds hub; T6 visibility.ts note says T7 overwrites; T14 imports note fixed; README "Canais"; no dependency reinstalls in later tasks and keep package name @talk/web; README runs import with --dry-run first and `docker compose exec -T` without tee; T7 event order sorts by (createdAt, id) — cost: none.
- Ruling: T3 commit a121a4c keeps trailer "Claude Haiku 5.5" — it is the accurate author model; history not rewritten — cost: none.
- Ruling: T7 sector-only transfer keeps owner — Task 17 transfer dialog sends ownerId: null whenever a sector is chosen without an agent (chat lands unowned in the sector queue, Umbler behavior) — carried into T17 dispatch — cost: UI tweak if office prefers keeping owner.
- Ruling: test timeout — at the default 5 s, 4 first-tests time out under full-suite load (PGlite + argon2); first dispatch of the next session adds `testTimeout: 30_000` to server/vitest.config.ts (one-line infra fix, reviewed) — cost: slower failure feedback.
- Ruling: T14 trustProxy uses 'loopback,linklocal,uniquelocal' (Fastify 5.12.7 rejects/mishandles 1) — Task 21 must NOT publish app port 3000 on the host so only Caddy reaches the app — carry into T21 dispatch — cost: X-Forwarded-For spoofable if port published.
- Ruling: manual dev-server smoke checks (T15 step 23, T16 26, T17 19, T19 24) not run — no Evolution/WhatsApp here; they are covered by the README go-live checklist the office runs before virada — cost: UI glitches found at go-live instead of now.
- Ruling: contacts list/card readable by every agent — not a spec violation (§6 gates chats/messages/media/history only; matches Umbler office-wide contacts) — cost: if office wants per-sector contacts, add filter later.
- Ruling: final minor — backup.sh creates data/backup as root if operator skipped README step 5; documented flow is fine, left as is — cost: restore needs sudo in that edge case.

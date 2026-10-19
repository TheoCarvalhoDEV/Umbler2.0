# Final-review fix report

Base: 2391436493ea350c3ca25d7b0a0a633d2744c5e9

Changes
1. jobs.ts: import pass copies [periodStart, now - 30 min]; BACKFILL_LAG_MS now shared (defined above runImportPass).
2. media.ts: downloadMessageMedia selects channels.status and returns 'failed' (message untouched, no Evolution call) when not connected; 400 still means expired.
3. media.ts: drainMediaQueue breaks after the first 'failed'.
4. merge.ts: moveContact returns {touched, removed}; mergeLidPairs publishes chat.removed for absorbed chats after commit via new Hub.publishChatRemoved (hub.ts, recording hub too).

Tests: jobs.test.ts (5-min-old row skipped by import, copied by back-fill), media.test.ts (Baixar on disconnected channel; drain stops at first failure), merge.test.ts (chat.removed + chat events).

Commands: npm test -> server 63 files / 1572 tests pass, web 37 files / 260 pass; npm run typecheck -> exit 0.

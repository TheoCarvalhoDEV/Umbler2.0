# syntax=docker/dockerfile:1
# Evolution API oficial + um conserto no Baileys. Ao reconectar, o Baileys pede ao WhatsApp só 100 itens da fila de
# pendentes (mensagens, recibos, notificações) e nunca pede o resto. Num número movimentado uma noite desligado passa
# disso: a fila para no meio e as mensagens novas ficam presas atrás dela (o canal aparece "Conectado", mas nada chega).
# O conserto pede a fila inteira, o total que o WhatsApp anuncia no offline_preview.
# Ao trocar a tag, o build falha se esse trecho do Baileys mudou: revise o conserto (pode já ter sido corrigido).
FROM evoapicloud/evolution-api:v2.3.7
RUN node <<'EOF'
const fs = require('fs');
const file = '/evolution/node_modules/baileys/lib/Socket/socket.js';
const from = "{ tag: 'offline_batch', attrs: { count: '100' } }";
const to = "{ tag: 'offline_batch', attrs: { count: String(Math.max(100, +(getBinaryNodeChild(node, 'offline_preview')?.attrs.count || 0))) } }";
const src = fs.readFileSync(file, 'utf8');
if (!src.includes(from)) throw new Error('Baileys mudou: revise o conserto do offline_batch em evolution/Dockerfile');
fs.writeFileSync(file, src.replace(from, to));
EOF

#!/bin/sh
# Testa gen-secrets.sh e backup.sh sem Docker real (o "docker" é falso).
# Rode num Linux. No Windows/macOS:
#   docker run --rm -v "${PWD}:/w" -w /w alpine:3.20 sh scripts/test-scripts.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail() { echo "FALHOU: $1" >&2; exit 1; }

mkdir -p "$T/scripts" "$T/bin"
cp "$ROOT/.env.example" "$T/"
cp "$ROOT/scripts/gen-secrets.sh" "$ROOT/scripts/backup.sh" "$T/scripts/"

# --- gen-secrets.sh ---
sh "$T/scripts/gen-secrets.sh" talk.exemplo.com.br >/dev/null
grep -qx 'DOMAIN=talk.exemplo.com.br' "$T/.env" || fail "DOMAIN não gravado"
grep -qx 'APP_ORIGIN=https://talk.exemplo.com.br' "$T/.env" || fail "APP_ORIGIN não gravado"
! grep -q 'troque' "$T/.env" || fail "sobrou valor de exemplo no .env"
KEYS='WEBHOOK_SECRET|EVOLUTION_API_KEY|POSTGRES_PASSWORD|POSTGRES_TALK_PASSWORD|POSTGRES_EVOLUTION_PASSWORD'
[ "$(grep -Ec "^($KEYS)=[0-9a-f]{64}$" "$T/.env")" -eq 5 ] || fail "segredos ausentes ou fora do formato hex de 64"
[ "$(grep -E "^($KEYS)=" "$T/.env" | cut -d= -f2 | sort -u | wc -l)" -eq 5 ] || fail "segredos repetidos"
[ "$(stat -c %a "$T/.env")" = 600 ] || fail "permissão do .env não é 600"
cp "$T/.env" "$T/env-antes"
if sh "$T/scripts/gen-secrets.sh" outro.com.br >/dev/null 2>&1; then fail "gen-secrets aceitou sobrescrever .env"; fi
cmp -s "$T/.env" "$T/env-antes" || fail ".env existente foi alterado"

# --- backup.sh ---
mkdir -p "$T/data/media/2026/10" "$T/data/backup"
echo foto > "$T/data/media/2026/10/a.jpg"
cat > "$T/bin/docker" <<'EOF'
#!/bin/sh
[ -n "${FAKE_DOCKER_FAIL:-}" ] && { echo "dump parcial"; exit 1; }
echo "-- dump novo"
EOF
chmod +x "$T/bin/docker"
echo "-- dump bom" > "$T/data/backup/db.sql"

if FAKE_DOCKER_FAIL=1 PATH="$T/bin:$PATH" sh "$T/scripts/backup.sh" >/dev/null 2>&1; then fail "backup com dump falho terminou com sucesso"; fi
[ "$(cat "$T/data/backup/db.sql")" = "-- dump bom" ] || fail "dump com falha sobrescreveu o db.sql bom"

PATH="$T/bin:$PATH" sh "$T/scripts/backup.sh" >/dev/null
[ "$(cat "$T/data/backup/db.sql")" = "-- dump novo" ] || fail "dump novo não foi gravado"
[ ! -e "$T/data/backup/media.tar.gz" ] || fail "backup não deve gerar media.tar.gz (a mídia vai pelo snapshot/restic)"
[ "$(stat -c %a "$T/data/backup")" = 700 ] || fail "permissão de data/backup não é 700"

echo "OK: scripts testados"

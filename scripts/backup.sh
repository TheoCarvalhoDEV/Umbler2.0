#!/bin/sh
# Backup diário: dump dos DOIS bancos (talk + evolution, que guarda a sessão do WhatsApp
# e cópias de mensagens de clientes) e da pasta de mídia.
# Cron (root):  30 3 * * * sh /opt/talk/scripts/backup.sh >> /var/log/talk-backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
mkdir -p data/backup

# Grava em .tmp e só renomeia no fim: um dump com falha nunca sobrescreve o último bom.
docker compose exec -T postgres pg_dumpall -U postgres --clean --if-exists > data/backup/db.sql.tmp
mv data/backup/db.sql.tmp data/backup/db.sql

tar -czf data/backup/media.tar.gz.tmp -C data media
mv data/backup/media.tar.gz.tmp data/backup/media.tar.gz

echo "$(date -Iseconds) backup ok"

# --- Cópia FORA do servidor com restic (use se o provedor do VPS NÃO tiver backup externo) ---
# Este bloco envia o dump e a mídia, criptografados, para o Backblaze B2.
# 1. sudo apt install restic
# 2. Crie um bucket privado no Backblaze B2 e uma Application Key só para ele.
# 3. Crie /root/.restic-env (sudo chmod 600 /root/.restic-env) com:
#      export B2_ACCOUNT_ID=id-da-application-key
#      export B2_ACCOUNT_KEY=application-key
#      export RESTIC_REPOSITORY=b2:nome-do-bucket:talk
#      export RESTIC_PASSWORD=senha-longa-aleatoria
#    Guarde RESTIC_PASSWORD também FORA do VPS. Sem ela o backup é ilegível.
# 4. Uma vez só: sudo sh -c '. /root/.restic-env && restic init'
# 5. Descomente as três linhas abaixo:
# . /root/.restic-env
# restic backup data/backup/db.sql data/media --tag talk
# restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

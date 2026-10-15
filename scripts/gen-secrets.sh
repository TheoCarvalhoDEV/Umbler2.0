#!/bin/sh
# Uso: sh scripts/gen-secrets.sh talk.seudominio.com.br
# Cria o .env a partir do .env.example com segredos aleatórios (32 bytes em hex).
# Nunca sobrescreve um .env existente.
set -eu
cd "$(dirname "$0")/.."
DOMAIN=${1:?Informe o domínio. Ex.: sh scripts/gen-secrets.sh talk.jvo.adv.br}
if [ -e .env ]; then
  echo "Já existe um .env; nada foi alterado. Apague-o antes se quiser gerar outro." >&2
  exit 1
fi
secret() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
umask 077
sed -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
    -e "s|^APP_ORIGIN=.*|APP_ORIGIN=https://$DOMAIN|" \
    -e "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(secret)|" \
    -e "s|^EVOLUTION_API_KEY=.*|EVOLUTION_API_KEY=$(secret)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_TALK_PASSWORD=.*|POSTGRES_TALK_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_EVOLUTION_PASSWORD=.*|POSTGRES_EVOLUTION_PASSWORD=$(secret)|" \
    .env.example > .env
chmod 600 .env
echo ".env criado (chmod 600). Guarde uma cópia FORA do servidor (gerenciador de senhas)."

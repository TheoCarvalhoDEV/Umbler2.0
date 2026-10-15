#!/bin/sh
# Roda UMA vez, na primeira subida do Postgres (volume vazio), via /docker-entrypoint-initdb.d.
# Cria os bancos talk (app) e evolution (Evolution API), cada um com usuário próprio.
# Sem `set -u`: o entrypoint do Postgres pode executar este arquivo com `source`.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v talk_pass="$POSTGRES_TALK_PASSWORD" \
  -v evo_pass="$POSTGRES_EVOLUTION_PASSWORD" <<'SQL'
CREATE ROLE talk LOGIN PASSWORD :'talk_pass';
CREATE DATABASE talk OWNER talk;
CREATE ROLE evolution LOGIN PASSWORD :'evo_pass';
CREATE DATABASE evolution OWNER evolution;
SQL

# Núcleo de atendimento — especificação de design

- **Data:** 14/10/2026
- **Status:** seções 1–3 aprovadas em conversa; demais com "total liberdade" do usuário; revisada por workflow multi-lente (19 achados confirmados e aplicados, rev. 2)
- **Sub-projeto:** 1 de 3 (Núcleo → Automação → Gestão)
- **Referências:** `docs/umbler/MAPA-UMBLER-TALK.md`, `docs/umbler/ENDPOINTS-INTERNOS.md`, `docs/umbler/MODELO-DE-DADOS.md`, `docs/umbler/utalk-openapi-v1.json`

## 1. Objetivo e critério de sucesso

Sistema próprio do escritório para atender clientes pelo WhatsApp, substituindo o Umbler Talk.
**Sucesso:** o escritório atende o WhatsApp do dia a dia só pelo sistema novo e desliga o Umbler Talk.

### Decisões do usuário (14/10/2026)
| Tema | Decisão |
|---|---|
| Conexão WhatsApp | QR Code (não oficial), via Evolution API v2 |
| Hospedagem | VPS na nuvem, Docker Compose |
| Manutenção | equipe do escritório com o Claude → TypeScript de ponta a ponta |
| Migração | só contatos e cadastros (setores, etiquetas, respostas rápidas, campos); histórico fica no Umbler |
| Usuários | um login por pessoa, atendente em um ou mais setores |
| IA | fora de escopo |
| Abordagem | sistema próprio + Evolution API como ponte (opção C) |

### Riscos aceitos
- **Banimento do número:** conexão por QR viola os termos do WhatsApp. Mitigação: integração isolada no módulo `whatsapp/`; a Evolution também suporta a Cloud API oficial, então migrar é trocar configuração do canal, não o núcleo.
- **Mudanças do WhatsApp quebram a conexão:** mitigado mantendo a Evolution atualizada (tag fixa, atualização manual com rollback — §6).

## 2. Arquitetura

```
VPS (Docker Compose)
  caddy (80/443, HTTPS automático) ──► app (Node 24, TypeScript, um processo)
                                         ├─ API HTTP (Fastify)          /api/*
                                         ├─ Tempo real (WebSocket)       /ws
                                         ├─ Webhook da Evolution         /webhooks/evolution/:secret  (só rede interna)
                                         └─ Front React compilado        /
  postgres 16 ── database `talk`      (app)
             └── database `evolution` (Evolution, usuário próprio; criado por script de init)
  evolution-api v2 (tag fixa) ──► WhatsApp      sem Redis: CACHE_REDIS_ENABLED=false, CACHE_LOCAL_ENABLED=true
  volume /data/media (mídia)   volume /data/backup (dump diário)
```

- **Um único serviço próprio.** Sem microserviços, filas ou cache nesta fase (3–10 atendentes).
- **Repositório:** `server/` (Fastify, Drizzle, `ws`), `web/` (React + Vite, Phosphor Icons), `docker-compose.yml`, `Caddyfile`, `scripts/` (init do banco, backup).
- **Fronteiras de módulo (server):**
  | Módulo | Responsabilidade | Depende de |
  |---|---|---|
  | `db/` | schema Drizzle, migrations, conexão | — |
  | `auth/` | login, sessão, hash de senha, papel, checagem de Origin | db |
  | `whatsapp/` | **único** ponto que fala com a Evolution: enviar, baixar mídia, instância/QR/status, traduzir webhook em eventos internos, `normalizePhoneBR` | — (HTTP) |
  | `inbox/` | regras de conversa: abrir/reaproveitar, dono, transferir, finalizar, privar, esperando, não lidas, eventos, **`canSee(user, chat)`** | db |
  | `messages/` | gravar/enviar mensagens, status, reações, mídia, notas, variáveis de resposta rápida | db, whatsapp, inbox |
  | `triage/` | menu de boas-vindas → setor | inbox, messages |
  | `contacts/`, `catalog/` (setores, etiquetas, respostas rápidas, campos, usuários) | CRUD | db |
  | `realtime/` | hub WebSocket indexado por usuário; publica respeitando `canSee` | auth, inbox |
  | `importer/` | script único de importação do Umbler Talk | db, whatsapp (normalizePhoneBR) |
- Rotas HTTP são finas; regra de negócio vive nos módulos; só `whatsapp/` conhece o formato da Evolution.

## 3. Escopo do núcleo

**Entra:**
1. **Conexão WhatsApp:** tela do canal com QR, status e botão "Gerar novo QR / Reconectar" (§5.6); um número, modelo pronto para vários.
2. **Caixa de conversas:** abas Entrada / Esperando / Finalizados; busca por nome/telefone; filtros setor, atendente, etiqueta (do contato), período; não lidas; fixar (por usuário, máx. 3); botão **+ Nova conversa**.
3. **Tela da conversa:** enviar/receber texto, imagem, áudio (ouvir e gravar), documento, vídeo; responder citando; reações recebidas exibidas na mensagem; status ✓/✓✓/lido; notas internas; linha do tempo de eventos; assinatura opcional (formato em §5.2).
4. **Atendimento:** assumir, transferir (setor e/ou atendente), privar/liberar, finalizar (com mensagem de encerramento opcional), reabrir, **iniciar conversa** com contato existente ou telefone novo (§5.3a) — pela caixa, pela ficha do contato e pelo rodapé de conversa finalizada.
5. **Contatos:** lista paginada, ficha (telefone, e-mail, fixo, endereço, campos personalizados), observações, etiquetas, bloquear, histórico de conversas (só as visíveis ao usuário), criar/editar.
6. **Cadastros (admin):** setores, etiquetas (emoji + cor), respostas rápidas (`/` no compositor, variáveis nomeadas — §5.7), campos personalizados, usuários (admin/atendente, assinatura, ativo).
7. **Menu de triagem mínimo** (boas-vindas + opções numeradas → setor).
8. **Notificações:** som + notificação do navegador em mensagem nova.
9. **Importador do Umbler Talk** (contatos, setores, etiquetas, respostas rápidas com anexos e variáveis, campos), com relatório do que não pôde ser convertido.

**Fora (próximos sub-projetos ou depois):** editor de fluxo, horários, agendamentos, espera/inatividade automáticas, relatórios, logs de atividade, webhooks de saída, permissões finas, campanhas, Webchat, boards, figurinhas, localização, enviar reação, editar/apagar mensagem enviada, exibir edição/exclusão feita pelo contato, encaminhar, etiquetas **da conversa** (só etiquetas do contato), mensagens fixadas/favoritas, buscar dentro da conversa, IA.

## 4. Modelo de dados (PostgreSQL `talk`, Drizzle)

IDs `uuid` (`crypto.randomUUID()`); datas `timestamptz` em UTC.

**Telefones:** formato canônico `55` + DDD + `9` + 8 dígitos (13 dígitos, sem `+`). O WhatsApp/Evolution entrega muitos celulares brasileiros com 12 dígitos (sem o 9 — a Evolution remove o 9 quando DDD ≥ 31). Uma única função `normalizePhoneBR` (em `whatsapp/`) é usada no webhook, no importador, na busca e na criação manual: se o número casar com `/^55(\d{2})([6-9]\d{7})$/`, insere `9` antes dos 8 dígitos; números de 12 dígitos cujo primeiro dígito local é 2–5 (fixo/WhatsApp Business) ficam como estão. No envio, passa-se o número canônico; o `createJid` da Evolution faz a conversão.

| Tabela | Campos | Restrições |
|---|---|---|
| `users` | id, name, email, password_hash, role (`admin`\|`agent`), signature (texto livre, opcional), active, created_at | email único |
| `sessions` | id (hash SHA-256 de token aleatório de 32 bytes), user_id, expires_at, created_at | |
| `sectors` | id, name, position, is_default | um único `is_default=true` (índice parcial) |
| `user_sectors` | user_id, sector_id | PK composta |
| `channels` | id, name, kind (`whatsapp_qr`), evolution_instance, status (`disconnected`\|`connecting`\|`connected`), phone, created_at | instance única |
| `contacts` | id, name, phone, lid, email, landline, address (jsonb), blocked, created_at, updated_at | `unique(phone) WHERE phone IS NOT NULL`; `unique(lid) WHERE lid IS NOT NULL` |
| `custom_fields` | id, name, kind (`text`\|`number`\|`date`\|`cpf`\|`cnpj`), position | name único |
| `contact_field_values` | contact_id, field_id, value (text) | PK composta |
| `contact_notes` | id, contact_id, author_id, body, pinned, created_at | |
| `tags` | id, name (≤30), emoji, color, position | name único |
| `contact_tags` | contact_id, tag_id | PK composta |
| `chats` | id, contact_id, channel_id, sector_id, owner_id (null = sem dono), state (`open`\|`closed`), waiting, private, triage_pending, unread (int), last_message_at, last_message_preview, created_at, closed_at | **`unique(contact_id, channel_id) WHERE state='open'`** |
| `chat_pins` | user_id, chat_id, created_at | PK composta; máx. 3 por usuário (checado no app) |
| `messages` | id, chat_id, channel_id, direction (`in`\|`out`), kind (`text`\|`image`\|`audio`\|`video`\|`document`\|`sticker`\|`note`\|`unsupported`), body, media_path, media_mime, media_size, media_name, author_id (null = contato, celular ou sistema), reply_to_id, external_id, **reaction** (emoji recebido, null = nenhuma), status (`pending`\|`sent`\|`delivered`\|`read`\|`failed`), error, **sent_at** (timestamp do WhatsApp; `now()` para saídas e notas), created_at | **`unique(channel_id, external_id)`** (external_id nulo em notas e pendentes — nulos não colidem no Postgres) |
| `chat_events` | id, chat_id, kind (`created`\|`assigned`\|`transferred`\|`closed`\|`reopened`\|`privacy_changed`\|`triage_routed`), data (jsonb), author_id, created_at | |
| `quick_answers` | id, name, body (com variáveis nomeadas, §5.7), attachment_path, visibility (`all`\|`owner`), owner_id, created_at | |
| `settings` | key, value (jsonb) | `closing_message`, `triage_menu` (`{enabled, welcome_text, invalid_text, options:[{key,label,sector_id}]}`) |

Conversa ordenada por `(sent_at, created_at, id)` (ordem de chegada no mesmo segundo); o cliente não reordena empates. `chats.last_message_at = greatest(last_message_at, sent_at)` para mensagem atrasada não "voltar" a conversa.

**Mídia:** arquivo em `/data/media/AAAA/MM/<uuid>.<ext>`, servido por `/api/media/:messageId` somente se `canSee(user, chat)` (§6). Toda resposta leva `X-Content-Type-Options: nosniff`. `Content-Disposition: inline` só para image/jpeg|png|webp|gif, audio/*, video/mp4 e application/pdf; todo o resto (incl. SVG e HTML) vai com `attachment` e `Content-Type: application/octet-stream`. Respostas que não são PDF levam também `Content-Security-Policy: sandbox`. Anexo de resposta rápida com `visibility=owner` só é servido ao dono.

## 5. Fluxos principais

### 5.1 Evento recebido do WhatsApp
1. Evolution chama `POST /webhooks/evolution/:secret` (eventos: `messages.upsert`, `messages.update`, `connection.update`, `qrcode.updated`). Segredo errado → 401. Payload desconhecido → 200 + log de aviso.
2. `whatsapp/` traduz e classifica:
   - **Ignorar:** grupos (`@g.us`), status/broadcast, `protocolMessage` (apagar/editar), e eco de mensagens enviadas pelo próprio sistema (reconhecido pelo `external_id` já gravado).
   - **Reação:** busca a mensagem alvo por `(channel_id, reaction.key.id)`; grava `messages.reaction` (null se emoji vazio = removida); publica `message.updated`; fim. Alvo não encontrado → ignora. **Reação nunca cria conversa nem mexe em não lidas/esperando.**
   - **Mensagem de conteúdo:** vira `IncomingMessage {channelId, externalId, direction: in | out(celular), phone, lid, pushName, kind, body, media?, replyToExternalId?, sentAt}`.
3. **Idempotência:** insere com `ON CONFLICT (channel_id, external_id) DO NOTHING`; se não inseriu, responde 200 e para.
4. **Contato:** procura por `normalizePhoneBR(phone)`, depois por `lid`; se o payload trouxer os dois (remoteJid `@lid` + `senderPn`/`remoteJidAlt`), preenche o que faltar no contato achado. Cria só se nenhum casar (`INSERT … ON CONFLICT DO NOTHING` + nova leitura, para dois webhooks simultâneos). Atualiza nome se vazio. Contato bloqueado → descarta.
5. **Conversa** (depende da direção):
   - `in`: usa a aberta `(contato, canal)`; se não há, cria (setor padrão, `waiting=true`, evento `created`) e aciona a triagem (§5.4). Atualiza `unread+1`, `waiting=true`, `last_message_*`.
   - `out` vinda do celular: usa a aberta; se não há, cria com `waiting=false`, `triage_pending=false`, **sem triagem**. Atualiza só `last_message_*`, `waiting=false`, `triage_pending=false`; `unread` não muda.
   - Criação de conversa usa `INSERT … ON CONFLICT DO NOTHING` no índice único parcial + nova leitura (corrida de dois webhooks).
6. **Mídia:** baixa via `POST /chat/getBase64FromMediaMessage/{instance}` passando o objeto do webhook (`{ message: { key, message } }`) e salva em `/data/media`. Falhou → mensagem gravada com `media_path=null` e `error` ("mídia indisponível"); a mensagem nunca se perde. O download roda fora da transação e atualiza a mensagem depois.
7. Publica `message.created` e `chat.updated` (§5.5).

Passos 3–5 numa transação.

### 5.2 Mensagem enviada pelo atendente
1. `POST /api/chats/:id/messages` (texto ou multipart com arquivo; `signature: boolean`; `replyToId?`).
2. Exige `canSee`; conversa aberta; se privada, só o dono ou admin. Se a conversa não tem dono, quem envia vira dono (evento `assigned`).
3. Grava `messages` (`status=pending`, `sent_at=now()`); publica no WS (aparece na hora com relógio).
4. Chama a Evolution (`/message/sendText`, `/message/sendMedia`, `/message/sendWhatsAppAudio`); resposta citada envia `quoted` com a chave da mensagem original. Sucesso → grava `external_id`, `status=sent`. Erro → `status=failed`, `error`, botão "reenviar".
5. `waiting=false`, `unread=0`, `triage_pending=false`.
6. `messages.update` (webhook) atualiza `delivered`/`read` pela `external_id` e publica `message.updated`.

**Assinatura:** se marcada (padrão: ligada), o texto enviado é `*{assinatura}:*\n{texto}`, onde `assinatura = users.signature` se preenchida, senão `{Setor} - {Nome}` (formato do Umbler).

### 5.3 Ações de atendimento
Funções em `inbox/`; cada uma exige `canSee`, altera `chats` com `UPDATE … WHERE` checando o estado esperado (evita corrida), grava `chat_events` e publica `chat.updated`:
- **assumir** (owner = eu) · **transferir** (setor e/ou atendente; se o dono for limpo, `private=false`) · **privar/liberar** (só dono ou admin) · **finalizar** (state=closed, closed_at; se `closing_message` existe e o atendente marcar "enviar encerramento", envia antes) · **reabrir** (se já houver outra aberta para o contato, abre essa) · **marcar lida** (unread=0 ao abrir a conversa).
- Em conversa privada, só dono ou admin transfere ou finaliza.
- Nova mensagem `in` do contato numa conversa finalizada cria **nova** conversa (regra do Umbler).

### 5.3a Iniciar conversa
`POST /api/chats {contactId | phone, sectorId?}`: normaliza o telefone; cria o contato se não existir; se já houver conversa aberta `(contato, canal)`, devolve ela; senão cria com `owner=eu`, setor = `sectorId` ou o padrão, `waiting=false`, `triage_pending=false`, sem triagem, evento `created {by: userId}`. Telefone sem WhatsApp aparece como falha no primeiro envio (§5.2 passo 4).

### 5.4 Triagem mínima
- Só em conversa criada por mensagem `in` e com `settings.triage_menu.enabled`.
- Envia `welcome_text` + opções; `triage_pending=true`. O envio acontece **depois** da transação do §5.1.
- Próxima mensagem `in`: se casar com uma opção (número ou nome do setor, sem acento/caixa) → move para o setor, evento `triage_routed`, `triage_pending=false`. Se não casar → envia `invalid_text` uma vez, `triage_pending=false`, fica no setor padrão.
- Qualquer mensagem `out` (sistema ou celular) encerra a triagem.

### 5.5 Tempo real
- WebSocket em `/ws`, autenticado pelo cookie de sessão; upgrade exige `Origin` = `APP_ORIGIN` (§6).
- Eventos: `message.created`, `message.updated`, `chat.updated`, `chat.removed`, `channel.status`.
- A cada mudança de conversa: `chat.updated` (conversa completa) para cada socket cujo usuário `canSee` a conversa **depois** da mudança, e `chat.removed` para os demais sockets conectados (o cliente ignora remoção de conversa que não tem). Visibilidade calculada na hora a partir do banco (não em cache por socket).
- Cliente reconecta com backoff e, ao reconectar, recarrega a lista (sem replay).

### 5.6 Conexão do canal
- Admin cria canal → `whatsapp/` cria instância na Evolution com webhook (eventos de §5.1) apontando para a URL interna `http://app:3000/webhooks/evolution/<secret>`.
- `connection.update` `data.state`: `open`→`connected`, `connecting`→`connecting`, `close`→`disconnected`; publica `channel.status` a cada mudança.
- QR exibido a partir de `qrcode.updated` (`data.qrcode.base64`).
- Canal não conectado → botão **"Gerar novo QR / Reconectar"** chama `GET /instance/connect/{instance}` e mostra o QR retornado (cobre QR expirado e logout pelo celular).
- Ao iniciar o `app`, consulta `GET /instance/connectionState/{instance}` de cada canal e corrige `channels.status` (webhook perdido com o app fora). Sem polling periódico.
- Canal desconectado → banner vermelho global "WhatsApp desconectado".

### 5.7 Variáveis de resposta rápida
- Sintaxe nomeada no `body`: `{{atendente.nome}}`, `{{atendente.primeiro_nome}}`, `{{atendente.email}}`, `{{contato.nome}}`, `{{contato.primeiro_nome}}`, `{{contato.telefone}}`, `{{contato.email}}`, `{{campo.<nome>}}`.
- Ao escolher a resposta com `/`, cada variável é substituída (vazio se não houver valor) e o texto vai para o compositor para edição — nunca é enviado automaticamente.
- Importador: converte cada `{{n}}` do Umbler para a variável nomeada correspondente a `variables[n-1].defaultValue`; sem correspondência → escreve o defaultValue como texto e registra no relatório; baixa o `attachment` para `/data/media`.

## 6. Segurança e LGPD
- **Autorização:** uma função `inbox/canSee(user, chat)`: admin vê tudo; atendente vê conversas dos seus setores e as de que é dono; privada só o dono + admin. Vale para toda rota que lê/altera conversa, mensagem ou mídia, para o histórico do contato (conversas não visíveis ficam ocultas) e para o WS. Listagens e busca aplicam a mesma regra no `WHERE` do SQL. Sem acesso → 404.
- **Senhas e sessão:** argon2id; cookie `HttpOnly; Secure; SameSite=Lax`, expira após 30 dias sem uso; logout apaga a sessão no banco; toda requisição valida a sessão no banco. Login recusa `active=false`. Desativar usuário ou redefinir senha apaga todas as sessões dele e chama `realtime.disconnectUser(userId)`.
- **CSRF:** todo método não-GET em `/api/*` e o upgrade de `/ws` exigem `Origin` exatamente igual a `APP_ORIGIN` (.env); ausente ou diferente → 403. Fastify com `trustProxy` apenas para o Caddy (para o limite de login usar o IP real).
- **Login:** limite de 5 tentativas/min por IP+email.
- **Rede:** só o Caddy expõe portas (80/443). Evolution e Postgres sem porta publicada; o webhook é chamado pela rede interna do Docker e o Caddy **não** encaminha `/webhooks/*`.
- **Evolution:** `AUTHENTICATION_API_KEY` aleatória gerada na instalação (32+ bytes, só no `.env`, `chmod 600`), nunca o valor do `.env.example`; banco próprio `evolution` com usuário próprio; `DATABASE_SAVE_DATA_NEW_MESSAGE` e `MESSAGE_UPDATE`=true (necessários para mídia por chave, respostas citadas e status ✓✓); `HISTORIC`, `CONTACTS`, `CHATS`, `LABELS`=false; o banco da Evolution também contém mensagens de clientes e segue as mesmas regras de backup/LGPD; imagem `evoapicloud/evolution-api` com tag de versão exata (a última v2 estável no dia da implantação, gravada no `docker-compose.yml`; nunca `latest`), atualizada manualmente anotando a tag anterior para rollback.
- **Backup:** cron diário roda `pg_dumpall` (os dois bancos — o da Evolution guarda a sessão, evitando reescanear o QR) para `/data/backup/db.sql.tmp` e só então renomeia para `db.sql` (dump com falha nunca sobrescreve o bom). Cópia fora do servidor: snapshot/backup automático do provedor da VPS (confirmar que é externo e a retenção); se o provedor não oferecer, `restic` criptografado para Backblaze B2/S3 com senha guardada fora do VPS. Restauração testada uma vez antes da virada (§8).
- **Logs** sem conteúdo de mensagem.

## 7. Tratamento de erros
| Situação | Comportamento |
|---|---|
| Evolution fora do ar ao enviar | mensagem `failed` + reenviar; banner de canal |
| Canal desconectado (logout no celular / QR expirado) | banner global + botão Reconectar na tela do canal |
| Webhook duplicado | ignorado pelo `ON CONFLICT` |
| Webhook com payload desconhecido | 200 + log de aviso (nunca derrubar) |
| Falha ao baixar mídia | mensagem gravada como "mídia indisponível" |
| Corrida criando contato/conversa | `ON CONFLICT DO NOTHING` + nova leitura reaproveita o existente |
| Ação de atendimento sobre estado já alterado | `UPDATE … WHERE` não afeta linha → 409, front recarrega a conversa |
| Erro inesperado na API | 500 com id de correlação; toast "Ocorreu um erro" com o id |

## 8. Testes, implantação e recuperação
- **Unitários (Vitest):**
  - `normalizePhoneBR`: celular de 12 dígitos com DDD ≥ 31 (ganha o 9), celular de 13 dígitos (inalterado), fixo de 12 dígitos começando com 2–5 (inalterado), número DDD 11.
  - tradução de webhook (`whatsapp/`): conteúdo, reação, revoke/edit ignorados, grupo ignorado, `fromMe` do celular, LID + `senderPn`.
  - triagem, variáveis de resposta rápida (substituição e conversão `{{n}}`→nomeada), formato da assinatura, cabeçalhos da rota de mídia.
- **Integração (Vitest + PGlite, Postgres em processo e em memória, com as migrations aplicadas; `whatsapp/` substituído por um stub em memória):**
  - recebida: idempotência; nova conversa após finalizar; JID de 12 dígitos casa com contato importado de 13; mensagem só com LID anexa a contato existente; 👍 em conversa finalizada **não** abre conversa; resposta pelo celular **não** liga "Esperando".
  - enviada: sucesso, falha e reenvio.
  - iniciar conversa: contato existente, telefone novo, conversa já aberta.
  - visibilidade por setor/privada: listagem, GET de mensagens, mídia, histórico do contato e WS.
- **Fixtures de webhook:** payloads de exemplo da documentação da Evolution v2 (sem dados reais).
- **Checklist manual antes da virada:** conectar QR, receber/enviar cada tipo de mídia, responder citando, reação, transferir, finalizar, iniciar conversa, triagem, reconectar canal.
- **Implantação:** `docker compose up -d` num VPS (Ubuntu, 2 vCPU/4 GB recomendados); `.env.example` documenta as variáveis; script de init cria os bancos `talk` e `evolution`; migrations rodam no start do `app`.
- **Recuperação (runbook):** novo VPS → clonar repositório → restaurar `.env` (guardado fora do servidor) → restaurar backup (`psql < db.sql` + `/data/media`) → `docker compose up -d` → reescanear o QR se a sessão não voltar. Ensaiar uma vez num container descartável antes da virada.
- **Virada:** importar cadastros → conectar o mesmo número no sistema novo (desconecta do Umbler) → uma semana consultando o histórico antigo no Umbler → cancelar a assinatura.

## 9. Próximos sub-projetos
- **2 — Automação:** editor de fluxo (catálogo de blocos do mapa), horários, agendamentos, espera/inatividade.
- **3 — Gestão:** relatórios (endpoints mapeados em `ENDPOINTS-INTERNOS.md`), logs de atividade, webhooks, permissões finas.

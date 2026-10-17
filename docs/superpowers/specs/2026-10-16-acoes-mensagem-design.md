# Ações de mensagem (reagir, apagar, editar, figurinhas, encaminhar) — design

- **Data:** 16/10/2026 · **Status:** desenho aprovado em conversa — aguardando revisão desta spec
- **Branch:** `feat/acoes-mensagem` (a partir de `develop` + tema do PR #7) → PR para `develop`
- **Base:** spec do núcleo `2026-10-14-nucleo-atendimento-design.md`; pesquisa do código da Evolution 2.3.7 (Baileys 7.0.0-rc.9) feita em 16/10.
- **Ordem:** esta entrega vem antes do histórico (`2026-10-16-historico-whatsapp-design.md`, plano pronto e em espera), por decisão do usuário.

## 1. Objetivo
Dar ao atendente as ações do WhatsApp que faltam e mostrar quando o cliente apaga ou edita. Hoje o sistema só mostra a reação do cliente, recebe figurinhas e responde citando; mensagens que o cliente apaga ou edita continuam com o texto original e edições no formato novo viram bolhas "não suportada".

## 2. Regras gerais
- Só faz uma ação quem `canSee` a conversa; nunca em conversa finalizada nem em nota interna; Origin check em toda mutação (como hoje).
- Apagar e editar ficam registrados na linha do tempo (eventos `message_deleted`, `message_edited`); reações só aparecem na bolha.
- Erros da Evolution viram mensagem em pt-BR para o atendente; log só com ids e nome/código do erro, nunca texto.
- Ações feitas no **celular do escritório** (apagar/editar/reagir) também chegam por webhook e são aplicadas igual, com autor "Celular".

## 3. Reagir
- Menu ao passar o mouse na bolha: botão de reação com 👍 ❤️ 😂 😮 😢 🙏 e "mais" (seletor de emoji nativo do navegador/teclado; um emoji só).
- `POST /api/messages/:id/reaction` `{ emoji: string | '' }` → Evolution `POST /message/sendReaction/{instance}` `{ key: { remoteJid, fromMe, id }, reaction }` (`''` remove). Mesmo emoji de novo → remove.
- Duas reações por mensagem: a do contato (coluna atual `reaction`) e a do escritório (nova `office_reaction`); a bolha mostra as duas.
- Reação feita no celular do escritório (hoje ignorada em `parse.ts`) passa a gravar `office_reaction`.
- Vale para mensagens recebidas e enviadas, com id do WhatsApp (não para `pending`/`failed`).

## 4. Apagar para todos
- Só mensagens **enviadas pelo escritório** (`direction='out'`, inclui bot e triagem), com id do WhatsApp, até **48 h** após o envio (limite do WhatsApp ~2 dias). Qualquer atendente que vê a conversa. Confirmação antes ("Apagar para todos? O contato deixa de ver esta mensagem.").
- `DELETE /api/messages/:id` → Evolution `DELETE /chat/deleteMessageForEveryone/{instance}` `{ id, remoteJid, fromMe: true }`.
- Grava `deleted_at`, `deleted_by` (usuário) e `deleted_source='office'`. A bolha mantém o texto/mídia visível para quem vê a conversa, com a tag **"Apagada por <nome>"**.
- **Quando o contato apaga** (webhook `MESSAGES_DELETE`, `data: { remoteJid, fromMe, id, status: 'DELETED' }`): grava `deleted_at` e `deleted_source='contact'`; **o texto continua visível**, com a tag **"Apagada pelo contato"** (decisão do usuário). Apagado pelo celular do escritório → `deleted_source='phone'`, tag "Apagada pelo celular".
- Mensagem apagada não pode ser editada, reagida, encaminhada nem citada.

## 5. Editar
- Só **texto** e **legenda** de imagem/vídeo enviados pelo **próprio atendente** (`author_id = usuário`), até **15 min** após o envio; não vale para bot, triagem ou celular.
- `PATCH /api/messages/:id` `{ text }` (1–4096 caracteres, igual ao envio) → Evolution `POST /chat/updateMessage/{instance}` `{ number, key: { remoteJid, fromMe: true, id }, text }`. A Evolution exige a original no banco dela (`DATABASE_SAVE_DATA_NEW_MESSAGE=true`, já ligado).
- Nova tabela `message_edits` (`message_id`, `previous_body`, `edited_at`, `source: 'office'|'contact'|'phone'`, `edited_by` nulo exceto office). `messages.body` passa a ter o texto novo; `edited_at` na mensagem.
- Bolha: tag **"editada"**; clique mostra os textos anteriores com data.
- **Quando o contato edita:** webhook `MESSAGES_UPDATE` com `message.editedMessage.message` (`conversation` ou `extendedTextMessage.text` ou legenda) e `keyId` do alvo → mesmo registro com `source='contact'`, tag "editada pelo contato".
- **Formato novo do WhatsApp** (`secretEncryptedMessage` com `secretEncType` de edição e `targetMessageKey`): o texto vem cifrado. Marca o alvo como editado com `previous_body` = texto atual e o novo indisponível → tag **"editada pelo contato (novo texto indisponível)"**; não cria bolha "não suportada".
- Webhooks: assinar `MESSAGES_DELETE` (além dos atuais). **Não** assinar `MESSAGES_EDITED` (a Evolution espera essa entrega dentro da fila e trava tudo por ~20 min quando o app está fora). Instâncias existentes recebem a lista nova no boot via `POST /webhook/set/{instance}` (uma vez, idempotente).

## 6. Figurinhas
- Botão de figurinha no compositor abre um painel com as **figurinhas recentes** (as 40 mais recentes, recebidas ou enviadas, com arquivo salvo, sem repetir o mesmo arquivo — por hash do conteúdo).
- Escolher uma → `POST /api/chats/:id/messages` com `{ stickerFromMessageId }`; ou **"Enviar imagem como figurinha"** (PNG/JPEG/WebP até 1 MB) → multipart com `asSticker=true`.
- Envio via Evolution `POST /message/sendSticker/{instance}` em **JSON** com `sticker` = base64 cru (a Evolution converte PNG/JPEG para WebP; não usar multipart, que tem bug na 2.3.7). Mensagem gravada com `kind='sticker'`.
- Mesmas regras do envio normal (bot rodando → 409 `BOT_RUNNING`, citação opcional).

## 7. Encaminhar
- Menu da bolha → **"Encaminhar"** → busca de conversas abertas e contatos (mesma busca da "Nova conversa"), um destino por vez.
- `POST /api/messages/:id/forward` `{ chatId }` ou `{ contactId, channelId }` (contato sem conversa aberta → abre uma como a "Nova conversa").
- Reenvia o conteúdo pelo caminho de envio normal do destino: texto → texto; imagem/vídeo/documento/áudio/figurinha → o arquivo salvo (mídia não baixada → 400 "Esta mídia não está disponível para encaminhar"). Notas e mensagens apagadas não são encaminhadas.
- A mensagem nova guarda `forwarded_from_id`; a bolha mostra **"Encaminhada"**. No celular do contato não aparece a marca do WhatsApp (a Evolution 2.3.7 não expõe o "encaminhar" do Baileys).
- Regras do destino valem: `canSee`, conversa aberta, `BOT_RUNNING`.

## 8. Dados
- `messages`: `office_reaction text`, `deleted_at timestamptz`, `deleted_by uuid null → users`, `deleted_source text ('office'|'contact'|'phone')`, `edited_at timestamptz`, `forwarded_from_id uuid null → messages (on delete set null)`.
- `message_edits` (id, message_id → messages cascade, previous_body text, source, edited_by → users set null, edited_at).
- `MessageDto` ganha `officeReaction`, `deleted: { at, source, byName } | null`, `edited: { at, source, newTextUnavailable } | null`, `forwarded: boolean`; `GET /api/messages/:id/edits` → lista de versões.
- Eventos novos `message_deleted` `{messageId, source}` e `message_edited` `{messageId, source}` com textos em `eventText`.

## 9. Interface
- Menu da bolha (hover/toque longo): Reagir · Responder · Encaminhar · Copiar · Editar (quando permitido) · Apagar para todos (quando permitido). Itens fora do prazo aparecem desabilitados com dica ("Só até 15 min após o envio" / "Só até 48 h após o envio").
- Editar abre a bolha em modo edição (Enter salva, Esc cancela).
- Tags discretas na bolha: "Apagada pelo contato", "Apagada por <nome>", "editada", "Encaminhada"; reações abaixo da bolha.

## 10. Testes
- Reação: enviar/remover/trocar; reação do celular do escritório grava `office_reaction`; regras de bloqueio.
- Apagar: dentro/fora das 48 h, só `out`, chamada à Evolution, tag; webhook `messages.delete` do contato e do celular.
- Editar: só autor, só texto/legenda, 15 min, histórico de versões; webhook de edição do contato; formato novo cifrado.
- Figurinhas: lista recente sem repetidos; envio por id e por imagem; JSON base64.
- Encaminhar: texto e mídia, destino sem conversa aberta, mídia indisponível, `BOT_RUNNING`, `canSee` no destino.
- Webhooks: `MESSAGES_DELETE` na lista e atualização das instâncias no boot; `MESSAGES_EDITED` fora.
- Web: menu da bolha com itens habilitados/desabilitados, tags, painel de figurinhas, diálogo de encaminhar.

## 11. Aceite manual
Com o número de teste: reagir e trocar a reação (aparece no celular do contato); apagar uma mensagem (some no celular, tag no sistema); editar dentro de 15 min (muda no celular); o contato apaga e edita uma mensagem (tags no sistema, texto anterior visível); enviar uma figurinha recente e uma imagem como figurinha; encaminhar uma foto para outra conversa.

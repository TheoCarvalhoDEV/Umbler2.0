# Importar do Umbler Talk — design

- **Data:** 21/10/2026 · **Status:** decisões 1–5 do usuário (§2); o resto decidido pelo Claude a pedido do controlador — aguardando revisão desta spec
- **Branch:** `feat/importar-umbler` (a partir de `main` em `87cbb06`) → PR para `main`
- **Base:** núcleo `2026-10-14-nucleo-atendimento-design.md` (esta spec **altera** a linha "Migração" da tabela de decisões: o histórico de conversas deixa de ficar no Umbler), histórico `2026-10-16-historico-whatsapp-design.md` (destino das mensagens, junção LID, mídia "expirada", trabalhador), `2026-10-20-agendamentos-e-regras-design.md` (`chat_tags`, `waiting_since`, regras automáticas) e o importador atual `server/src/importer/umbler.ts` (cadastros e contatos, por linha de comando).
- **Fontes da API:** `docs/umbler/utalk-openapi-v1.json` (OAS 3.0.4, 198 rotas, base `https://app-utalk.umbler.com/api`, Bearer JWT), `MODELO-DE-DADOS.md`, `ENDPOINTS-INTERNOS.md`, `MAPA-UMBLER-TALK.md` (Finalizados ≈ 9440, Contatos ≈ 2368).

## 1. Objetivo
Trazer **tudo** o que o escritório tem no Umbler Talk para o sistema novo antes de cancelar a assinatura: contatos com etiquetas, campos e observações; setores, etiquetas, campos, respostas rápidas e atendentes; e **todas as conversas**, abertas e finalizadas, com mensagens, notas internas e arquivos. Hoje só existe o importador de cadastros por linha de comando (`npm run import:umbler`); ele vira esta tela e ganha atendentes, notas e conversas.

## 2. Decisões do usuário (obrigatórias)
1. Importar **tudo** o que existe no Umbler, sem limite de período.
2. **Separação mantida:** conversa **aberta** no Umbler no momento da importação chega **aberta** (mesmo setor, mesmo atendente, "esperando" quando for o caso); conversa **finalizada** chega **finalizada** (aba Finalizados, com as datas originais). Vêm também setores, atendentes, etiquetas (do contato e da conversa), respostas rápidas, campos personalizados e observações do contato.
3. Acesso por um **token de acesso** que o admin gera no Umbler (**Perfil → Tokens de acesso**) e coloca no `.env` do servidor. Nunca na tela, nunca em log, nunca em conversa.
4. Tela **"Importar do Umbler"** em Ajustes (só admin): passo 1 **"Analisar"** mostra o que foi encontrado e o mapeamento proposto; o admin confirma; passo 2 roda em segundo plano, com progresso, retoma sozinho depois de um reinício e termina com um relatório.
5. Roda primeiro no **ambiente de teste**; em produção, **no dia da virada**.

## 3. Regras gerais
- **Só `GET` no Umbler.** O cliente HTTP do importador só sabe fazer `GET` (não recebe método); um teste varre `server/src/importer/` e falha se aparecer `POST|PUT|PATCH|DELETE` numa chamada ao Umbler (mesmo estilo do teste que proíbe `UPDATE` em `bot_versions`). O token **não tem escopo** na API pública (só Bearer; nenhum schema de permissão de token): "somente leitura" é garantido por este cliente, não pelo Umbler.
- Nunca chama `GET /v1/chats/{id}/` (é o que o app do Umbler chama ao **abrir** uma conversa) nem `/v1/messages/{id}/` (o mesmo `MessageModel` já vem em `relative-messages`; chamar por mensagem seriam centenas de milhares de requisições).
- Logs só com ids do Umbler, ids nossos, contagens, fase e código do erro; nunca texto, telefone, nome, e-mail, URL de arquivo ou o token. Erros guardam `status` + rota em forma de modelo (`GET /v1/chats/{chatId}/relative-messages/ → 500`).
- Importação **nunca** conta como não lida (exceto o `totalUnread` de conversa aberta, §7.6), nunca entra em triagem, nunca dispara bot, `startChannelBot`, `resumeOnReply`, aviso ou envio ao WhatsApp.
- Migração gerada pelo drizzle-kit (`0010_importar_umbler`, depois da `0009_compromissos`), nunca editada à mão. Nenhuma dependência nova (o servidor falso dos testes usa `node:http`). Textos em pt-BR; identificadores em inglês; cores só pelos tokens do tema.
- `server/src/importer/cli.ts` e o script `import:umbler` saem; `docs/IMPLANTACAO.md` §5 é reescrita para a tela (§13).

## 4. API do Umbler: o que usamos
Todas as chamadas levam `organizationId` (o `organizations[0].id` de `/v1/members/me/`; o escritório tem uma organização). Listas paginadas usam `Skip`/`Take` (padrão 50; o máximo real vem em `page.maxTake`) e a resposta `{ page: { totalItems, skipped, took, maxTake }, items }`; pedimos `Take=50` e paramos na primeira página vazia (como o importador atual). Limite documentado: **100 GET a cada 5 s** por rota.

| Chamada | Paginação | Campos que mapeamos |
|---|---|---|
| `GET /v1/members/me/` | — | `organizations[].id`, `name`, `permissions` (`Owner`/`Admin`/`Operator`/`Member`), `allowedSectors.allSectorsEnable`, `allowedChannels.allChannelsEnable` |
| `GET /v1/organizations/{id}/` | — | **atendentes**: `organizationMembers[]` com `_t = OrganizationHumanAgentReferenceModel` (`id`, `displayName`, `emailAddress`, `active`); `OrganizationAIAgentReferenceModel` é ignorado. `maxDaysMessageHistoric` (limite de histórico do plano). **Não existe rota pública que liste atendentes** (só `/members/me/` e `/members/online/`); `organization-invites` lista só convites pendentes. |
| `GET /v1/channels/` | lista | `id`, `_t`, `name`, `state`, `phoneNumber` (tipos WhatsApp) |
| `GET /v1/sectors/` | lista | `id`, `name`, `default`, `order` |
| `GET /v1/tags/` | Skip/Take | `id`, `name`, `emoji`, `color` (enum `TagColor` → `tagColorHex`), `order` |
| `GET /v1/custom-field-definitions/` | lista | `_t` (tipo), `id`, `name` |
| `GET /v1/quick-answers/?viewFrom=Everyone` e `/{id}/` | Skip/Take | `name`, `content`, `variables[].defaultValue`, `attachment.url`/`originalName`, `organizationMember.id` |
| `GET /v1/contacts/?includeGroups=false&State=All&includeCustomFields=<ids>` | Skip/Take | `id`, `name`, `phoneNumber`, `lid`, `email`, `landline`, `address`, `isBlocked`, `contactType`, `tags[].id`, `customFields[]` (`customFieldDefinitionId`, `value`/`values`) |
| `GET /v1/contacts/{id}/notes/` | lista | `id`, `content`, `pinned`, `createdBy` (id do atendente), `createdAtUTC` |
| `GET /v1/contacts/{id}/chats/?ChatState=…` | Skip/Take | só no teste de leitura e na conferência de não lidas (§5) |
| `GET /v1/chats/` | Skip/Take | ver abaixo |
| `GET /v1/chats/{chatId}/relative-messages/` | `FromEventUTC` + `Direction=TakeAfter` + `Take=250` (**máximo 250**) | ver abaixo |

- **Lista de conversas:** `ContactTypes=DirectMessage` (fora grupos, conversas de equipe, IA, sandbox), `Visibility=Show&Visibility=Hide&Visibility=HideUntilNextMessage` (sem isso as ocultas podem ficar de fora), `IncludePinneds=false` (o padrão `true` mistura as fixadas do dono do token), abertas `ChatState=Open&ChatOrderBy=CreatedAtUTC&Order=Asc`, finalizadas `ChatState=Closed&ChatOrderBy=ClosedAtUTC&Order=Desc` (o padrão da rota é `Open`). `DateStartCreatedAtUTC`/`DateEndCreatedAtUTC` não são usados (tudo, decisão 1). No Analisar, a primeira página de cada lista usa `Behavior=CountAllAndGetSlice` para ler `page.totalItems` e conferir com o que foi percorrido (as demais, o padrão `GetSliceOnly`). Campos (`BasicChatModel`): `id`, `createdAtUTC`, `contact` (`id`, `name`, `phoneNumber`, `lid`, `contactType`), `channel` (`id`, `_t`, `phoneNumber`), `sector.id`, `organizationMember.id` (dono atual), `tags[].id`, `open`, `private`, `waiting`, `waitingSinceUTC`, `totalUnread`, `closedAtUTC`, `closedBy.id`, `redactReason`, `lastMessage.source`/`messageState`.
- **Mensagens:** primeira página `FromEventUTC=2000-01-01T00:00:00Z`; a seguinte começa no `eventAtUTC` da última recebida **menos 1 ms** (não se sabe se o limite é inclusivo), descartando ids já vistos; termina quando a página traz menos de 250 itens ou nenhum id novo. `IncludeMetadata=false` (padrão: eventos da linha do tempo não vêm, §16). Itens com `_t` diferente de `MessageModel`/`SentMessageModel` são ignorados; a ordem é refeita por `eventAtUTC` e `id`. Campos: `id`, `eventAtUTC` (**"a hora informada pelo provedor"**, isto é, a do WhatsApp), `chat.id`, `source` (`Contact`/`Member`/`External`/`Bot`), `isPrivate` (nota interna, "visível só para atendentes"), `messageType`, `content`, `prefix` (assinatura guardada à parte), `file` (`url`, `contentType`, `originalName`, `originalSizeBytes`, `caption`, `failDownload`), `sentByOrganizationMember.id`, `inReplyTo.id`, `messageState`, `latestEdit.senderAtUTC`, `reactions[]` (`emoji`, `source`, `eventAtUTC`), `location`, `contacts[]`. A resposta traz `hasMessagesBeforeAllowedOrganizationPlan` (o plano esconde mensagens antigas).
- Todas essas rotas estão marcadas como estáveis na spec (nenhuma tem o aviso "not marked as stable").

### 4.1 O que a spec não dá, e o que fazemos
- **Id da mensagem no WhatsApp: não existe.** `MessageModel` não tem `key.id`/wamid; o único campo parecido, `latestEdit.msgKey`, é de edição e sem descrição. A deduplicação com o histórico do WhatsApp é por contato + direção + tipo + texto + hora (§8).
- **401 e 429 não estão documentados** (só 200/400/404/500), nem `Retry-After`. Tratamos pelo status HTTP (§9.4) e usamos `Retry-After` quando vier.
- **Validade dos links de arquivo** (`utalk-wamedia.s3.amazonaws.com/<org>/<chat>/<hash>`, públicos) não está documentada: baixamos todos durante a importação, antes de cancelar o Umbler.
- **Visibilidade da resposta rápida** ("Para todos"/"Apenas para mim") não tem campo: inferimos "apenas para mim" quando `organizationMember` vem preenchido (conferir no ensaio, §15).
- Se `includeCustomFields` não trouxer `customFields` na lista de contatos, o importador cai para `GET /v1/contacts/{id}/custom-fields/` por contato (≈2,4 mil requisições a mais).

## 5. Efeitos na conta do Umbler (o escritório continua usando)
- **Nenhum `GET` documentado muda estado.** Marcar como lida é uma rota própria, `PUT /v1/chats/{id}/read/` ("marca a última mensagem como lida"), que nunca chamamos; o mesmo para `unread`, `pin`, `redownload-media`, `transcribe`, `favorite`. `ActivityLogType` só tem tipos de alteração (nenhum de leitura); chamadas com token aparecem como `authSource = PAT` só quando alteram algo.
- **Risco não documentado:** a organização tem `adminViewingBehavior.adminMarkChatAsRead`, então o app pode marcar como lida quando um admin abre a conversa, e não se sabe se quem marca é o próprio `GET /chats/{id}/` (a captura de 14/10 registrou só essa chamada ao abrir uma conversa, `ENDPOINTS-INTERNOS.md`) ou uma chamada separada. Por isso nunca usamos essa rota, e conferimos:
  1. **Teste de leitura no "Analisar":** escolhe a conversa **finalizada** mais recente cuja `lastMessage` é do contato com `messageState = Received` (nunca lida); lê suas mensagens com `relative-messages` (a mesma chamada da importação) e relê a conversa por `GET /v1/contacts/{id}/chats/?ChatState=Closed`. Se `messageState` ou `totalUnread` mudar, o "Importar" fica **bloqueado** (§6.3). Usa uma finalizada de propósito: se marcar, ninguém no escritório vê diferença. Sem candidata, o teste fica "não feito" e vale só a conferência 2.
  2. **Conferência na importação:** as conversas abertas são copiadas primeiro as sem não lidas e depois as com `totalUnread > 0`; depois de copiar cada uma destas, relê por `GET /v1/contacts/{id}/chats/?ChatState=Open` e, se o `totalUnread` caiu sem mensagem nova de atendente, a importação **para** com `umbler_marked_read` (no máximo uma conversa afetada).
- Ritmo bem abaixo do limite (10 GET/s, metade do documentado) para não atrapalhar quem usa o Umbler no ensaio.
- O token é de um usuário; chamadas de API não abrem "instância do app", então não devem disparar a tela "sendo utilizado em mais de um dispositivo" — conferido no aceite (§15).

## 6. Tela "Importar do Umbler"
Em **Ajustes**, grupo "Equipe e cadastros", item **"Importar do Umbler"** (`/configuracoes/importar-umbler`, só admin; agente recebe 403 no servidor). Usa `PageHeader`, `SettingsSection`, `SettingRow`, `block`, `ErrorText`, `btnPrimary`/`btnSecondary` de `components/settings/common.tsx`. Enquanto analisa ou importa, a tela consulta `GET /api/umbler-import` a cada 3 s (sem evento novo de WS).

### 6.1 Estados
- **Sem token:** "Token do Umbler não configurado. Coloque `UMBLER_TOKEN` no arquivo `.env` do servidor e reinicie o sistema." Botão "Analisar" desabilitado. Com token: "Token do Umbler configurado." (nunca mostra nenhuma parte do token).
- **Analisando:** "Analisando o Umbler… N conversas lidas" (leva ~1 min: só listas, sem mensagens).
- **Analisado:** seções abaixo + botões **"Analisar de novo"** e **"Importar"** (confirmação: "Importar N contatos e N conversas do Umbler? A cópia roda em segundo plano e pode levar algumas horas." / "Importar").
- **Importando:** "Etapa 3 de 5: conversas abertas — 120 de 135"; contadores (contatos, conversas, mensagens, notas, arquivos baixados/indisponíveis, casadas com o histórico do WhatsApp); "Pode fechar esta tela: a importação continua no servidor e retoma sozinha se o sistema reiniciar."
- **Falhou:** "A importação parou: <motivo>. O que já entrou fica." Botão **"Continuar"**.
- **Concluída:** "Importação concluída em dd/mm/aaaa hh:mm (duração h min)." + relatório (§6.4) + "Analisar de novo" (uma nova execução só traz o que falta, §9.2).

### 6.2 "O que foi encontrado" e mapeamento proposto
- **Contagens:** contatos (novos / já existem aqui / sem telefone nem LID, que não vêm), conversas abertas (das quais "esperando"), conversas finalizadas, período ("de dd/mm/aaaa a dd/mm/aaaa", pelo `createdAtUTC`), setores, etiquetas, campos (e os não suportados, pelo nome), respostas rápidas, atendentes. Observações dos contatos são contadas só na importação (exigem uma chamada por contato).
- **Canais** (uma linha por canal do Umbler: nome, tipo, número, nº de conversas) → seletor com os nossos canais e **"Não importar"**. Proposta: o canal com o **mesmo número** (`normalizePhoneBR`). Um canal de WhatsApp do Umbler **sem número igual aqui** (número antigo do escritório) vai, por padrão, para o **canal oficial** (decisão do usuário em 21/10, §18), com o aviso "As conversas do número <número antigo> entram no canal <nome>; respostas a elas saem do número oficial". O admin ainda pode escolher "Não importar". No ensaio o admin escolhe o canal de teste de propósito. Canal que não é WhatsApp (Webchat, Instagram): fixo em "Não importar".
- **Setores** → seletor com os nossos setores e **"Criar setor “<nome>”"**. Proposta: mesmo nome (sem espaços nas pontas, sem diferenciar maiúsculas); senão criar.
- **Atendentes** (nome, e-mail, ativo no Umbler, nº de conversas) → seletor com os nossos usuários, **"Criar usuário inativo"** e **"Sem atendente"**. Proposta: usuário com o **mesmo e-mail** (sem diferenciar maiúsculas); senão "Criar usuário inativo" (§7.2).
- Etiquetas, campos e respostas rápidas não têm seletor: casam pelo nome, como hoje ("N novas, M já existem").

### 6.3 Avisos e bloqueios
- **Bloqueia "Importar":** regras automáticas ligadas ("Desligue as Regras automáticas antes de importar: elas finalizariam ou devolveriam à fila as conversas abertas importadas e poderiam enviar a mensagem de encerramento a clientes."); teste de leitura marcou como lida ("A leitura marcou uma conversa como lida no Umbler. A importação foi bloqueada para não alterar o Umbler."); token recusado.
- **Avisa (não bloqueia):**
  - token de usuário que não é Proprietário/Admin com todos os setores e canais: "O token é de um usuário sem acesso a tudo: gere o token com o Proprietário.";
  - `redactReason` preenchido em N conversas: "N conversas vêm sem conteúdo para este token.";
  - limite do plano (`maxDaysMessageHistoric` ou `hasMessagesBeforeAllowedOrganizationPlan`): "O plano do Umbler mostra só os últimos N dias de mensagens; as anteriores não vêm.";
  - canal de destino com número diferente do Umbler: "Respostas nessas conversas sairão do número <número do canal daqui>.";
  - canal em "Não importar": "N conversas deste canal não vêm.";
  - teste de leitura sem conversa candidata: "Não houve conversa para o teste de leitura; a importação confere as abertas durante a cópia.";
  - sempre: "Espaço livre para arquivos: N GB."
- Uma importação do histórico do WhatsApp rodando não bloqueia: a cópia do Umbler espera ela terminar (§9.3).

### 6.4 Relatório final
Guardado em `umbler_imports.report` e mostrado na tela; por item, criados / já existiam / ignorados com o motivo:
- setores, etiquetas, campos (os não suportados pelo nome), atendentes (vinculados, criados inativos, sem atendente);
- respostas rápidas (variáveis não convertidas e anexos que falharam, pelo nome da resposta);
- contatos (criados, completados, só LID, ignorados sem telefone nem LID — só a contagem) e observações;
- conversas abertas (criadas, **juntadas a uma conversa aberta daqui**), finalizadas, ignoradas (canal "Não importar", sem mensagens, apagadas aqui);
- mensagens (texto, notas, de chatbot, de atendente desconhecido, sem conteúdo para o token) e **casadas com o histórico do WhatsApp**, com a maior diferença de horário entre as casadas, em segundos;
- arquivos (baixados, total em GB, indisponíveis); aviso de limite do plano; duração.

## 7. Mapeamento
### 7.1 Cadastros (fase 1, uma transação, como hoje)
Setores, etiquetas, campos e respostas rápidas pelas funções atuais de `importer/umbler.ts`, com duas mudanças: nome comparado sem diferenciar maiúsculas; e resposta rápida com `organizationMember` ligado a um usuário **ativo** vira `visibility='owner'` desse usuário (as demais continuam `'all'`, como hoje). Campos de tipo não suportado (lógico, listas, opções, referências, arquivos) continuam fora e listados.

### 7.2 Atendentes
- Vinculado por e-mail ou escolhido → usa o usuário existente; nada nele muda (setores, papel, senha).
- **"Criar usuário inativo" (decisão):** `name` = `displayName` (senão o e-mail), `email` = e-mail do Umbler, `role='agent'`, `active=false`, `passwordHash` = hash de 32 bytes aleatórios que ninguém conhece, sem setores. Motivo: as ~10 mil conversas finalizadas guardam quem atendeu e quem escreveu cada mensagem; com "Sem atendente" isso some para sempre quando o Umbler for cancelado (as bolhas viram "Celular ou sistema" e o filtro de atendente não acha nada). O inativo não entra no sistema, não recebe conversas e pode ser ativado em Ajustes › Atendentes se a pessoa voltar — é como o sistema já trata ex-funcionários.
- "Sem atendente" → dono e autor nulos.
- Atendente que aparece em conversas mas não está mais na organização (removido do Umbler) e agentes de IA → sem dono/autor; contados no relatório.

### 7.3 Canais
Conversa de canal "Não importar" ou de canal que não é WhatsApp é ignorada (contada). O canal de destino recebe a conversa como se fosse dele (`chats.channel_id`, `messages.channel_id`).

### 7.4 Contatos (fase 2, lotes de 100 por transação)
- Mesmo casamento de hoje (telefone primeiro, depois LID) e "só preenche o que está vazio". Mudança: contato sem telefone válido **mas com LID** entra como contato só-LID (como no histórico §5.4), em vez de ser pulado; sem telefone nem LID, fica de fora (contado).
- Contato do Umbler com telefone **e** LID alimenta `mergeLidPairs`: um contato só-LID que o histórico do WhatsApp criou é juntado ao do telefone antes das conversas (evita duplicar mensagens, §8).
- Etiquetas → `contact_tags`; campos → `contact_field_values`; `isBlocked` → `blocked` só em contato novo. Registro em `umbler_map` (`contact`).
- Contato que só aparece numa conversa (não veio na lista) é criado na hora com os dados de `chat.contact`.

### 7.5 Observações do contato (fase 4)
Uma chamada `GET /v1/contacts/{id}/notes/` por contato importado → `contact_notes` (`body`=`content`, `pinned`, `created_at`=`createdAtUTC`, `author_id` = atendente mapeado de `createdBy`). Cada nota em `umbler_map` (`note`); o contato ganha `done_at` quando suas notas terminam.

### 7.6 Conversas (fases 3 e 5)
- **Aberta, sem conversa aberta do contato no canal:** cria `state='open'`, `sector_id` = setor mapeado (sem setor → padrão), `owner_id` = usuário mapeado se **ativo** (inativo ou "Sem atendente" → sem atendente, vai para a fila do setor), `waiting` = `waiting`, `waiting_since` = `waitingSinceUTC` (sem valor: hora da última mensagem do contato), `private` = `private`, `unread` = `totalUnread`, `triage_pending=false`, `history=false`, `created_at` = `createdAtUTC`.
- **Aberta, com conversa aberta do contato no canal aqui (decisão: junta):** o índice `chats_one_open_per_contact_channel` não permite duas. As mensagens do Umbler entram **na conversa daqui**, que mantém setor, dono, privacidade e `waiting` (ela é a atual); `unread` soma o `totalUnread` do Umbler (como `merge.ts`); etiquetas da conversa são unidas; evento `umbler_imported { count, merged: true }`. O `umbler_map` aponta a conversa do Umbler para a daqui, e reexecuções caem nela.
- **Finalizada:** cria `state='closed'`, `created_at` = `createdAtUTC`, `closed_at` = `closedAtUTC`, setor e dono mapeados (inativo vale aqui), `private`, `unread=0`, `waiting=false`, `history=false`; evento `closed` em `closed_at` com autor = `closedBy` mapeado ("Conversa finalizada por X"). Aparece em **Finalizados** com as datas originais e segue a barreira de setor e a privacidade como no Umbler (diferente das conversas de histórico do WhatsApp, visíveis a todos).
- Em todas: `chat_tags` com as etiquetas da conversa; evento `umbler_imported { count }` em `created_at` ("Conversa importada do Umbler Talk: N mensagens"); `last_message_at`/prévia = a mensagem mais nova que não é nota. Conversa sem nenhuma mensagem é ignorada (contada). Conversa privada cujo dono ficou inativo continua privada (só admins com "ver todos" a veem). Conversa oculta no Umbler (`visibility = Hide`/`HideUntilNextMessage`) vem normal: não há "ocultar" aqui.
- Conversa apagada aqui pelo admin não volta: se o `umbler_map` aponta para uma conversa que não existe mais, ela é pulada; para conversas novas vale a lápide `deleted_chats` como no histórico (mensagens até `until` são puladas).
- Abertas importadas publicam `chat.updated` ao terminar (aparecem na Entrada); finalizadas não publicam (a lista busca ao abrir).

### 7.7 Mensagens
- `direction`: `source=Contact` → `in`; `Member`, `Bot`, `External` (enviada pelo celular fora do Umbler) → `out`. `sent_at` = `created_at` = `eventAtUTC`. `external_id` nulo (a API não dá). `status`: `Read`/`Played` → `read`, `Received` → `delivered`, `Failed`/`Error` → `failed`, demais → `sent`.
- **Nota interna** (`isPrivate=true`) → `kind='note'`, `out`, autor mapeado, `status='sent'`, como as notas daqui; nunca casada com o WhatsApp.
- **Autor:** `sentByOrganizationMember` mapeado; chatbot e celular ficam sem autor e aparecem como "Celular ou sistema" (o nome do bot do Umbler não é guardado; ver §16).
- **Texto:** `out` com `prefix` → `formatSignature(content, prefix)` (`*prefix:*\n` + texto, exatamente o que o cliente recebeu e como guardamos os envios daqui); senão `content`. Mídia: legenda = `file.caption ?? content`.
- **Tipo:** `Text`, `Url`, respostas de lista/botão (`ListReply`, `ButtonReply`, `QuickReply`) e perguntas do bot com texto → `text`; `Image`/`Gif` → `image`; `Video` → `video`; `Audio` → `audio`; `Sticker` → `sticker`; `File` → `document`; **`Location` → `text` "Localização: <nome ou endereço> https://maps.google.com/?q=<lat>,<long>"** e **`Contact` → `text` "Contato: <nome> <telefones>"** (decisão: depois do cancelamento essa informação não existiria em lugar nenhum); `Payment`, `Order`, `Poll`, `Carousel`, `CallAttempt`, `Unsupported` → `unsupported` com `content` quando houver. Itens `Reaction` soltos são ignorados.
- **Reações:** a mais recente de `reactions[]` com `source=Contact` → `reaction`; a mais recente de `Member`/`External` → `office_reaction`.
- **Resposta a mensagem:** `inReplyTo.id` → `reply_to_id` se a mensagem citada já foi importada (qualquer conversa); senão nulo.
- **Apagada** (`messageState=Deleted`): `deleted_at` = `eventAtUTC`, `deleted_source` = `contact` (in) ou `office` (out), texto mantido se vier. **Editada** (`Edited`): `edited_at` = `latestEdit.senderAtUTC ?? eventAtUTC`, sem `message_edits` (o texto anterior não vem). `Redacted` → `unsupported` sem texto (contada).

### 7.8 Arquivos
- Por página de mensagens: (1) decide o que é novo e o que casa (§8) só lendo o banco; (2) baixa os arquivos das mensagens novas e das casadas que não têm arquivo, até **4 ao mesmo tempo**, `GET` na `file.url` **sem** o cabeçalho de autorização (o token nunca sai de `app-utalk`), timeout 60 s, até **64 MB** (o limite do envio); (3) grava a página numa transação, já com `media_path` (`saveMedia`, com `media_sha256`). Não usa a fila de mídia do histórico (ela baixa pela Evolution por `external_id`).
- `file.url` nulo ou `failDownload=true`, HTTP 403/404/410, acima de 64 MB, ou erro temporário (5xx, rede, timeout) depois de 3 tentativas (1 s, 5 s, 25 s) → `media_status='expired'`, a bolha mostra o mesmo "Arquivo não está mais disponível…" do histórico; contado. Uma nova execução tenta de novo os indisponíveis de mensagens já mapeadas.
- **Ganho:** mensagem casada com o histórico do WhatsApp cuja mídia já tinha expirado lá (mais de 21 dias) recebe o arquivo guardado pelo Umbler.
- Antes de cada arquivo confere o espaço livre (`fs.statfs` em `MEDIA_DIR`); abaixo de 2 GB a importação para com `disk_full`.

## 8. Deduplicação com o histórico do WhatsApp
Os últimos ~3,5 meses existem nos dois lados: no Umbler e no histórico que o celular manda ao ler o QR (spec de 16/10). Sem id do WhatsApp (§4.1), uma mensagem do Umbler **casa** com uma linha nossa quando, ao mesmo tempo:
1. mesmo **contato** (nosso) e mesmo **canal**, em qualquer conversa dele nesse canal;
2. mesma **direção** e mesma **classe**: texto (`text`), mídia (`image|video|audio|document|sticker`; um GIF é imagem no Umbler e vídeo no WhatsApp) ou outros (`unsupported`); localização e cartão de contato do Umbler comparam como `unsupported` sem texto (é como o parser daqui os guarda) e, ao casar, a linha nossa recebe o texto gerado da §7.7; a linha nossa não é nota e ainda não está em `umbler_map`;
3. **texto normalizado igual**: `stripSignature` (tira a linha `*…:*` do começo), Unicode NFC, `\r\n` → `\n`, sem espaços nas pontas; compara-se o SHA-256 desse texto (mídia sem legenda = texto vazio);
4. `|eventAtUTC − sent_at| ≤ 10 s` (constante `MATCH_WINDOW_MS = 10_000`, o "botão de calibragem": o relatório mostra a maior diferença encontrada).
- **Pares um a um:** as mensagens do Umbler são percorridas em ordem de hora; cada uma fica com a candidata livre de menor diferença (empate: a mais antiga). Rajadas de textos iguais ("ok", "ok") casam par a par. Limite conhecido: num álbum de fotos sem legenda enviado no mesmo segundo a ordem das fotos pode trocar; o arquivo de cada linha continua o dela.
- **Efeito no Umbler → nossa linha:** nada é inserido; a linha existente fica (id, `external_id`, status, arquivo) e ganha: `chat_id` = a conversa importada a que ela pertence (se for outra), `author_id` = atendente mapeado (se estava nulo), registro em `umbler_map`, e o arquivo do Umbler se não tinha (§7.8). A conversa de onde saiu tem `last_message_at`/prévia (e, se for conversa de histórico, `created_at`/`closed_at`) recalculados; conversa de histórico que fica sem mensagens é apagada (`chat.removed`).
- **Ao contrário (WhatsApp → linha do Umbler):** `placeRecords` (importação do histórico e recuperação) passa a usar o mesmo casamento antes de inserir: se acha uma linha que está em `umbler_map` e tem `external_id` nulo, só grava o `external_id` nela e conta como já existente. Cobre a releitura de QR depois da virada, quando o celular manda de novo os ~3,5 meses.
- Notas, mensagens de conversas de canais diferentes e contatos diferentes nunca casam. Contato só-LID ainda não juntado não casa (por isso a junção da §7.4 vem antes).

- **Conversa de histórico que fica vazia** depois do casamento: antes de apagá-la, as mensagens agendadas e os compromissos dela (com os lembretes) passam para a conversa importada, como na junção de contatos com LID (spec dos compromissos §3.8). Nada pendente se perde.

## 9. Execução, idempotência e retomada
### 9.1 Fases (na ordem)
1. **Cadastros** (setores, etiquetas, campos, atendentes, respostas rápidas) — uma transação.
2. **Contatos** — lista inteira, lotes de 100.
3. **Conversas abertas** — todas listadas primeiro; copiadas as sem não lidas e depois as com não lidas (§5).
4. **Observações dos contatos**.
5. **Conversas finalizadas** — da mais recente para a mais antiga.

As abertas vêm cedo para o escritório trabalhar já no dia da virada; as finalizadas mais recentes, que são as mais consultadas, vêm antes das antigas.

### 9.2 Nunca duplica
- Tabela `umbler_map (kind, umbler_id) → local_id`, `kind` em `contact|note|chat|message`; cadastros casam por nome e atendentes por e-mail, então não precisam de mapa. Toda inserção consulta o mapa antes e grava o par na mesma transação da linha.
- `done_at` no mapa: contato com observações copiadas; conversa com todas as mensagens e arquivos copiados.
- **Reexecução ("Analisar de novo" + "Importar"):** finalizada com `done_at` é pulada sem chamada de mensagens; aberta com `done_at` é relida a partir da última mensagem importada (−1 ms) e só acrescenta o que falta. Decisão: reexecução **nunca muda** estado, setor, dono ou etiquetas de conversa já importada (ela pode ter sido trabalhada aqui).

### 9.3 Trabalhador e retomada
- Terceiro laço do `createHistoryWorker` (ao lado da fila de mídia), com o mesmo `AbortController`: pega a linha `analyzing` ou `running` de `umbler_imports` e avança página a página; para entre páginas no `stop()`. Todo estado está no banco: depois de um reinício, a linha continua `running` e o laço recomeça a fase gravada, pulando o que está no mapa (contatos e listas são baratos de reler; mensagens de conversa sem `done_at` são relidas e as já mapeadas descartadas).
- Antes de cada conversa espera enquanto houver uma importação do histórico do WhatsApp `running` (as duas escrevem nas mesmas conversas; o casamento supõe uma de cada vez). Limite conhecido: a recuperação de 5 min (§6 do histórico) não espera; ela só copia os últimos ~40 min, que o Umbler parado não tem.
- Uma só importação ativa por vez (índice único parcial em `analyzing|running`) → 409 "Já existe uma importação do Umbler em andamento".
- Progresso gravado a cada página (`progress` jsonb); transações curtas, sem `hub` por mensagem.

### 9.4 Ritmo e erros do Umbler
- Intervalo mínimo de **100 ms** entre chamadas à API (10/s; hoje 50 ms), uma por vez; `redirect: 'error'` (o token não segue redirecionamento); timeout de 30 s por chamada.
- **429:** espera o `Retry-After` se vier; senão 5, 10, 20, 40, 60, 60, 60 s; na 8ª recusa para com `umbler_429`. **401/403:** para na hora com `umbler_token`. **5xx, rede, timeout:** 3 tentativas (2 s, 10 s, 30 s), depois para com `umbler_unavailable`. **404** em notas ou mensagens de um item (apagado no Umbler durante a cópia): pula o item e conta. **400:** para com `umbler_400` (erro nosso na consulta).
- Parada = `failed` com o código; "Continuar" volta a `running` na mesma fase, com os mesmos contadores. Textos (`UMBLER_IMPORT_ERRORS`):
  - `umbler_token`: "O Umbler recusou o token (expirado ou apagado). Gere outro, troque `UMBLER_TOKEN` no .env e reinicie o sistema."
  - `umbler_429`: "O Umbler limitou as requisições. Clique em Continuar daqui a alguns minutos."
  - `umbler_unavailable`: "O Umbler não respondeu. Clique em Continuar para tentar de novo."
  - `umbler_marked_read`: "Uma leitura marcou conversa como lida no Umbler; a importação parou por segurança."
  - `disk_full`: "Pouco espaço em disco para os arquivos (menos de 2 GB)."
  - `umbler_400`: "O Umbler recusou uma consulta do importador. Avise o suporte técnico."

## 10. Dados e API
- `umbler_imports`: `id`, `state` (`analyzing|analyzed|running|done|failed`), `phase` (`catalog|contacts|open_chats|notes|closed_chats`), `analysis jsonb` (contagens, propostas, avisos, resultado do teste de leitura), `mapping jsonb` (canal/setor/atendente do Umbler → id nosso, `'create'` ou `'none'`), `progress jsonb`, `report jsonb`, `error` (só o código), `created_by → users (set null)`, `started_at`, `finished_at`, `updated_at`.
- `umbler_map`: `kind`, `umbler_id`, `local_id uuid`, `done_at`; chave `(kind, umbler_id)`, índice `(kind, local_id)`; sem chave estrangeira (id local que sumiu = "apagado aqui").
- `ChatEventKind` ganha `umbler_imported` (`{ count, merged? }`): "Conversa importada do Umbler Talk: N mensagens" / "N mensagens de uma conversa aberta no Umbler Talk juntadas a esta".
- Config: `UMBLER_TOKEN` opcional (vazio = ausente) em `config.ts` (`umblerToken: string | null`; `prettifyError` nunca mostra o valor) e em `docker-compose.yml` (`UMBLER_TOKEN: ${UMBLER_TOKEN:-}`); `.env.example` ganha a linha comentada. Nunca vai para DTO, banco, relatório ou log.
- `shared`: `UmblerImportState`, `UmblerImportPhase`, `UmblerAnalysisDto`, `UmblerMappingDto`, `UmblerImportDto`, `UMBLER_IMPORT_ERRORS` (código → texto da §9.4).
- Rotas (admin; agente 403; não-GET com checagem de Origin):
  - `GET /api/umbler-import` → `{ tokenConfigured: boolean, current: UmblerImportDto | null }` (a mais recente);
  - `POST /api/umbler-import/analyze` → cria `analyzing` (400 "Token do Umbler não configurado"; 409 se houver ativa);
  - `POST /api/umbler-import/:id/start` `{ mapping }` → só de `analyzed`; valida que todo canal/setor/atendente tem destino e os bloqueios da §6.3 (regras de novo na hora) → `running`;
  - `POST /api/umbler-import/:id/resume` → só de `failed`; mesmos bloqueios → `running`.
- Arquivos: `importer/umbler.ts` (cliente e cadastros, já existe), `importer/job.ts` (análise, fases, retomada), `importer/chats.ts` (conversas e mensagens), `importer/match.ts` (casamento, usado também por `history/place.ts`).

## 11. Desempenho (~10 mil conversas, ~2,4 mil contatos)
- Chamadas: análise ≈ 300 (listas de contatos e conversas); importação ≈ 50 (contatos) + 2,4 mil (observações) + 200 (listas de conversas) + ≥ 1 por conversa (até 250 mensagens por chamada) ≈ **13 mil chamadas ≈ 22 min** a 10/s. Arquivos vão direto ao S3, 4 por vez, fora desse limite; o tempo deles depende do volume, que o ensaio mede e o relatório mostra.
- Banco: uma transação por página (≤ 250 mensagens); o casamento consulta só as conversas do contato no canal na janela da página (índice `messages_chat_sent_idx`); memória limitada a uma página + mapas de cadastro.
- O escritório trabalhando ao mesmo tempo: transações curtas, nenhuma chamada ao Umbler dentro de transação, `chat.updated` só para conversas abertas.

## 12. LGPD e segurança
- Mesmos dados, mesmo controlador (o escritório), saindo de um operador (Umbler) para o sistema próprio; ficam sob as regras de backup/LGPD do núcleo. Arquivos em `MEDIA_DIR` como os do dia a dia.
- Token só no `.env` (gerado com `chmod 600`); depois da importação conferida: apagar o token no Umbler, tirar `UMBLER_TOKEN` do `.env` e reiniciar.
- `analysis`/`report` guardam só contagens, nomes de cadastros (setores, etiquetas, campos, respostas), nome/e-mail de atendentes e nome/número dos canais do escritório; **nenhum** nome, telefone ou texto de cliente. `umbler_map` guarda só ids.
- **Ambiente de teste recebe dados reais de clientes:** ele tem de ter a mesma proteção da produção (HTTPS, senhas fortes, acesso restrito) e, depois do aceite, é apagado por inteiro (`docker compose down -v` e a pasta de mídia; procedimento em `IMPLANTACAO.md`). Ninguém responde clientes pelo número de teste (§15).
- Pedido de exclusão de um titular depois da importação: apagar contato/conversas como qualquer outro (as lápides impedem a volta numa reexecução). No Umbler, pedir o encerramento da organização ao cancelar (a API tem `DELETE /v1/organizations/{id}/`, que nunca chamamos).

## 13. Virada
- **Ensaio (ambiente de teste):** token no `.env` de teste → Analisar → canal do Umbler → canal de teste → regras automáticas desligadas → Importar → aceite (§15) → apagar o ambiente.
- **Produção, no dia da virada (ordem recomendada):** 1) fim do expediente no Umbler; anotar as contagens de Entrada/Esperando/Finalizados. 2) Conectar o número oficial aqui (desconecta o Umbler, que fica congelado) e esperar a importação automática do histórico do WhatsApp terminar. 3) Analisar → conferir mapeamento e contagens → Importar. As abertas chegam nos primeiros minutos e o escritório já atende aqui. 4) Relatório conferido → apagar o token → uma semana de consulta → cancelar o Umbler. Se o Umbler deixar de responder à API com o canal desconectado, a ordem inversa (importar antes de conectar, com o escritório parado) também funciona: o casamento da §8 vale nos dois sentidos.
- `IMPLANTACAO.md` §5 vira esse roteiro; a lista de virada troca "Importar os cadastros" por "Importar do Umbler".

## 14. Testes
- **Servidor falso do Umbler** (`server/test/fakes/umbler-api.ts`, `node:http` numa porta aleatória) com os formatos da spec: `members/me`, `organizations/{id}`, `channels`, `sectors`, `tags`, `custom-field-definitions`, `quick-answers` (+ `/{id}`), `contacts` (Skip/Take, `includeCustomFields`), `contacts/{id}/notes`, `contacts/{id}/chats`, `chats` (Skip/Take; confere `ContactTypes`, `Visibility`, `IncludePinneds`, ordem), `relative-messages` (limite inclusivo, `Take ≤ 250`, `hasMessagesBeforeAllowedOrganizationPlan`) e uma rota de arquivo no papel do S3. Grava toda requisição; **todo teste termina conferindo que só houve GET**, nenhuma rota `read|unread|pin` e que a rota de arquivo nunca recebeu `Authorization`. Falhas injetáveis: 401, 429 com e sem `Retry-After`, 500 e depois 200, 404 num item, arquivo lento ou grande, "marcar como lida" ao ler (para o teste de leitura). Nenhuma chamada real; o teste atual de `umbler.test.ts` passa a usar este servidor.
- Cliente: intervalo de 100 ms (relógio falso), esperas do 429, 401 para na hora, `redirect: 'error'`, varredura de métodos em `importer/`.
- Análise: contagens, propostas (setor por nome sem maiúsculas, atendente por e-mail, canal por número), avisos e bloqueios (regras ligadas, teste de leitura, token sem acesso total, limite do plano), teste de leitura feito/não feito.
- Mapeamento: cada campo de §7 (aberta com setor/dono/esperando/não lidas; dono inativo → fila; finalizada em Finalizados com datas e evento `closed`; privada; etiquetas de contato e de conversa; observações com autor; respostas rápidas "apenas para mim"; usuário inativo sem login); tipos de mensagem, nota, chatbot, celular, assinatura, reações, citação, apagada/editada, localização e contato.
- Casamento: igual; 10 s casa e 11 s não; assinatura removida; rajada de textos iguais um a um; nota nunca casa; linha casada muda de conversa, conversa de histórico vazia some, resumos recalculados; mídia expirada recebe o arquivo; sentido inverso pelo `placeRecords` grava só o `external_id`.
- Junção com conversa aberta daqui; lápide e conversa apagada aqui; idempotência (duas execuções = mesmas linhas); retomada (abortar no meio de uma conversa e no meio dos contatos → continuar sem duplicar); finalizada `done_at` sem chamada de mensagens; aberta relida da última mensagem; espera durante importação do histórico.
- Arquivos: 200 salvo; 403/404 e 3×500 → expirada; > 64 MB; pouco disco → `disk_full`.
- Sem efeitos colaterais aqui: nada de triagem, bot, aviso ou envio; `unread` só nas abertas.
- Web: estados da tela (sem token, analisando, analisado com seletores, bloqueios, importando, falhou com "Continuar", concluída com relatório), item só para admin.

## 15. Aceite manual
No ambiente de teste: anotar no Umbler 3 conversas abertas com não lidas (contagem do badge) → token no `.env`, reiniciar → "Token do Umbler configurado." → Analisar → contagens batem com o Umbler (Finalizados ≈ 9440, Contatos ≈ 2368, Entrada/Esperando), teste de leitura "ok" → canal do Umbler → canal de teste, setores/atendentes conferidos → Importar → reiniciar o servidor no meio das finalizadas e ver que continua → ao fim: abertas na Entrada com o mesmo setor, atendente e "esperando"; finalizadas em Finalizados com as datas originais; uma conversa com foto, áudio e PDF abre os arquivos; notas internas e observações aparecem; respostas rápidas com anexo; atendentes antigos como inativos → **no Umbler**, as 3 conversas anotadas continuam com o mesmo badge de não lidas, nada mudou de estado, a tela "mais de um dispositivo" não apareceu, Atividades sem entradas novas do token → relatório revisado → ninguém respondeu cliente pelo número de teste → ambiente apagado. Em produção: o roteiro da §13 e as mesmas conferências por amostragem, mais "casadas com o histórico do WhatsApp" > 0 e uma conversa recente sem mensagens repetidas.

## 16. Fora do escopo (e o que é barato depois)
- **Agentes de IA, bases de conhecimento, transcrição de áudio:** fora por decisão de 14/10 (a transcrição viria de graça em `file.transcription`).
- **Chatbots e fluxos:** fora; o editor daqui é outro e o "Fluxo do escritório" já foi refeito à mão. Caro.
- **Envio de campanha e templates do Umbler:** fora; exigem WhatsApp Business API e o canal daqui é QR. Não se aplica.
- **Avaliações** (`contact-ratings`): fora; não temos o modelo de avaliação. Médio.
- **Mensagens agendadas pendentes no Umbler:** fora (risco de envio em dobro); listar no relatório é barato.
- **Baratos depois:** eventos da linha do tempo (transferências, setor, etiquetas, privacidade — `IncludeMetadata=true` na mesma chamada); mensagens favoritas (`isFavorite` → `message_favorites`); nome do chatbot na bolha (uma coluna `bot_name`).
- Também fora: grupos e conversas de equipe, boards de contatos, horários, grupos de atendentes, biblioteca de mídias, figurinhas, tarefas, variáveis, fotos de perfil (o sistema já busca as do WhatsApp), histórico de edições.

## 17. Riscos
1. **Uma leitura marcar como lida no Umbler** (não documentado): mitigado pelo teste de leitura numa finalizada e pela conferência das abertas com não lidas (§5); pior caso, uma conversa.
2. **Casamento sem id do WhatsApp:** mensagem editada, com formatação diferente ou com mais de 10 s de diferença gera duplicata; texto idêntico pode casar com a "irmã" (inofensivo). O ensaio **não** exercita isso (o canal de teste tem outro número); a conferência é na produção pelo relatório (casadas e maior diferença). Toda linha vinda do Umbler está em `umbler_map`, o que permite achá-las depois.
3. **API com o canal desconectado:** a ordem recomendada supõe que o Umbler continua respondendo depois da desconexão; há a ordem inversa (§13).
4. **Links de arquivo** podem expirar ou sumir no cancelamento: cancelar só depois do relatório conferido.
5. **Limites reais desconhecidos** (`maxTake`, 429, comportamento do 401): o ensaio mede; o cliente trata pelos códigos.
6. **Token sem acesso a tudo** (conversas com `redactReason`, setores/canais restritos): o Analisar avisa com as contagens.
7. **Limite de histórico do plano:** se o plano esconde mensagens antigas, elas não vêm; o Analisar avisa antes.
8. **Volume e disco:** tempo dos arquivos desconhecido até o ensaio; parada `disk_full` antes de encher o disco.
9. **Dados reais no ambiente de teste** e conversas abertas reais com o número de teste: avisos na tela, aceite sem responder, ambiente apagado no fim.
10. **Inferência da resposta rápida "apenas para mim"** por `organizationMember`: conferida no ensaio.

## 18. Respostas do usuário (21/10)
1. **Sim:** o ambiente de teste pode receber os dados reais dos clientes e é apagado por inteiro depois do aceite (§12, §13).
2. **Sim:** na virada, o escritório começa a atender aqui logo depois de conectar o número, com as finalizadas chegando aos poucos (§13, ordem das fases §9.1).
3. **Entram:** as conversas de números antigos do Umbler vêm para o **canal oficial** daqui (proposta padrão no mapeamento de canais, §6.2), mantendo aberta/finalizada como no Umbler; o "Analisar" avisa que as respostas saem do número oficial.
4. **Sim:** ex-atendente sem e-mail correspondente vira **usuário inativo** por padrão (§7.2).

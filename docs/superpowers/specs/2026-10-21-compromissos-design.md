# Compromissos (lembretes automáticos a partir de compromissos cadastrados à mão) — design

- **Data:** 21/10/2026 · **Status:** desenho aprovado pelo usuário no chat (itens 1–7 da conversa); o resto foi decidido pelo controlador (§11) — aguardando revisão desta spec
- **Branch:** `feat/compromissos` (a partir de `feat/agendamentos-e-regras`, a entrega 3, já integrada em `main` pelo PR #24). Migração `0009`, depois da `0008_agendamentos_e_regras`.
- **Base:** mensagens agendadas `2026-10-20-agendamentos-e-regras-design.md` (fuso do escritório, limites de 2 min / 1 ano, máquina de estados, envio como o autor, aviso de falha) e o código atual: `server/src/automation/scheduled.ts`, `server/src/automation/delivery.ts`, `server/src/automation/rules.ts`, `server/src/messages/send.ts`, `server/src/catalog/settings.ts`, `server/src/history/merge.ts`, `shared/src/automation.ts`, `web/src/components/conversation/Scheduled.tsx`, `Composer.tsx`, `ConversationHeader.tsx`, `web/src/pages/ScheduledMessages.tsx`.
- **Plano:** `docs/superpowers/plans/2026-10-21-compromissos.md` (ainda não escrito).

## 1. Objetivo

O escritório marca audiências, perícias, reuniões e retornos de documento com os clientes e hoje lembra cada um à mão, pelo WhatsApp, um ou dois dias antes. Isso falha quando o atendente esquece, sai de férias ou o compromisso muda de data e o lembrete antigo fica valendo.

A mensagem agendada (entrega 3) já envia no horário, como o autor, reabre a conversa e avisa quando falha. Falta o passo de cima: **cadastrar o compromisso uma vez** e deixar que os lembretes saiam sozinhos, e se **recalculem** quando o compromisso muda de horário.

### 1.1 Metas
- Cadastrar um compromisso (cliente, título, data e hora no horário de Cuiabá, observação interna, um ou mais lembretes) na conversa ou numa página própria.
- Cada lembrete vira uma **mensagem agendada comum** em `scheduled_messages`. O envio usa o caminho que já está testado: no horário, como o autor, reabrindo a conversa se preciso, avisando o autor da falha, nunca duas vezes.
- Mudar o horário recalcula os lembretes que ainda não saíram. Cancelar o compromisso cancela esses lembretes. O que já saiu fica no histórico.
- Um texto padrão de lembretes, mantido pelo administrador, já vem preenchido em todo compromisso novo.

### 1.2 Não-metas
- Compromisso recorrente; sincronizar com o Google Agenda; confirmação do cliente por resposta ("1 para confirmar"); enviar uma mensagem a partir do compromisso sem um lembrete (itens do desenho aprovado).
- Mudar o caminho de envio (`delivery.ts` fica como está) e criar um trabalhador novo.
- Editar, incluir ou tirar lembretes de um compromisso já salvo (§11, decisão 3).

## 2. Regras gerais
- Quem não vê a conversa do compromisso (`canSee`, que já cobre a conversa privada: só o dono e o administrador com "Ver todos os setores") recebe **404**. Toda mutação nova é uma rota `/api/*` não-GET (checagem de Origin global, sem Origin → 403).
- Logs nunca levam título, observação, texto de lembrete, telefone ou nome: só ids, contagens e o nome/código do erro.
- Migração gerada pelo drizzle-kit (`npm run db:generate -w server -- --name compromissos` → `0009_compromissos.sql`), nunca editada à mão.
- Campos novos nos DTOs que já existem são opcionais (literais antigos continuam compilando; o servidor sempre preenche).
- Nenhuma dependência nova. Textos de interface em pt-BR; identificadores em inglês; cores só pelos tokens do tema.
- **Fuso do escritório:** `America/Cuiaba`, com o rótulo "horário de Cuiabá". Usamos os auxiliares que já existem em `shared/src/automation.ts` (`officeLocalToIso`, `isoToOfficeLocal`, `formatOfficeDateTime`, `scheduleTimeProblem`) e nenhuma conversão nova de fuso.
- Só `tx` dentro das transações (o PGlite dos testes serializa as transações; `ctx.db` lá dentro trava), como em `scheduled.ts`.

## 3. Compromissos

### 3.1 Cadastrar
- **Na conversa:** um botão **"Compromissos"** no cabeçalho da conversa (ícone `CalendarStar`), ao lado de "Contato". Ele aparece também em conversa finalizada e de histórico. Abre o diálogo **"Compromissos de <cliente>"** (§3.4), que tem o botão **"Novo compromisso"**. O cliente é o contato da conversa, e o compromisso fica preso a **esta** conversa.
- **Na página "Compromissos"** (§3.5): o botão **"Novo compromisso"** abre o mesmo formulário com o campo **"Cliente"** a mais, uma busca de contatos por nome ou telefone igual à de "Nova conversa" (`api.contacts.list`, a partir de 2 letras). O servidor escolhe a conversa do contato (decisão 8):
  1. a conversa **aberta** desse contato que o usuário vê;
  2. se não houver, a conversa **mais recente** (`created_at`) desse contato que o usuário vê, finalizada ou de histórico;
  3. se o usuário não vê nenhuma → 400 "Você não tem conversa com este contato; comece uma em Nova conversa".
- **Formulário** (diálogo "Novo compromisso" / "Editar compromisso"):
  - "Título" (obrigatório, 1 a 120 caracteres, com o exemplo "Ex.: Audiência, Retorno de documento");
  - "Data e hora (horário de Cuiabá)" (`<input type="datetime-local">`, o mesmo campo do diálogo de agendar);
  - "Observação interna (não é enviada ao cliente)" (opcional, até 2000 caracteres);
  - "Lembretes": de 1 a 5 linhas (§3.2), com "Adicionar lembrete" e "Remover" em cada linha;
  - botões "Cancelar" e "Salvar".
- **Regras do horário do compromisso** (iguais no navegador e no servidor, função nova `appointmentTimeProblem(startsAt, now)` em `shared`):
  - sem data → "Escolha a data e a hora";
  - igual a agora ou antes → **"Este horário já passou; escolha uma data e hora futuras"**;
  - mais de 1 ano à frente (365 dias, `SCHEDULE_MAX_AHEAD_MS`) → "Escolha um horário em até 1 ano". Assim nenhum lembrete passa de 1 ano.
- A conversa pode estar **aberta, finalizada ou ser de histórico** (decisão 8): o envio já abre uma conversa nova quando não há uma aberta (§3.6). É diferente da mensagem agendada, que só se agenda em conversa aberta.
- Ao salvar, em **uma transação**: grava o compromisso e os lembretes, cria uma mensagem agendada para cada lembrete cujo horário de envio vale (§3.2) e grava o evento **"Compromisso “<título>” marcado por <nome> para <dd/mm/aaaa hh:mm>"** na conversa. Depois publica `chat.updated` dessa conversa, o que atualiza a linha "N mensagens agendadas" e a lista de compromissos das telas abertas.

### 3.2 Lembretes
- Cada linha tem: a **antecedência** (um número e "dias antes" ou "horas antes"; dias de **1 a 30**, horas de **1 a 48**) e o **texto** (1 a 4096 caracteres depois de preenchido, como `SCHEDULE_TEXT_MAX`).
- **Marcadores** no texto: `{nome}` (nome do contato), `{titulo}` (título do compromisso), `{data}` (dd/mm/aaaa) e `{hora}` (hh:mm), sempre no horário de Cuiabá. Abaixo da caixa aparecem "Marcadores: {nome}, {titulo}, {data}, {hora}" e a prévia **"Vai sair assim: <texto preenchido>"**.
  - Marcador desconhecido (inclusive `{Nome}`) → "Marcador desconhecido: {x}. Use {nome}, {titulo}, {data} ou {hora}".
  - `{nome}` com o contato sem nome cadastrado → "O contato não tem nome cadastrado; tire {nome} do lembrete" (decisão 6: não enviar "Olá, !" a um cliente).
  - Os marcadores são **preenchidos ao salvar** (e de novo no recálculo, §3.3), e o texto preenchido vai para `scheduled_messages.body`. O envio continua mandando o `body` como está. O lembrete guarda o texto **com** os marcadores, para poder preencher de novo.
- **Horário de envio** (função nova `reminderSendAt(startsAt, amount, unit)` em `shared`):
  - "N horas antes" = exatamente N × 60 min antes;
  - "N dias antes" = **o mesmo horário de parede de Cuiabá**, N dias antes (`isoToOfficeLocal` → subtrai N dias da data → `officeLocalToIso`). Não supõe horário de verão nem a falta dele (decisão 7).
- **Lembrete que não dá para criar:** se o horário de envio falha em `scheduleTimeProblem` (menos de 2 minutos à frente, ou já passou), o lembrete **é gravado sem mensagem agendada** e fica na situação **"Não criado"**. O formulário avisa antes de salvar, na própria linha: **"Não será enviado: o horário de envio já passou"**. Depois de salvar, a lista do compromisso mostra "Não criado: o horário de envio já tinha passado". Se todos os lembretes forem "Não criado", o compromisso é salvo assim mesmo.
- Dois lembretes do mesmo compromisso que caem no **mesmo horário** de envio (por exemplo "2 dias" e "48 horas") → "Dois lembretes cairiam no mesmo horário".
- A mensagem agendada de um lembrete tem como **autor o autor do compromisso**, também quando um administrador edita (decisão 9). Vai **com assinatura** (`signature = true`, o padrão do compositor) e sem anexo. Fica na conversa do compromisso (`chat_id`).
- O formulário de um compromisso novo vem com os **lembretes padrão** de Configurações (§4), que podem ser mudados à vontade antes de salvar.

### 3.3 Editar e cancelar
- **Quem pode:** o **autor** do compromisso ou um **administrador**, a mesma regra de `canManage` das mensagens agendadas. Qualquer outro recebe **404**. Um compromisso cancelado → 409 "Este compromisso foi cancelado".
- **Editar** abre o formulário ("Editar compromisso", botão "Salvar") com título, data e hora e observação. Os lembretes aparecem **só para leitura**, com a situação de cada um (§6). Para mudar os lembretes, cancele e cadastre de novo (decisão 3).
  - Um horário que não mudou não é checado de novo, como no diálogo de agendar (o compromisso pode até já ter passado). Um horário novo passa por `appointmentTimeProblem`.
  - Mudar **só a observação** não recalcula nada e não grava evento.
- **Recálculo** (quando muda o horário ou o título). **Decisão 2: atualizar no lugar**, numa transação que trava a linha do compromisso (`FOR UPDATE`). Para cada lembrete:

  | Mensagem agendada do lembrete | Novo horário de envio vale | Novo horário não vale (< 2 min / passou) |
  |---|---|---|
  | `pending` | `UPDATE send_at, body … WHERE id = ? AND status = 'pending'` | `DELETE … WHERE id = ? AND status = 'pending'` → volta a "Não criado" |
  | nenhuma ("Não criado") | cria a mensagem agendada (insere) | continua "Não criado" |
  | `sending`, `sent`, `failed` | não mexe (fica no histórico) | não mexe |

  - Se o `UPDATE`/`DELETE` não acha a linha em `pending`, o trabalhador a pegou entre a leitura e a escrita. Ela está saindo, então **fica como está** e nunca é recriada. Assim nada sai duas vezes.
  - Por que no lugar e não cancelar e recriar: um lembrete tem no máximo uma mensagem agendada (índice único), a Agenda não se enche de "Canceladas" a cada remarcação, e a mesma proteção do `updateScheduled` (`WHERE status = 'pending'`) já cobre a corrida com o trabalhador. O `DELETE` só apaga linha que nunca saiu, e nada aponta para ela.
  - Mudar o horário grava o evento **"Compromisso “<título>” remarcado por <nome> para <data>"**. Mudar só o título preenche os textos de novo sem evento.
- **Cancelar** pede confirmação ("Cancelar o compromisso?", texto "Os lembretes que ainda não saíram não serão enviados.", botões "Cancelar compromisso" e "Manter compromisso"). Em uma transação: grava `canceled_at`/`canceled_by` (`WHERE canceled_at IS NULL`, senão 409), passa as mensagens agendadas `pending` dos lembretes para `canceled` (com `finished_at`), que ficam em "Agenda → Canceladas", e grava o evento **"Compromisso “<título>” cancelado por <nome>"**. As que já saíram ficam como estão. Uma que estiver `sending` naquele instante sai (o mesmo da mensagem agendada).
- Depois de editar ou cancelar: `chat.updated` da conversa do compromisso.

### 3.4 Na conversa
- O diálogo **"Compromissos de <cliente>"** lista os compromissos **próximos** (não cancelados, horário a partir de agora) do **contato** da conversa, em **qualquer conversa dele que o usuário vê**. Assim um compromisso marcado numa conversa já finalizada aparece na conversa nova do mesmo cliente. A ordem é do mais próximo para o mais distante, até 100.
- Cada item mostra a data e hora, o título, "por <autor>", a observação (com o rótulo "Observação interna"), os lembretes (antecedência + situação) e "Editar" / "Cancelar" para quem pode. Embaixo ficam o botão "Novo compromisso" e o link "Ver todos os compromissos" (página).
- Vazio: "Nenhum compromisso marcado com este cliente."
- Os lembretes pendentes também entram na linha **"N mensagens agendadas"** da conversa (a mesma lista da entrega 3), com a marca **"Lembrete · <título>"** no lugar de "Editar"/"Cancelar" (§3.7).

### 3.5 Página "Compromissos"
- **Menu lateral:** o item **"Compromissos"** (ícone `CalendarStar`) vai **logo depois de "Agenda"**, para todos os usuários. A rota é `/compromissos`. Decisão 14: o item do menu tem 60 px e a fonte é Plus Jakarta Sans de 11 px, então "Compromissos" não cabe numa linha. O rótulo vai com hífen discreto (`Compro­missos`) e quebra em duas linhas ("Compro-" / "missos"); o aceite manual confere.
- Título "Compromissos" e botão **"Novo compromisso"**. Abas **"Próximos"** (não cancelados, horário ≥ agora), **"Passados"** (não cancelados, horário < agora) e **"Cancelados"**. O atendente vê **os seus** (autor); o administrador vê **os de todos** (igual à Agenda).
- Cada linha mostra a data e hora, o título, o cliente (link para a conversa do compromisso), o autor, os lembretes com a situação, a observação e Editar/Cancelar com as regras de §3.3. "Próximos" vai do mais próximo para o mais distante; as outras abas, do mais recente para o mais antigo; até 100 por aba. A página se atualiza a cada 30 s, como a Agenda.
- Vazio: "Nenhum compromisso aqui."

### 3.6 Envio
- **Nada muda no caminho de envio.** `delivery.ts` pega o lembrete como qualquer mensagem agendada: `pending → sending → sent | failed`, `FOR UPDATE SKIP LOCKED`, como o autor (`sendAgentMessage`), destino pela regra de "Nova conversa" (`startChat`), atraso > 1 h → falha, `sending` > 10 min → falha sem reenvio, aviso de falha só ao autor, marca "Agendada" na bolha.
- O compromisso só **cria, atualiza no lugar, apaga (só `pending`) e cancela** linhas de `scheduled_messages`, sempre conferindo `status = 'pending'` no `WHERE`.
- **Regra "Finalizar por inatividade"** (decisão 10): a exclusão "com mensagem agendada pendente" passa a **ignorar os lembretes** (`reminder_id IS NULL` na subconsulta de `rules.ts`). Sem isso, um compromisso daqui a 30 dias deixaria a conversa aberta 30 dias. O lembrete não precisa dela aberta, porque o envio abre uma conversa nova no setor original com o autor.

### 3.7 Lembretes na Agenda
- `ScheduledMessageDto.appointment?: { id: string; title: string } | null`. A Agenda e a linha "N mensagens agendadas" mostram a marca **"Lembrete · <título>"** (link para `/compromissos`).
- Um lembrete **não se edita nem se cancela pela Agenda** (decisão 4): `canEdit` é falso, e `PATCH /api/scheduled-messages/:id` e `POST …/cancel` numa linha com `reminder_id` → 409 **"Este lembrete é de um compromisso; altere pelo compromisso"**. A ordem das checagens: não pode gerir → 404; é lembrete → 409; não está pendente → 409. Assim o compromisso é a única fonte do horário e do texto.

### 3.8 Excluir e juntar
- **Excluir a conversa** (admin) ou o canal apaga os compromissos dela e os lembretes em cascata (`appointments.chat_id … on delete cascade`), junto com as mensagens agendadas (cascata que já existe). Lembrete não tem arquivo.
- **Juntar contatos do histórico** (`history/merge.ts`, `absorb`): os compromissos da conversa absorvida passam para a que fica (`UPDATE appointments SET chat_id = twin`), ao lado da linha que já faz isso com `scheduled_messages`. Nas conversas que só trocam de contato não há o que fazer, porque o compromisso não guarda o contato (ele vem da conversa).

## 4. Lembretes padrão (Configurações)
- **Configurações → "Compromissos"** (grupo "Atendimento", depois de "Regras automáticas", só administrador). Texto de ajuda: "Lembretes que já vêm preenchidos em todo compromisso novo. Cada compromisso pode mudar os seus." O editor de linhas é o mesmo do formulário (antecedência + texto + prévia, de 1 a 5 linhas, as mesmas regras de §3.2, menos `{nome}` sem nome, que lá não tem contato). Botão "Salvar" e o aviso "Lembretes salvos."
- Fica na tabela de configurações, chave **`appointment_reminders`** = `{ reminders: [{ amount, unit, text }] }`. Valor ausente ou inválido = o padrão `DEFAULT_APPOINTMENT_REMINDERS` (em `shared`):
  1. 2 dias antes: "Olá, {nome}! Lembramos do seu compromisso ({titulo}) no dia {data}, às {hora} (horário de Cuiabá). Qualquer dúvida, é só responder esta mensagem."
  2. 1 hora antes: "Olá, {nome}! Seu compromisso ({titulo}) é às {hora} de {data} (horário de Cuiabá)."
- **Decisão 5 (onde fica):** rotas próprias `GET /api/settings/appointment-reminders` (**qualquer usuário**, porque o formulário precisa delas) e `PUT` (administrador; atendente → 403). Assim não mexemos no `PUT /api/settings`, que troca tudo, nem em `auto-rules`, cujo GET é só do administrador. Mudar o padrão não muda os compromissos já salvos, porque o texto é copiado para cada lembrete.

## 5. Dados e API

### 5.1 Tabelas (migração `0009_compromissos`)
- **`appointments`**: `id`, `chat_id → chats (cascade)`, `author_id → users`, `title text not null`, `starts_at timestamptz not null`, `note text` (nulo = sem observação), `canceled_at timestamptz`, `canceled_by → users (set null)`, `created_at`. Índices `(starts_at)` e `(chat_id)`. Não tem coluna de situação: cancelado é `canceled_at` preenchido, e "próximo" ou "passado" se compara com agora.
- **`appointment_reminders`**: `id`, `appointment_id → appointments (cascade)`, `amount integer not null`, `unit text not null` (`'days' | 'hours'`), `text text not null` (com os marcadores), `created_at`. Índice `(appointment_id)`.
- **`scheduled_messages.reminder_id uuid → appointment_reminders (set null)`**, nulo para as mensagens agendadas comuns, com **índice único** (no máximo uma mensagem agendada por lembrete; vários nulos convivem).
- **Decisão 1 (onde fica a ligação):** a ligação compromisso → lembrete → mensagem agendada fica numa **coluna em `scheduled_messages`**, e não numa tabela de ligação nem numa coluna `scheduled_message_id` no lembrete. Os três lugares que precisam saber "é lembrete?" já leem a linha de `scheduled_messages`: a guarda da Agenda (`pendingRowFor`), o `canEdit` do DTO e a exclusão da regra de inatividade. Com a coluna lá, cada um testa uma coluna, sem junção. O lembrete "Não criado" é só o lembrete sem linha que aponte para ele. `set null` em vez de `cascade` porque nenhum caminho apaga um lembrete sozinho; se um dia apagar, o histórico da Agenda não some junto.

### 5.2 `shared`
- Em `shared/src/automation.ts` (valores sem dependência, carregados direto pelo tsx e pelo Vite):
  - `REMINDER_UNITS = ['days', 'hours']`, `ReminderUnit`;
  - `APPOINTMENT_LIMITS = { titleMax: 120, noteMax: 2000, remindersMax: 5, days: { min: 1, max: 30 }, hours: { min: 1, max: 48 } }`;
  - `REMINDER_PLACEHOLDERS = ['nome', 'titulo', 'data', 'hora']`;
  - `APPOINTMENT_TABS = ['upcoming', 'past', 'canceled']`, `AppointmentTab`;
  - `DEFAULT_APPOINTMENT_REMINDERS`;
  - `appointmentTimeProblem(startsAt, now)`, `reminderSendAt(startsAt, amount, unit)`, `reminderTextProblem(text)` (marcador desconhecido) e `fillReminderText(text, { nome, titulo, startsAt })` (`{data}`/`{hora}` saem de `formatOfficeDateTime`).
- Em `shared/src/index.ts`:
  - `AppointmentReminderDto { id; amount; unit; text; sendAt; status: ScheduledStatus | 'skipped'; scheduledId: string | null; error: string | null }`;
  - `AppointmentDto { id; chatId; contact: { id; name; phone }; authorId; authorName; title; startsAt; note: string | null; canceledAt: string | null; canceledByName: string | null; createdAt; reminders: AppointmentReminderDto[]; canEdit }`, com `canEdit` = autor ou administrador e não cancelado;
  - `AppointmentRemindersDto { reminders: { amount; unit; text }[] }` (Configurações);
  - `ScheduledMessageDto.appointment?`;
  - eventos novos em `ChatEventKind`: `appointment_scheduled` (`{ appointmentId, title, startsAt, edited? }`) e `appointment_canceled` (`{ appointmentId, title }`). A observação nunca vai para o evento.

### 5.3 Rotas (novo `server/src/automation/appointments.ts`, registrado em `registerAutomationRoutes`)
- `POST /api/appointments` `{ chatId | contactId (exatamente um), title, startsAt (ISO com fuso), note?, reminders: [{ amount, unit, text }] }` → `AppointmentDto`. Com `chatId`, a conversa invisível → 404. Com `contactId`, a regra de §3.1; contato que não existe → 404.
- `GET /api/chats/:id/appointments` → próximos do contato dessa conversa, nas conversas que o usuário vê (`visibleChatsWhere`); conversa invisível → 404.
- `GET /api/appointments?tab=upcoming|past|canceled` → os meus (admin: todos), até 100.
- `PATCH /api/appointments/:id` `{ title?, startsAt?, note? }` (pelo menos um; `note: null` ou `""` apaga a observação) → `AppointmentDto`.
- `POST /api/appointments/:id/cancel` → `AppointmentDto`.
- `GET` / `PUT /api/settings/appointment-reminders` (§4).
- Validação com zod nas rotas (formato e limites). As regras de horário e de texto chamam as mesmas funções de `shared` que o navegador. Os erros de regra são 400 com a mensagem em pt-BR de §6.

## 6. Interface (textos exatos)
- Cabeçalho da conversa: botão "Compromissos". Diálogo "Compromissos de <cliente>"; vazio "Nenhum compromisso marcado com este cliente."; "Novo compromisso"; "Ver todos os compromissos".
- Formulário: títulos "Novo compromisso" / "Editar compromisso"; campos "Cliente" (só na página, com o exemplo "Nome ou telefone"), "Título" ("Ex.: Audiência, Retorno de documento"), "Data e hora (horário de Cuiabá)", "Observação interna (não é enviada ao cliente)", "Lembretes"; na linha: número, "dias antes" / "horas antes", "Texto do lembrete", "Remover"; "Adicionar lembrete"; "Marcadores: {nome}, {titulo}, {data}, {hora}"; "Vai sair assim: …"; "Não será enviado: o horário de envio já passou"; botões "Salvar" / "Cancelar".
- Erros: "Escolha o cliente", "Digite o título", "Escolha a data e a hora", "Este horário já passou; escolha uma data e hora futuras", "Escolha um horário em até 1 ano", "Inclua pelo menos um lembrete", "Digite o texto do lembrete", "Marcador desconhecido: {x}. Use {nome}, {titulo}, {data} ou {hora}", "O contato não tem nome cadastrado; tire {nome} do lembrete", "Dois lembretes cairiam no mesmo horário", "Você não tem conversa com este contato; comece uma em Nova conversa", "Este compromisso foi cancelado", "Este lembrete é de um compromisso; altere pelo compromisso".
- Situação do lembrete: "Pendente · <dd/mm/aaaa hh:mm>", "Enviando…", "Enviado", "Falhou: <motivo>", "Cancelado", "Não criado: o horário de envio já tinha passado". A antecedência aparece como "2 dias antes", "1 dia antes", "1 hora antes", "3 horas antes".
- Item: "por <nome>", "Observação interna", "Editar", "Cancelar", a marca "Cancelado" na aba Cancelados; confirmação "Cancelar o compromisso?" / "Os lembretes que ainda não saíram não serão enviados." / "Cancelar compromisso" / "Manter compromisso".
- Agenda e linha "N mensagens agendadas": marca "Lembrete · <título>".
- Menu: "Compromissos" (com hífen discreto), depois de "Agenda". Página "Compromissos"; abas "Próximos", "Passados", "Cancelados"; vazio "Nenhum compromisso aqui."
- Eventos: "Compromisso “<título>” marcado por <nome> para <data>", "Compromisso “<título>” remarcado por <nome> para <data>", "Compromisso “<título>” cancelado por <nome>" (data no horário de Cuiabá, em `model.ts` ao lado dos eventos de agendamento).
- Configurações: seção "Compromissos"; "Lembretes que já vêm preenchidos em todo compromisso novo. Cada compromisso pode mudar os seus."; "Salvar"; "Lembretes salvos."

## 7. Testes
- **Fuso** (no arquivo de teste, `process.env.TZ = 'Asia/Tokyo'` antes de qualquer import, como `server/test/automation/office-time.test.ts` e `Scheduled.test.tsx`):
  - `reminderSendAt` em dias guarda o horário de parede de Cuiabá (ex.: 25/10/2026 14:00 − 2 dias = 23/10/2026 14:00 Cuiabá = `2026-10-23T18:00:00.000Z`), inclusive na virada de mês e de ano;
  - em horas, desconta o tempo exato;
  - `appointmentTimeProblem` (vazio, agora, passado, 1 ano + 1 min);
  - `fillReminderText` (`{data}`/`{hora}` em Cuiabá com o host em Tóquio) e `reminderTextProblem`.
- **Criar:**
  - pela conversa e por `contactId` (aberta primeiro; senão a mais recente visível; nenhuma → 400; contato inexistente → 404);
  - quem não vê → 404, conversa privada de outro → 404, sem Origin → 403;
  - passado e > 1 ano → 400; marcador desconhecido, `{nome}` sem nome, horário repetido, 0 ou 6 lembretes → 400;
  - conversa finalizada e de histórico aceitas;
  - cada lembrete válido vira `scheduled_messages` com o autor, `signature = true`, `body` preenchido, `send_at` certo e `reminder_id`; o que caiu a menos de 2 min fica "skipped" sem linha; com todos "skipped" o compromisso salva mesmo assim;
  - evento na linha do tempo; `chat.updated` publicado.
- **Listar:**
  - conversa: próximos do contato em todas as conversas visíveis, sem os de conversa invisível, sem cancelados e passados;
  - página: atendente só os seus, admin todos, as três abas com a ordem certa e o limite de 100.
- **Editar:**
  - autor e admin podem, outro → 404, cancelado → 409, horário novo no passado → 400, horário mantido não é rechecado;
  - mudar o horário atualiza no lugar (mesmo id, novo `send_at` e `body`); `sent`/`failed`/`sending` não mudam; "skipped" vira linha quando passa a valer; `pending` que fica a menos de 2 min é apagado e volta a "skipped";
  - linha pega pelo trabalhador no meio (`sending`) não é recriada;
  - mudar o título preenche de novo sem evento; só a observação não recalcula; evento "remarcado" só quando o horário muda; o autor dos lembretes continua o do compromisso quando o admin edita.
- **Cancelar:** `pending` → `canceled` com `finished_at`; enviadas ficam; `sending` não muda; segundo cancelamento → 409; evento.
- **Agenda:** `PATCH`/`cancel` num lembrete → 409; `canEdit` falso; `appointment` no DTO; mensagem agendada comum continua igual.
- **Envio** (relógio falso, `deliverDueScheduled` sem mudança): o lembrete sai no horário, como o autor, com a marca "Agendada"; com a conversa finalizada, abre conversa nova no setor original; nunca duas vezes depois de um recálculo.
- **Regras:** conversa só com lembrete pendente é finalizada por inatividade; com mensagem agendada comum pendente continua fora.
- **Excluir e juntar:** excluir a conversa apaga compromissos, lembretes e mensagens; `absorb` leva os compromissos para a conversa que fica.
- **Configurações:** GET por atendente, PUT só admin (atendente → 403), limites e marcadores, padrão quando ausente ou inválido.
- **Web** (`TZ = 'Asia/Tokyo'` nos testes de horário):
  - formulário: datetime-local lido como Cuiabá, aviso "Não será enviado" ao vivo, prévia, erros, lembretes padrão preenchidos;
  - botão e diálogo da conversa;
  - página com abas e "Novo compromisso" com busca de cliente;
  - item com Editar/Cancelar só para quem pode;
  - Agenda com "Lembrete · <título>" e sem Editar/Cancelar;
  - textos dos eventos; item do menu depois de "Agenda"; página de Configurações.

## 8. Aceite manual
1. Em Configurações → Compromissos, conferir os dois lembretes padrão.
2. Numa conversa de teste, criar o compromisso "Audiência teste" para daqui a 1 h 05 min, com "2 dias antes" e "1 hora antes":
   - o formulário avisa que "2 dias antes" não será enviado;
   - ao salvar, aparecem o evento na linha do tempo, "1 mensagem agendada" com "Lembrete · Audiência teste", e o lembrete em "Agenda → Pendentes" sem Editar/Cancelar;
   - em 5 minutos, o celular de teste recebe o texto com o nome, a data e a hora certos, com assinatura e a marca "Agendada".
3. Criar outro para daqui a 1 h 10 min com "1 hora antes" e remarcar para daqui a 1 h 20 min: a Agenda mostra o novo horário, o evento "remarcado" aparece e a mensagem sai só uma vez, no horário novo.
4. Criar um terceiro e cancelar: o lembrete vai para "Agenda → Canceladas", e o compromisso para a aba "Cancelados".
5. Criar um pela página "Compromissos" escolhendo um cliente cuja conversa está finalizada; esperar o lembrete abrir uma conversa nova no mesmo setor.
6. Conferir que o item "Compromissos" do menu cabe no menu lateral (duas linhas, sem barra de rolagem horizontal) nos temas claro e escuro.

## 9. Riscos
- **Texto congelado:** nome do cliente e título são preenchidos ao salvar ou recalcular. Se o contato mudar de nome depois, os lembretes pendentes saem com o nome antigo até o compromisso ser remarcado ou mudar de título. Aceito: o compromisso é curto e o texto fica visível na Agenda.
- **Corrida com o trabalhador:** um lembrete pego no meio de uma remarcação sai com o horário antigo no texto. Isso só acontece no próprio minuto do envio e nunca gera dois envios (§3.3).
- **Autor desativado:** os lembretes falham com o motivo de hoje ("o autor do agendamento está desativado"), e o aviso vai para quem não está mais lá. O administrador vê a falha na Agenda. Trocar o autor de um compromisso fica fora do escopo.
- **Visibilidade presa à conversa original:** se aquela conversa virar privada de outra pessoa, quem só vê a conversa nova do cliente deixa de ver o compromisso. Aceito: a regra é a mesma de tudo que é preso a uma conversa.
- **Rótulo do menu:** a quebra com hífen discreto pode ficar estranha ao lado dos outros itens de uma palavra. O aceite confere (§8, item 6).
- **Regra de inatividade:** quem contava que um lembrete seguraria a conversa aberta agora vê a conversa finalizada antes. O envio a reabre, então nada se perde.

## 10. Fora do escopo
Compromisso recorrente; sincronizar com o Google Agenda; confirmação do cliente por resposta; enviar uma mensagem a partir do compromisso sem lembrete; editar, incluir ou tirar lembretes de um compromisso salvo (cancele e cadastre de novo); lembrete com hora fixa ("1 dia antes às 9h"); anexo em lembrete; trocar o autor de um compromisso; compromisso com vários clientes; lembrete para o atendente (só o cliente recebe); exportar ou imprimir a lista; paginação além de 100 por aba; aviso em tempo real na página (atualiza a cada 30 s).

## 11. Decisões do controlador (além do desenho aprovado)
1. **A ligação** é a coluna `scheduled_messages.reminder_id` (única, `set null`), não uma tabela de ligação (§5.1).
2. **Remarcar atualiza no lugar** as mensagens `pending`. A que passa a cair a menos de 2 min é apagada e volta a "Não criado"; a "Não criado" que passa a valer é criada (§3.3).
3. **Lembretes só se escolhem ao cadastrar.** Editar muda título, data e hora e observação; para mudar os lembretes, cancele e cadastre de novo.
4. **A Agenda não edita nem cancela lembretes** (409). O compromisso é a única fonte do horário e do texto (§3.7).
5. **O texto padrão** fica na configuração `appointment_reminders` (lista de antecedência + texto), com GET para todos e PUT para o administrador, editado em Configurações → Compromissos (§4).
6. **Marcadores:** entra `{titulo}` além de `{nome}`, `{data}` e `{hora}`. Marcador desconhecido → 400; `{nome}` com contato sem nome → 400. Os marcadores são preenchidos ao salvar e ao recalcular, nunca no envio (o caminho de envio não muda).
7. **"N dias antes"** usa o mesmo horário de parede de Cuiabá N dias antes; "N horas antes" usa o tempo exato. Limites: 1–30 dias, 1–48 horas, até 5 lembretes, título até 120 e observação até 2000 caracteres.
8. **Conversa do compromisso:** pode ser aberta, finalizada ou de histórico. Pela página, o servidor escolhe a conversa aberta visível do contato, senão a mais recente visível, senão 400.
9. **Autor e assinatura:** os lembretes saem como o autor do compromisso, também depois que um administrador edita, sempre com assinatura e sem anexo.
10. **"Finalizar por inatividade"** ignora os lembretes pendentes (`reminder_id IS NULL`).
11. **Na conversa**, a lista mostra os compromissos próximos do **contato** em todas as conversas dele que o usuário vê; a visibilidade de cada compromisso é `canSee` da sua conversa.
12. **O próprio compromisso** precisa ser no futuro e em até 1 ano; os lembretes herdam o teto de 1 ano e o mínimo de 2 min de `scheduleTimeProblem`.
13. **Eventos:** `appointment_scheduled` (com `edited`) e `appointment_canceled`, com o título e sem a observação. Não há evento por lembrete, porque a bolha "Agendada" já marca o envio.
14. **Menu:** "Compromissos" com hífen discreto, logo depois de "Agenda", com a rota `/compromissos`.
15. **Cancelado é `canceled_at`**, sem coluna de situação. As abas Próximos/Passados se calculam contra a hora atual.

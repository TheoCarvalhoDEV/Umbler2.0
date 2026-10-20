# Mensagens agendadas e regras automáticas — design

- **Data:** 20/10/2026 · **Status:** decisões tomadas pelo controlador (o usuário dispensou mais perguntas) — aguardando revisão desta spec
- **Branch:** `feat/agendamentos-e-regras` (a partir de `feat/lista-dia-a-dia`). **Entrega 3:** roda **depois** da entrega 2 (`feat/lista-dia-a-dia`, PR #22: `chats.waiting_since`, ordens da lista, ações em massa, `chat_tags`, migração `0007`), por cima dela.
- **Base:** núcleo `2026-10-14-nucleo-atendimento-design.md` (finalizar, "Nova conversa", barreira de setor, chatbot rodando §5.5), chatbot `2026-10-15-chatbot-fluxos-2a-design.md` (relógio do agendador, notificação ao atendente) e o código atual (`server/src/bots/scheduler.ts`, `server/src/messages/send.ts`, `server/src/inbox/chats.ts`, `server/src/catalog/settings.ts`).
- **Plano:** `docs/superpowers/plans/2026-10-20-agendamentos-e-regras.md`.

## 1. Objetivo
Duas coisas que o escritório faz hoje à mão: **mandar uma mensagem num horário marcado** (lembrete de audiência, cobrança de documento) e **cuidar das conversas paradas** (devolver à fila quem ficou sem resposta, finalizar o que já acabou).

## 2. Regras gerais
- Quem não vê a conversa (`canSee`, que já cobre a conversa privada) recebe **404**. Toda mutação nova é uma rota `/api/*` não-GET (checagem de Origin global).
- Logs nunca levam texto de mensagem, telefone ou nome: só ids, contagens e o nome/código do erro.
- Migração gerada pelo drizzle-kit (`0008_agendamentos_e_regras`), nunca editada à mão. Vem depois da `0007` da entrega 2.
- Campos novos nos DTOs são opcionais (literais antigos continuam compilando; o servidor sempre preenche).
- Nenhuma dependência nova. Textos de interface em pt-BR; identificadores em inglês; cores só pelos tokens do tema.
- **Fuso do escritório:** `America/Cuiaba`. Toda data/hora de agendamento é digitada e mostrada nesse fuso, com o rótulo "horário de Cuiabá", qualquer que seja o fuso do computador. A conversão usa `Intl` (sem supor horário de verão ou a falta dele).

## 3. Mensagens agendadas

### 3.1 Agendar
- No compositor (modo "Mensagem"), um botão **"Agendar mensagem"** (ícone de calendário) ao lado de enviar. Com a caixa vazia ele avisa "Digite a mensagem que será agendada".
- Abre o diálogo **"Agendar mensagem"**: **"Texto da mensagem"** (já preenchido com o texto do compositor, editável), o anexo escolhido (só o nome, "Anexo: <arquivo>") e **"Data e hora (horário de Cuiabá)"** (`<input type="datetime-local">`). Botões "Cancelar" e "Agendar".
- Regras (iguais no navegador e no servidor):
  - texto obrigatório, 1 a 4096 caracteres (mesmo com anexo);
  - horário **pelo menos 2 minutos à frente** ("Escolha um horário pelo menos 2 minutos à frente") e **no máximo 1 ano** (365 dias; "Escolha um horário em até 1 ano"); sem data → "Escolha a data e a hora";
  - **no máximo um anexo**, com as regras do envio normal (um arquivo de até 64 MB). O arquivo é **gravado no momento de agendar** (no mesmo lugar dos outros arquivos), não no momento de enviar. Áudio gravado e figurinha não se agendam;
  - **assinatura:** vale o que estiver marcado em "Assinatura" no compositor ao agendar; a assinatura é montada na hora do envio, como num envio normal (nome e setor do autor naquele momento).
- Só se agenda em conversa **aberta** (histórico e finalizada → 409 "Conversa finalizada").
- Ao agendar, o compositor fica vazio e a linha do tempo ganha o evento **"Mensagem agendada por <nome> para <dd/mm/aaaa hh:mm>"** (data no horário de Cuiabá).

### 3.2 Ver, editar e cancelar
- **Na conversa:** acima do compositor (ou do rodapé "Conversa finalizada"), a linha **"N mensagens agendadas"** ("1 mensagem agendada") aparece quando há agendamentos pendentes daquela conversa. Clicar abre a lista: data/hora, início do texto, "Anexo" quando houver, e o autor ("por <nome>").
  - Todos que veem a conversa veem a lista. **Editar** e **Cancelar** aparecem só para o **autor** ou um **administrador**.
  - **Editar** abre o mesmo diálogo ("Editar agendamento", botão "Salvar") com texto e horário. O anexo não muda (para trocar, cancele e agende de novo). Mudar o horário refaz a checagem de 2 minutos / 1 ano e grava o evento "Mensagem agendada alterada por <nome> para <data>"; mudar só o texto não grava evento.
  - **Cancelar** pede confirmação ("Cancelar a mensagem agendada?", botão "Cancelar agendamento") e grava o evento "Mensagem agendada cancelada por <nome>".
  - Editar ou cancelar algo que já saiu de "pendente" → 409 "Esta mensagem agendada não está mais pendente".
- **Página "Agendamentos"** no menu principal (todos os usuários): abas **"Pendentes"** (inclui "Enviando…"), **"Enviadas"**, **"Falharam"**, **"Canceladas"**. O atendente vê **os seus**; o administrador vê **os de todos**. Cada linha: contato (link para a conversa), data/hora, texto, autor, situação e, em "Falharam", o motivo. Pendentes ficam em ordem de horário (próxima primeiro); as outras abas, da mais recente para a mais antiga; até 100 por aba. Editar/cancelar com as mesmas regras de 3.2. A página se atualiza a cada 30 s.
- Quem não é autor nem administrador recebe **404** ao editar/cancelar.

### 3.3 Envio
- Um trabalhador no servidor (o mesmo estilo do relógio do chatbot: lote, `FOR UPDATE SKIP LOCKED`, relógio falso nos testes) roda **a cada 15 s** e pega os pendentes vencidos.
- **Máquina de estados:** `pending → sending → sent | failed`, e `pending → canceled`. A reivindicação (`pending → sending`) é feita na mesma transação que trava as linhas, então duas rodadas (ou dois processos) **nunca enviam a mesma mensagem duas vezes**. O resultado só é gravado se a linha ainda estiver em `sending`.
- O envio é **o envio normal do atendente** (`sendAgentMessage`), **como o autor**:
  - autor desativado → falha "Não enviada: o autor do agendamento está desativado";
  - **destino** = a regra do botão **"Nova conversa"**: a conversa aberta do contato naquele número, se o autor puder vê-la; se não houver conversa aberta, abre uma nova **no setor da conversa original, com o autor como atendente** (evento "Conversa iniciada por <autor>"); se houver uma aberta que o autor **não** vê → falha com o motivo de hoje ("Este contato já está em atendimento em outro setor");
  - **chatbot rodando:** envia assim mesmo e o chatbot continua (`botAction: 'keep'`);
  - a mensagem enviada é uma bolha normal do autor, com a marca pequena **"Agendada"**.
- **Resultado gravado** na linha: enviada → id da mensagem; falhou → motivo. O WhatsApp recusou (bolha com falha na conversa, com "Reenviar") → falha "O WhatsApp não aceitou a mensagem; ela pode ser reenviada na conversa".
- **Atraso:** se o servidor estava fora do ar e o horário passou **há mais de 1 hora**, não envia: falha "Não enviada: o sistema estava fora do ar no horário agendado".
- **Reinício:** uma linha parada em `sending` há **mais de 10 minutos** vira falha "Envio interrompido; confira a conversa antes de agendar de novo" e **nunca é reenviada** (o WhatsApp pode ter recebido).
- **Falha avisa o autor:** um aviso no canto da tela (o mesmo dos avisos do chatbot), "Mensagem agendada não enviada" + o motivo, com link para "Agendamentos → Falharam". Vai só para o autor e não depende de ele ainda ver a conversa. A falha aparece também na página.
- Cada envio e falha atualiza as telas abertas pelo `chat.updated` da conversa original (a lista "N mensagens agendadas" some/encolhe).
- Excluir a conversa (admin) exclui os agendamentos dela. Juntar contatos do histórico (LID ↔ telefone) leva os agendamentos da conversa absorvida para a que fica.

## 4. Regras automáticas
- Em **Configurações → "Regras automáticas"** (só administrador). Duas regras, **ambas desligadas** por padrão, guardadas na tabela de configurações (chave `auto_rules`).
- Rodam no mesmo trabalhador, **a cada minuto**, em lotes de até 50 conversas por regra, sem efeito repetido (cada mudança confere de novo o estado da conversa no `UPDATE`). Os logs levam só contagens e ids.

### 4.1 "Devolver à fila conversas paradas"
- Campo "Minutos sem resposta" (padrão **30**, de **5 a 1440**).
- Vale para conversa **aberta**, **não privada**, **com atendente**, que **espera resposta** (`waiting`). Fica de fora: conversa com **chatbot em execução**, em **triagem**, de **histórico**.
- **Decisão (contagem):** os N minutos contam a partir do **mais recente** entre "desde quando o contato espera" (`waiting_since`; se vazio, a última mensagem) e **a última troca de atendente** (eventos de criação, assumir, transferir e transferência pelo chatbot). Assim:
  - quem acabou de assumir uma conversa que esperava há horas tem N minutos para responder;
  - a regra age **uma vez por espera**: depois de devolvida a conversa fica sem atendente; se alguém assumir, a contagem recomeça.
- Efeito: perde o atendente e volta para **"Sem atendente" no mesmo setor**; evento **"Devolvida à fila: sem resposta há N min"**.

### 4.2 "Finalizar por inatividade"
- Campo "Horas sem mensagens" (padrão **24**, de **1 a 720**) e caixa **"Enviar a mensagem de encerramento"** (usa a mensagem de Configurações → Conversas; vem marcada).
- Vale para conversa **aberta** que **não espera resposta** (o escritório falou por último) e cuja **última mensagem** é mais antiga que N horas.
- Fica de fora: conversa com **chatbot em execução** (o chatbot tem a própria inatividade), em **triagem**, de **histórico**, e com **mensagem agendada pendente** (decisão: a conversa ainda tem algo marcado).
- **Decisão (privadas):** conversas **privadas também** são finalizadas: finalizar não muda quem vê, e reabrir continua possível.
- A mensagem de encerramento vai como **mensagem do sistema** (sem autor e sem assinatura), antes de finalizar. Se o envio falhar, a conversa **continua aberta** (com a bolha de falha); como a falha conta como mensagem, a regra só tenta de novo depois de mais N horas. Contato sem telefone: finaliza sem mensagem. Mensagem de encerramento vazia: finaliza sem mensagem.
- Se o contato escrever entre a escolha da conversa e o fechamento, ela não é finalizada.
- Efeito: conversa finalizada pelo sistema, evento **"Finalizada por inatividade"**.

## 5. Dados e API
- Tabela `scheduled_messages`: `id`, `chat_id → chats (cascade)`, `author_id → users`, `body`, `signature`, `media_path/mime/name/size/sha256` (opcionais), `send_at`, `status` (`pending|sending|sent|failed|canceled`), `claimed_at`, `finished_at`, `message_id → messages (set null)`, `error`, `created_at`; índices `(status, send_at)` e `(chat_id)`.
- `messages.scheduled boolean not null default false` (a marca "Agendada").
- Configuração `auto_rules` = `{ returnToQueue: { enabled, minutes }, closeInactive: { enabled, hours, sendClosingMessage } }`; valor ausente ou inválido = padrões desligados.
- `shared`: `OFFICE_TIMEZONE`, limites do agendamento, `scheduleTimeProblem`, `officeLocalToIso`, `isoToOfficeLocal`, `formatOfficeDateTime`, `SCHEDULED_STATUSES`, `ScheduledStatus`, `ScheduledMessageDto`, `AutoRulesDto`, `DEFAULT_AUTO_RULES` e os limites das regras. `MessageDto.scheduled?`, `NotificationDto.kind?` (`'bot' | 'scheduled_failed'`), eventos novos `message_scheduled` (`{ scheduledId, sendAt, edited? }`), `scheduled_canceled` (`{ scheduledId }`), `returned_to_queue` (`{ minutes, previousOwnerId }`); o fechamento por inatividade é o evento `closed` com `{ closingMessageSent, reason: 'inactivity', hours }` e sem autor.
- Rotas novas:
  - `POST /api/chats/:id/scheduled-messages` (JSON `{ text, sendAt, signature }` ou multipart com os mesmos campos antes do arquivo) → `ScheduledMessageDto`;
  - `GET /api/chats/:id/scheduled-messages` → pendentes da conversa;
  - `GET /api/scheduled-messages?status=pending|sent|failed|canceled` → os meus (admin: todos);
  - `PATCH /api/scheduled-messages/:id` `{ text?, sendAt? }`; `POST /api/scheduled-messages/:id/cancel`;
  - `GET` e `PUT /api/settings/auto-rules` (administrador). **Decisão:** rota própria, para não mexer no `PUT /api/settings`, que troca tudo.

## 6. Interface (textos exatos)
- Compositor: botão "Agendar mensagem"; aviso "Digite a mensagem que será agendada".
- Diálogo: títulos "Agendar mensagem" / "Editar agendamento"; campos "Texto da mensagem", "Data e hora (horário de Cuiabá)"; "Anexo: <arquivo>"; botões "Agendar" / "Salvar" / "Cancelar"; erros "Digite a mensagem", "Escolha a data e a hora", "Escolha um horário pelo menos 2 minutos à frente", "Escolha um horário em até 1 ano".
- Conversa: "1 mensagem agendada" / "N mensagens agendadas"; linha "por <nome>", "Anexo", "Editar", "Cancelar"; confirmação "Cancelar a mensagem agendada?" / "Cancelar agendamento"; marca da bolha "Agendada".
- Menu: "Agendamentos"; abas "Pendentes", "Enviadas", "Falharam", "Canceladas"; situações "Pendente", "Enviando…", "Enviada", "Falhou", "Cancelada"; vazio "Nenhuma mensagem aqui."
- Aviso de falha: "Mensagem agendada não enviada", rodapé "Mensagens agendadas".
- Eventos: "Mensagem agendada por <nome> para <data>", "Mensagem agendada alterada por <nome> para <data>", "Mensagem agendada cancelada por <nome>", "Devolvida à fila: sem resposta há N min", "Finalizada por inatividade".
- Configurações: seção "Regras automáticas"; "Devolver à fila conversas paradas" com "Minutos sem resposta"; "Finalizar por inatividade" com "Horas sem mensagens" e "Enviar a mensagem de encerramento"; botão "Salvar"; "Regras salvas."

## 7. Testes
- Fuso: ida e volta Cuiabá ↔ ISO, formatação, limites de 2 min / 1 ano.
- Agendar: JSON e multipart (arquivo gravado na hora), conversa finalizada → 409, horário fora dos limites → 400, quem não vê → 404, sem Origin → 403, evento na linha do tempo; listar por conversa e por página (atendente só os seus, admin todos); editar/cancelar (autor, admin, outro → 404, não pendente → 409, eventos).
- Envio (relógio falso): no horário e não antes; nunca duas vezes (duas rodadas seguidas, linha travada); como o autor com a assinatura; anexo guardado; conversa finalizada → nova conversa no setor original com o autor; conversa aberta invisível ao autor → falha; autor desativado → falha; WhatsApp recusa → falha com id; chatbot rodando continua; atraso > 1 h → falha; `sending` > 10 min → falha sem reenvio; aviso só ao autor; marca `scheduled` no DTO.
- Regras: cada condição de entrada e de exclusão das duas regras; a contagem recomeça ao assumir; uma vez por espera; mensagem de encerramento enviada/omitida/falha; contato escreve no meio; padrões desligados; rotas de configuração (admin, limites).
- Web: diálogo (limites e fuso), botão do compositor, lista da conversa (contagem, editar/cancelar só para quem pode), página com abas, marca "Agendada", aviso de falha com link, página de regras.

## 8. Aceite manual
Agendar "teste agendado" para daqui a 3 minutos com um PDF; ver "1 mensagem agendada" e o evento na linha do tempo; editar o horário para daqui a 2 minutos; esperar e ver a bolha "Agendada" no celular de teste com o PDF; agendar outra e cancelar; agendar numa conversa, finalizá-la e ver a mensagem abrir uma conversa nova no mesmo setor; desativar um atendente com agendamento e ver a falha na página; ligar "Devolver à fila" com 5 minutos e ver uma conversa esperando voltar para "Sem atendente"; ligar "Finalizar por inatividade" com 1 hora e ver a conversa finalizada com a mensagem de encerramento.

## 9. Fora do escopo
Agendamento recorrente; agendar áudio gravado, figurinha ou resposta ao citar mensagem; trocar o anexo de um agendamento; agendar para vários contatos de uma vez; reenviar um agendamento que falhou com um clique (agende de novo); regras por setor ou por horário comercial; outras regras automáticas; aviso por e-mail; paginação além de 100 por aba.

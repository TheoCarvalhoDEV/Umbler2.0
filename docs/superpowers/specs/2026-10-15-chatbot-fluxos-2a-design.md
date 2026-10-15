# Chatbot com editor visual de fluxos (entrega 2a) — especificação de design

- **Data:** 15/10/2026 · **Status:** desenho aprovado em conversa (partes 1–4)
- **Sub-projeto:** 2 (Automação), entrega **2a** de 3 — 2b: blocos que exigem funções novas · 2c: integrações (Webhook, Pipedrive, Asaas)
- **Referências:** `docs/umbler/MAPA-UMBLER-TALK.md` §6 (catálogo do Umbler e o "Fluxo" atual do escritório), spec do núcleo `2026-10-14-nucleo-atendimento-design.md` (§5.4 triagem, §5.7 variáveis, §6 segurança), emenda `2026-10-15-visibilidade-e-fotos.md`.

## 1. Objetivo e critério de sucesso

Permitir que o admin monte chatbots em um editor visual de blocos (como o Umbler), com um motor que executa esses fluxos nas conversas do WhatsApp.

**Pronto quando:**
1. Existe o modelo **"Fluxo do escritório"** (§8) que recria o Fluxo usado hoje no Umbler, e ele roda de ponta a ponta no ambiente local com o número de teste: o cliente passa por horário/dia, boas-vindas, menu, comunicado, pedido de CPF validado e salvo no campo, e cai no setor certo com o atendente notificado.
2. Os 33 tipos de bloco de §4 funcionam, com testes.

### Decisões do usuário (15/10/2026)
| Tema | Decisão |
|---|---|
| Escopo | catálogo completo do Umbler, entregue em 3 partes (2a, 2b, 2c); esta spec é a 2a |
| Fora de vez | IA ("Transferir p/ agentes de IA"); "Enviar template", "Enviar formulário" e botões de "Pedir para escolher" (só existem na API oficial — usamos QR); "Grupo do canal" e "Grupo do atendente" (não existe recurso Grupos) |
| Triagem simples | **mantida**; se houver chatbot ativo com "Iniciar por um canal" no canal, ele tem prioridade e a triagem não roda |
| Atendente escreve com bot rodando | **configurável** em Configurações › Conversas: Perguntar (padrão) · Parar o bot · Manter rodando |
| Editor | React Flow (`@xyflow/react`) + `dagre` para auto-organizar |
| Motor | execução gravada no Postgres + relógio interno no próprio app (sem Redis/fila) |

## 2. Arquitetura

```
server/src/bots/
  graph.ts        tipos do grafo (BotGraph, BotNode, BotEdge) e validação (validateGraph)
  blocks/         um arquivo por família: start.ts, conditions.ts, actions.ts, finish.ts
                  cada bloco = { type, outputs(config), validate(config, catalog), run(ctx, run, node) }
  registry.ts     mapa type → definição do bloco (fonte única do catálogo)
  engine.ts       startRun, resumeOnReply, resumeOnTimer, stopRun, step loop
  scheduler.ts    relógio: a cada 5 s pega bot_runs vencidos (FOR UPDATE SKIP LOCKED) e retoma
  validators.ts   CPF, CNPJ, e-mail, telefone BR, regex própria, tipos de mídia
  templates.ts    modelo "Fluxo do escritório"
  routes.ts       API REST dos bots (admin) e de execução manual (usuários)
web/src/pages/settings/bots/   lista de chatbots
web/src/components/bot-editor/ editor (React Flow), paleta, cartões de bloco, versões
```

- **Registro único de blocos:** servidor e web compartilham os **tipos** e a lista de saídas de cada bloco via `shared/src/bots.ts` (tipos + `BLOCK_CATALOG` com `type`, `category`, `label` pt-BR, `description`, e a função pura `outputsOf(type, config)`), para que o editor desenhe exatamente as saídas que o motor usa.
- **Integração com o núcleo:** só por funções existentes — `messages/send.ts` (envio do sistema, mesma regra de echo/markSent), `inbox/chats.ts` (transferir, privar, finalizar), `inbox/events.ts` (`addEvent`), `contacts/service.ts` (campos, etiquetas, bloqueio), `messages/quick-answers.ts` (renderização de variáveis), `realtime/hub.ts` (publicações). Nenhum envio ao WhatsApp dentro de transação.
- **Novas dependências (web, versões exatas fixadas no plano):** `@xyflow/react`, `@dagrejs/dagre`. Nenhuma dependência nova no servidor.

## 3. Modelo de dados (migration nova)

| Tabela | Campos | Restrições |
|---|---|---|
| `bots` | id, name, description, status (`active`\|`paused`), start_channel_ids (uuid[]; vazio = não inicia por canal), manual_start (bool), manual_title, manual_unlisted (bool), published_version_id, run_count (int), created_at, updated_at | name único |
| `bot_versions` | id, bot_id, number (int, crescente por bot), graph (jsonb `BotGraph`), valid (bool), created_by, created_at, label (opcional) | `unique(bot_id, number)`; **imutável** depois de criada |
| `bot_runs` | id, bot_id, version_id, chat_id, contact_id, state (`running`\|`waiting_reply`\|`waiting_timer`\|`finished`\|`stopped`\|`failed`), current_node_id, wait_node_id, wake_at (timestamptz, null se não espera tempo), timeout_at (timestamptz; "sem resposta em X h"), vars (jsonb), steps (jsonb: últimos 50 passos `{node, at, outcome}`), depth (int; nível de "acionar outro fluxo"), parent_run_id, started_by (user id ou null = canal), error, created_at, updated_at, finished_at | índice `(state, wake_at)` e `(state, timeout_at)`; **no máximo 1 run não-terminal por (chat, bot)** (índice único parcial) |
| `messages` | + `bot_run_id` (uuid, null) | mensagens enviadas pelo bot |
| `chat_events.kind` | + `bot_started`, `bot_finished`, `bot_stopped`, `bot_failed`, `bot_transferred`, `bot_note` | `data` traz `{ botId, botName, runId, reason? }` |
| `settings` | chave nova `bot_running_behavior`: `ask` (padrão) \| `stop` \| `keep` | |

"Publicar" = salvar uma versão **válida** e apontá-la em `published_version_id`. Rascunhos inválidos são versões com `valid=false` e não podem ser publicados. Execuções ficam presas ao `version_id` em que começaram.

### 3.1 Grafo (`BotGraph`, em `shared/src/bots.ts`)
```ts
interface BotGraph { nodes: BotNode[]; edges: BotEdge[] }
interface BotNode { id: string; type: BlockType; position: { x: number; y: number }; config: Record<string, unknown>; name?: string }
interface BotEdge { id: string; source: string; sourceHandle: string; target: string }
```
- `sourceHandle` é o id da saída (`next`, `yes`, `no`, `opt:<key>`, `invalid`, `timeout`, `error`, `day:mon`…`day:sun`, `case:<i>`, `else`, `branch:<i>`). Cada saída liga a no máximo um bloco; um bloco pode ter várias entradas.
- `name` do nó é o rótulo usado nas variáveis `{{contexto.<name>}}` (único no grafo, só letras, números e `_`; gerado automaticamente a partir do tipo, editável).

## 4. Catálogo de blocos da entrega 2a (39)

Saídas: **next** (padrão), **error** = "se não for possível…". Todo texto aceita variáveis (§5.3).

### Início (2) — sem entrada
| type | Config | Saídas |
|---|---|---|
| `start_channel` | — (os canais ficam em `bots.start_channel_ids`, editados no cartão) | next |
| `start_manual` | — (título e "não listado" em `bots.manual_*`) | next |
Um grafo tem no máximo um bloco de cada tipo de início e pelo menos um.

### Condição (17)
| type | Config | Saídas |
|---|---|---|
| `weekdays` | timezone (padrão `America/Cuiaba`) | `day:mon`…`day:sun` |
| `hours` | timezone, intervals `[{from:'08:00', to:'12:00', days?: weekday[]}]` | `in`, `out` |
| `wait_interval` | mode `fixed`\|`variable`, amount, unit `seconds`\|`minutes`\|`hours`\|`days`, variable (se variable), resumeOnReply (bool) | next (`replied` se resumeOnReply e o contato respondeu antes) |
| `condition` | logic `and`\|`or`, rules `Rule[]` | yes, no |
| `multi_condition` | cases `[{ label, logic, rules }]` | `case:<i>`…, `else` |
| `value` | left (variável/campo), operator, right | yes, no |
| `distribute` | branches `[{ label, weight }]` (pesos inteiros > 0) | `branch:<i>` |
| `contact_active` | — (mensagem `in` nas últimas 24 h) | yes, no |
| `first_chat` | — (primeira conversa do contato neste canal) | yes, no |
| `contact_field` | fieldId (campo personalizado ou nativo: nome, e-mail, telefone fixo, cidade, estado), operator, value | yes, no |
| `tags` | mode `any`\|`all`\|`none`, tagIds (do contato) | yes, no |
| `chat_sector` | sectorIds | yes, no |
| `chat_channel` | channelIds | yes, no |
| `chat_agent` | mode `none`\|`any`\|`specific`, userIds | yes, no |
| `chat_status` | — (conversa em "Esperando") | yes, no |
| `message_contains` | keywords[], match `any`\|`all`, ignoreCase/accents (sempre) | yes, no |
| `parallel_bot` | — (existe outra execução não-terminal na mesma conversa) | yes, no |

`Rule = { left: Operand, operator: 'eq'|'neq'|'contains'|'not_contains'|'starts'|'gt'|'gte'|'lt'|'lte'|'empty'|'not_empty', right?: Operand }`, `Operand = { kind: 'var'|'field'|'literal', value: string }`. Comparação numérica quando os dois lados são números; senão texto normalizado (sem acento, minúsculas, trim).

### Ação (18)
| type | Config | Saídas |
|---|---|---|
| `send_message` | text, attachment? (arquivo da biblioteca de mídia do bot, salvo em `mediaDir/bots/`), signature: false | next, error |
| `note` | text | next |
| `ask_choice` | text, options `[{ key: '1', label: 'Atendimento' }]` (a mensagem enviada lista `key: label`), invalidText?, invalidRetries (0–3, padrão 1), timeoutHours? | `opt:<key>`…, `invalid`, `timeout`, error |
| `ask_input` | text, validator `any`\|`email`\|`phone`\|`cpf`\|`cnpj`\|`media`\|`regex`, mediaTypes? (`pdf`\|`audio`\|`image`\|`video`)[], regex?, useLastMessage (bool), invalidText?, invalidRetries, timeoutHours?, saveToField? | next, `invalid`, `timeout`, error |
| `set_contact_field` | fieldId, value (texto com variáveis) | next, error |
| `edit_tags` | add tagIds, remove tagIds (do **contato**) | next, error |
| `transfer_sector` | sectorId, onlyIfAgentAllowed (bool: só se o dono atual pertence ao setor de destino; senão o dono é limpo) | next, error |
| `transfer_agent` | rule `specific`\|`least_busy`, userIds (specific: o primeiro ativo da lista; least_busy: entre os atendentes ativos dos setores escolhidos, quem tem menos conversas abertas), sectorIds (least_busy) | next, error |
| `privacy` | mode `private`\|`public` | next, error |
| `notify_agent` | title, text, target `owner`\|`users`, userIds | next, error |
| `call_flow` | botId (bot com início manual ou qualquer bot publicado), continueAfter (bool: volta para a saída next quando o fluxo chamado termina) | next, error |
| `block_contact` | — (bloqueia o contato, finaliza as conversas dele e encerra o run) | — (terminal), error |
| `close_chat` | sendClosingMessage (bool), closingText? | — (terminal) |

> Contagem: Início 2 + Condição 17 + Ação 12 (`send_message`, `note`, `ask_choice`, `ask_input`, `set_contact_field`, `edit_tags`, `transfer_sector`, `transfer_agent`, `privacy`, `notify_agent`, `call_flow`, `block_contact`) + Finalização 1 (`close_chat`) + Utilitário 1 (`sticky_note`) = **33 tipos**. (Na conversa as ações foram contadas como 18 por engano; a lista de blocos aprovada é exatamente esta.) `ask_choice` aceita a chave ("1") ou o rótulo/nome do setor, sem acento e sem diferença de maiúsculas, como a triagem.

### Utilitário (1)
| `sticky_note` | text, color | — (não executa, não conecta) |

### Fica para 2b
Pedir para avaliar · Pedir feedback escrito · Etiquetas **da conversa** · Mensagem para equipe · Fluxo de espera · Presença do atendente (e "notificar só se online") · Aguardar até (data/hora) · Status esperando (ação) · Visibilidade da conversa · Excluir contato (com regra LGPD). **2c:** Webhook · Pipedrive · Asaas.

## 5. Motor

### 5.1 Início
- **Por canal:** em `messages/ingest.ts`, quando uma conversa é **criada** por mensagem `in` (mesmo ponto onde hoje roda `startTriage`), procurar bots `active` com publicação válida cujo `start_channel_ids` contém o canal; se houver, iniciar o **mais antigo** (`created_at`) e **não** rodar a triagem. Sem bot → triagem como hoje.
- **Manual:** `POST /api/chats/:id/bot-runs { botId }` (usuário que `canSee` a conversa; bot `active`, com `manual_start`). Se já houver run não-terminal do mesmo bot na conversa → 409.
- `bots.run_count += 1` a cada início. Evento `bot_started` na conversa.

### 5.2 Laço de passos
`step(run)`: carrega a versão, executa o nó atual pelo `registry`, aplica o resultado:
- `{ next: handleId }` → segue a aresta; aresta inexistente → `finished`.
- `{ wait: 'reply', timeoutAt? }` → `waiting_reply` (guarda `wait_node_id`, `timeout_at`).
- `{ wait: 'timer', wakeAt }` → `waiting_timer`.
- `{ end: 'finished' | 'failed', error? }`.
- Erro lançado por uma ação → saída `error` se ligada; senão `failed` com `error` e evento `bot_failed`.
- Limite: 50 passos por chamada de `step` sem espera → `failed` ("laço"). `call_flow`: profundidade máxima 5.
- O estado é gravado após cada passo. Envios ao WhatsApp acontecem fora da transação que grava o passo (envia → grava resultado), reutilizando o envio de sistema do núcleo (echo/markSent).

### 5.3 Variáveis
- Respostas de `ask_choice`/`ask_input` ficam em `vars[node.name]` = `{ raw, value, label? }`; `{{contexto.<name>}}` = valor normalizado (CPF só dígitos formatado `000.000.000-00`), `{{contexto.<name>:raw}}` = texto original.
- Também disponíveis as variáveis das respostas rápidas (§5.7 do núcleo): `{{contato.*}}`, `{{campo.<nome>}}`, `{{atendente.*}}` (atendente = dono da conversa; vazio se não houver).
- Renderização pela mesma função das respostas rápidas, estendida com o prefixo `contexto`.

### 5.4 Retomadas
- **Resposta do contato:** em `ingest.ts`, para mensagem `in` numa conversa com run `waiting_reply`, chamar `resumeOnReply(run, message)` após o commit. A execução trava a própria linha (`SELECT … FOR UPDATE`) — duas mensagens simultâneas são processadas uma de cada vez; a segunda encontra o run já avançado e é tratada pelo novo estado.
- **Relógio (`scheduler.ts`):** a cada 5 s (`setInterval`, iniciado em `index.ts`, parado no shutdown), `SELECT … WHERE (state='waiting_timer' AND wake_at <= now()) OR (state='waiting_reply' AND timeout_at <= now()) ORDER BY … LIMIT 50 FOR UPDATE SKIP LOCKED` e retoma cada um (saída `timeout` ou continuação do `wait_interval`). Sem polling em testes: o relógio expõe `tick(now)` para ser chamado com um relógio falso.
- **Reinício do servidor:** nada a fazer além do relógio — os estados estão no banco.

### 5.5 Interação com atendentes
- `settings.bot_running_behavior` (§3) decide o que ocorre quando um atendente envia mensagem (`sendAgentMessage`) numa conversa com run não-terminal:
  - `stop`: para os runs (`stopped`, evento `bot_stopped {by}`) e envia.
  - `keep`: envia e mantém.
  - `ask`: o servidor responde **409 `{ error, code: 'BOT_RUNNING', runs: [{id, botName}] }`** se o pedido não trouxer `botAction`; o cliente mostra "O chatbot está rodando. Parar e enviar? / Enviar e manter / Cancelar" e reenvia com `botAction: 'stop' | 'keep'`.
- Notas internas nunca afetam o bot.
- Finalizar a conversa (manual ou por bloco) para todos os runs da conversa. Transferência manual segue `bot_running_behavior` (`ask` ⇒ a tela pergunta antes de transferir).
- `POST /api/bot-runs/:id/stop` — quem `canSee` a conversa.

### 5.6 Permissões e visibilidade
- CRUD, publicação, pausa e versões de bots: **admin**. Listar bots com início manual e iniciar/parar runs: qualquer usuário, só em conversas que `canSee`.
- O bot age como sistema (`author_id = null`, `bot_run_id` preenchido): não passa por `canSee`, mas cada ação relevante grava `chat_events` com `botName` e publica `chat.updated`, mantendo a barreira entre setores para quem vê.

## 6. API (novas rotas; zod; Origin em toda mutação)
| Método e rota | Corpo | Retorno | Acesso |
|---|---|---|---|
| GET `/api/bots` | — | `BotDto[]` | admin |
| POST `/api/bots` | `{ name, description? }` (cria versão 1 com `start_channel` → `send_message` "Olá!") | `BotDto` | admin |
| GET/PATCH/DELETE `/api/bots/:id` | PATCH `{ name, description, startChannelIds, manualStart, manualTitle, manualUnlisted }` | `BotDto` | admin; DELETE 409 se há runs não-terminais ou se outro bot o chama (`{ usedBy: [...] }`) |
| POST `/api/bots/:id/duplicate` | — | `BotDto` | admin |
| GET `/api/bots/:id/versions` · GET `/api/bots/:id/versions/:n` | — | `BotVersionDto[]` / `BotVersionDto` (com grafo) | admin |
| POST `/api/bots/:id/versions` | `{ graph, label?, publish: boolean }` → valida; `publish` exige válido (400 com `problems: [{ nodeId, message }]`) | `BotVersionDto` | admin |
| POST `/api/bots/:id/status` | `{ status: 'active'|'paused' }` (ativar exige versão publicada) | `BotDto` | admin |
| POST `/api/bots/import` · GET `/api/bots/:id/export` | JSON `{ name, graph }` | `BotDto` / arquivo | admin |
| GET `/api/bots/manual` | — | `[{ id, title }]` (ativos, `manual_start`, não "não listado") | usuário |
| POST `/api/chats/:id/bot-runs` | `{ botId }` | `BotRunDto` | usuário com `canSee` |
| GET `/api/chats/:id/bot-runs` | — | `BotRunDto[]` (não-terminais) | usuário com `canSee` |
| POST `/api/bot-runs/:id/stop` | — | `BotRunDto` | usuário com `canSee` |
| POST `/api/chats/:id/messages` | + `botAction?: 'stop'|'keep'` | — | como hoje |

WS: `chat.updated` já cobre mudanças; mensagens do bot saem como `message.created` (com `botName` no `MessageDto`: `botRunId`, `botName`).

## 7. Telas
- **Configurações › Chatbots** (admin): tabela nome, canais, situação, execuções, atualizado em; ações editar, ativar/pausar, duplicar, exportar, excluir (com lista "usado por" no 409); botões Novo chatbot e Importar.
- **Editor** (`/configuracoes/chatbots/:id`, tela cheia):
  - React Flow com fundo de pontos, minimapa, zoom, ajustar à tela; `dagre` para **auto-organizar**.
  - **Paleta** lateral por categoria com busca; atalho **Tab** abre/fecha; arrastar ou clicar insere o bloco.
  - **Cartões** com configuração inline (inputs, selects de setores/atendentes/campos/etiquetas/canais carregados da API), saídas nomeadas à direita, cor por categoria, ícones Phosphor; destaque vermelho e lista de problemas ao salvar.
  - Barra: desfazer/refazer (histórico local de 50 passos), auto-organizar, salvar rascunho, **salvar e publicar**, ativar/pausar (indicador), versões (lista com número, data, autor, rótulo; visualizar e restaurar como novo rascunho), nome editável, exportar.
  - Aviso ao sair com alterações não salvas.
- **Conversa:** mensagens do bot com ícone de robô e "Chatbot <nome>"; eventos `bot_*` na linha do tempo; botão **robô** no compositor → painel "Executar chatbot" (lista manual) e, com run ativo, **Parar chatbot**; diálogo de confirmação para `ask`.
- **Configurações › Conversas:** "Quando o atendente enviar mensagem com chatbot em execução": Perguntar (padrão) · Parar o bot · Manter rodando.

## 8. Modelo "Fluxo do escritório"
Botão **"Criar a partir do modelo"** na lista. Na criação, o admin escolhe o canal e mapeia três destinos (setores Atendimento, Financeiro, Jurídico/Processos e, opcionalmente, o atendente de cada um); textos e horários ficam editáveis depois. Grafo:
1. `start_channel` → `hours` (`America/Cuiaba`; intervalos padrão seg–sex 08:00–12:00 e 14:00–18:00, editáveis).
2. `out` → `send_message` "Estamos fora do horário de atendimento. Deixe sua mensagem que retornaremos assim que possível." → fim (a conversa **não** é finalizada: fica aberta na fila do setor padrão).
3. `in` → `send_message` boas-vindas: "Olá {{contato.primeiro_nome}}! 👋 Sou o assistente virtual da {{empresa}}. Como posso te ajudar hoje?" (`{{empresa}}` preenchido na criação com o nome do escritório).
4. → `ask_choice` "Escolha uma das opções abaixo digitando o número correspondente:" com `1: Atendimento`, `2: Financeiro`, `3: Processos`; `invalid` → repete 1 vez; `timeout` 24 h → fim.
5. Cada opção → `send_message` comunicado ("⚠️ COMUNICADO — Informamos que nosso WhatsApp está com uma demanda muito alta no momento. Por isso, pedimos um prazo de até 2 dias úteis para retorno. Enquanto isso, deixe aqui sua dúvida ou necessidade. Agradecemos a compreensão! 🤝").
6. → `ask_input` "Para agilizar, digite seu CPF:" validator `cpf`, `saveToField` = campo personalizado CPF (criado se não existir), `invalid` → "CPF inválido, confira e digite de novo." (2 tentativas) → segue mesmo assim.
7. → `transfer_sector` (setor da opção) → `transfer_agent` (se mapeado) → `notify_agent` (dono) "Nova conversa de {{contato.nome}} — CPF {{contexto.cpf}}" → fim.

## 9. Erros
| Situação | Comportamento |
|---|---|
| Ação falha (setor/atendente/campo inexistente, envio falhou) | saída `error`; sem ela → `failed`, evento `bot_failed {reason}`, conversa segue com os atendentes |
| Servidor reinicia | estados no banco; relógio retoma vencidos |
| Laço / encadeamento | 50 passos sem espera ou 5 níveis → `failed` |
| Fluxo editado/pausado com runs ativos | runs seguem na versão deles; pausar só bloqueia novos inícios |
| Mensagens simultâneas | `FOR UPDATE` no run |
| Bot apagado com runs | proibido (409) |
| Grafo inválido | não publica; rascunho salvo com `valid=false` e lista de problemas |

## 10. Testes
- **Unitários:** cada bloco de condição/ação (saídas e efeitos, com ctx de teste), `validateGraph` (blocos sem entrada, saídas obrigatórias, referências inexistentes, nomes duplicados, inícios), validadores (CPF/CNPJ com dígito verificador, e-mail, telefone BR, regex inválida), `distribute` (seed determinística), `hours`/`weekdays` com fuso e virada de dia, renderização de `{{contexto.*}}`, `outputsOf`.
- **Integração (PGlite + gateway falso + relógio falso `tick(now)`):** início por canal (e prioridade sobre a triagem), início manual (e 409 duplicado), pergunta/resposta válida/inválida/timeout, `wait_interval` com e sem `resumeOnReply`, versão presa ao run, "reinício" (novo ctx sobre o mesmo banco), duas respostas simultâneas, `call_flow` com `continueAfter` e limite de profundidade, laço de 50 passos, as três opções de `bot_running_behavior` (incluindo 409 `BOT_RUNNING` e reenvio com `botAction`), finalizar para o bot, saída `error` e `failed`, **o modelo do escritório de ponta a ponta**.
- **Web:** validação e destaque de problemas, salvar/publicar/restaurar versão, paleta (busca/Tab), `outputsOf` refletido nos handles, diálogo `BOT_RUNNING` no compositor, painel "Executar chatbot".
- **Aceite manual:** o critério de §1 no ambiente local com o número de teste.

## 11. Restrições
As do plano do núcleo (Global Constraints): versões fixadas (inclui as duas novas do web), nunca logar corpo de mensagem, `canSee`/`visibleChatsWhere` em toda leitura por usuário, Origin em toda mutação, nenhum envio ao WhatsApp dentro de transação, commits Conventional com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

# Lista de conversas no dia a dia (ordenar, seleção em massa, etiquetas da conversa) — design

- **Data:** 20/10/2026 · **Status:** decisões tomadas pelo controlador (o usuário dispensou mais perguntas) — aguardando revisão desta spec
- **Branch:** `feat/lista-dia-a-dia` (a partir de `feat/redesign-tinta-e-latao`). **Entrega 2:** é executada **depois** que a entrega 1 (`feat/conversa-dia-a-dia`, spec `2026-10-19-conversa-dia-a-dia-design.md`) for integrada, por cima dela.
- **Base:** núcleo `2026-10-14-nucleo-atendimento-design.md` (abas, filtros, transferir/finalizar, barreira de setor, chatbot rodando §5.5) e a lista atual (`server/src/inbox/queries.ts` `listChats`, `web/src/pages/Inbox.tsx`).
- **Plano:** `docs/superpowers/plans/2026-10-20-lista-dia-a-dia.md`.

## 1. Objetivo
Três coisas da lista de conversas que o escritório usa todo dia e ainda faltam: escolher a ordem da lista (inclusive "quem espera há mais tempo"), agir em várias conversas de uma vez (transferir, finalizar, marcar como lida) e classificar a **conversa** com etiquetas próprias, separadas das etiquetas do contato.

## 2. Regras gerais
- Toda leitura e mutação passa pelas mesmas regras de hoje: quem não vê a conversa (`canSee`, que já cobre a conversa privada) recebe **404**; toda mutação nova é uma rota `/api/*` não-GET (checagem de Origin global).
- Logs nunca levam texto de mensagem, telefone ou nome (só ids, contagens e nome do erro).
- Migração gerada pelo drizzle-kit (`0007_lista_dia_a_dia`), nunca editada à mão. Ela vem depois da `0006` da entrega 1.
- Campos novos nos DTOs são opcionais (literais antigos continuam compilando; o servidor sempre preenche).
- Nenhuma dependência nova. Textos de interface em pt-BR; identificadores em inglês; cores só pelos tokens do tema (as cores das etiquetas continuam vindo da paleta delas, como hoje).

## 3. Ordenar a lista
- Botão **"Ordenar conversas"** ao lado do botão de filtro: ícone de setas; ao clicar abre a lista nativa do navegador (um `<select>` invisível sobre o ícone, então teclado, leitor de tela e celular funcionam). A dica (title) mostra a ordem atual ("Ordenar: …"); fora da ordem padrão o ícone fica na cor de destaque.
- Opções:
  - **"Última mensagem: mais recentes"** — padrão, é a ordem de hoje (`coalesce(last_message_at, created_at)` decrescente).
  - **"Última mensagem: mais antigas"** — a mesma chave, crescente.
  - **"Data de criação: mais recentes"** / **"Data de criação: mais antigas"** — `chats.created_at`.
  - **"Esperando há mais tempo"** — primeiro as conversas **esperando resposta** (`waiting = true`), a que espera **há mais tempo no topo**; depois as demais, pela última mensagem, mais recentes primeiro. Sem "mais recentes/mais antigas": a opção já é uma direção só.
- **Decisão (desde quando espera):** nova coluna `chats.waiting_since` = horário da **mensagem mais antiga do contato ainda sem resposta**.
  - Mensagem do contato: `waiting_since = least(waiting_since, horário da mensagem)` (a primeira da sequência fica; uma mensagem atrasada mais antiga puxa para trás).
  - Resposta do atendente pelo sistema, mensagem enviada pelo celular do escritório e **finalizar** (atendente ou chatbot) zeram (`null`), junto com o `waiting = false` que já acontece hoje.
  - Mensagem do **chatbot ou da triagem** não mexe (hoje ela também não mexe em `waiting`).
  - Conversas que já estavam esperando antes da migração não têm o horário: usam a última mensagem (`coalesce(waiting_since, last_message_at, created_at)`). Não há preenchimento retroativo (migração só gerada, sem SQL à mão).
- Na aba **Finalizados** nenhuma conversa espera, então "Esperando há mais tempo" fica igual a "Última mensagem: mais recentes" (a opção continua disponível).
- **Fixadas continuam no topo**, na primeira página, na mesma ordem escolhida.
- **Paginação por cursor correta em toda ordem:** o desempate é sempre o `id`, na mesma direção da chave. "Esperando há mais tempo" é feita de duas partes (esperando ↑, demais ↓), cada uma com o seu cursor simples; a página continua na parte seguinte quando uma acaba. O cursor guarda a ordem: um cursor de outra ordem, ou do formato antigo, recebe **400 "Cursor inválido"** (a tela recomeça a lista quando a ordem muda).
- **Decisão (onde fica guardada):** por usuário, **no navegador** (`localStorage`, chave `talk.chatSort.<id do usuário>`; a ordem padrão não é gravada). Leitura e gravação dentro de `try/catch`: com o armazenamento bloqueado (janela privada) vale a padrão e a escolha dura até recarregar. Não usa as preferências do servidor da entrega 1.
- O contador de não lidas das abas continua contando a lista na ordem padrão (como hoje).

## 4. Seleção em massa
- Botão **"Selecionar"** no topo da lista (ao lado de "Nova"). Ligado:
  - cada conversa ganha uma caixa de seleção ("Selecionar <contato>"); clicar na linha marca/desmarca em vez de abrir a conversa; o menu "⋮" da linha some;
  - aparece uma barra no rodapé da lista: **"N selecionadas"** ("1 selecionada"), **"Transferir"**, **"Finalizar"**, **"Marcar como lida"**, **"Cancelar"** (sai do modo seleção).
- **Limite:** no máximo **50** por vez (`BULK_MAX`). Com 50 marcadas, as outras caixas ficam desabilitadas com a dica "Até 50 conversas por vez". O servidor recusa mais de 50 (400).
- A seleção zera ao trocar de aba, busca, filtro ou ordem. Uma conversa que sai da lista (transferida por outra pessoa, finalizada, removida) sai da contagem e do pedido.
- Na aba **Finalizados**, "Transferir" e "Finalizar" ficam desabilitados (só "Marcar como lida").
- **Decisão (servidor):** uma rota por ação, que roda **as mesmas regras da ação individual** conversa por conversa, **uma de cada vez**, e devolve o resultado de cada uma:
  - `POST /api/chats/bulk/transfer` `{ chatIds, sectorId?, ownerId? }`
  - `POST /api/chats/bulk/close` `{ chatIds, sendClosingMessage }`
  - `POST /api/chats/bulk/read` `{ chatIds }`
  - Resposta **200** `{ done: chatId[], failed: [{ chatId, error }] }`, mesmo quando todas falham. Ids repetidos contam uma vez.
- Regras por conversa (iguais às individuais): não vê → "Conversa não encontrada" (não revela nada, nada é enviado); transferir/finalizar uma conversa finalizada → o motivo da ação individual ("Conversa finalizada", "A conversa já está finalizada"); conversa alterada por outra pessoa no meio → o motivo de hoje. O motivo é a mensagem pt-BR da ação individual sem o ponto final.
- **Transferir em massa:**
  - O destino (setor e/ou atendente, mesmo diálogo "Transferir" de hoje, com o título "Transferir N conversas") é validado **uma vez**, antes de tudo: destino inválido → 400 e nada muda (nem chatbot é parado).
  - **Decisão (chatbot rodando):** não dá para perguntar conversa por conversa. Com a configuração do escritório em "Manter", o chatbot continua; em "Parar" **ou "Perguntar"**, o chatbot da conversa é **parado** (como ao finalizar). Nunca devolve o 409 `BOT_RUNNING`.
- **Finalizar em massa:**
  - Mesmo diálogo "Finalizar" de hoje, com o título "Finalizar N conversas": **uma** escolha de "Enviar mensagem de encerramento" para todas (ligada por padrão quando há mensagem configurada).
  - Cada conversa segue o fluxo individual: a mensagem vai antes de fechar; se o envio falhar, **aquela** conversa continua aberta (com a bolha de falha para reenviar) e entra nas falhas com "Mensagem de encerramento não enviada; a conversa continua aberta"; as outras seguem. Chatbots da conversa finalizada param, como hoje.
  - Uma de cada vez: com mensagem de encerramento, 50 conversas levam alguns segundos (um envio por conversa).
- **Marcar como lida em massa:** o mesmo "lida" de abrir a conversa (zera não lidas), em conversas abertas ou finalizadas.
- **Resultado na tela:** uma linha (status, não erro) logo acima da lista: **"X de N concluídas."** ou **"X de N concluídas; Y não puderam: <motivo>"** (cada motivo diferente uma vez, separados por " / "; "1 não pôde"; "1 de 1 concluída."). Ela fica até a próxima ação ou até ligar "Selecionar" de novo.
  - Tudo concluído → sai do modo seleção.
  - Houve falha → continua no modo seleção só com as que falharam marcadas.
- As outras telas recebem cada mudança pelo WebSocket, como nas ações individuais (um `chat.updated` por conversa).

## 5. Etiquetas da conversa
- **Decisão (catálogo):** as mesmas etiquetas de **Configurações → Etiquetas** (nome, emoji, cor). Uma etiqueta pode estar no contato, na conversa ou nos dois; são marcações separadas. Nova tabela `chat_tags` (conversa ↔ etiqueta).
- Quem vê a conversa pode marcar e desmarcar, em conversa **aberta, finalizada ou de histórico** (é marcação interna; nunca vai ao WhatsApp). **Decisão:** não gera evento na linha do tempo.
- Finalizar mantém as etiquetas; reabrir também. Juntar contatos do histórico (LID ↔ telefone) que funde duas conversas leva as etiquetas da conversa absorvida para a que fica.
- Excluir a etiqueta no catálogo tira ela de todas as conversas (cascata), como já acontece com os contatos.
- `PUT /api/chats/:id/tags` `{ tagIds }` (até 50; etiqueta inexistente → 400 "Etiqueta inexistente") troca o conjunto e devolve o `ChatDetail`. As telas abertas atualizam pelo `chat.updated`.
- **Onde aparece:**
  - **Cartão da lista:** uma linha de etiquetas abaixo de setor/atendente, primeiro as da conversa, depois as do contato, no máximo 4 e "+N". **Visualmente diferentes:** etiqueta da **conversa** = preenchida na cor da etiqueta, com um balãozinho de conversa; etiqueta do **contato** = só contorno na cor. Dica ao passar o mouse: "Etiqueta da conversa: <nome>" / "Etiqueta do contato: <nome>".
  - **Edição:** painel lateral, aba **"Detalhes da conversa"**, seção **"Etiquetas da conversa"** (os mesmos botões liga/desliga do contato). **Decisão:** o cabeçalho da conversa não muda nesta entrega.
  - **Filtro:** no painel de filtros, novo campo **"Etiqueta da conversa"**; o campo atual "Etiqueta" passa a se chamar **"Etiqueta do contato"**. Os dois podem ser usados juntos.
- Os blocos de etiqueta do chatbot continuam valendo só para as etiquetas do contato.
- Ordem das etiquetas: a do catálogo (posição, depois nome).

## 6. Dados e API
- `chats.waiting_since timestamptz null`.
- `chat_tags` (`chat_id uuid → chats on delete cascade`, `tag_id uuid → tags on delete cascade`, chave primária `(chat_id, tag_id)`).
- `shared`: `CHAT_SORTS` (`'last_desc' | 'last_asc' | 'created_desc' | 'created_asc' | 'waiting'`), `ChatSort`, `DEFAULT_CHAT_SORT = 'last_desc'`, `BULK_MAX = 50`, `BulkResultDto { done: string[]; failed: Array<{ chatId: string; error: string }> }`.
- `ChatListFilters` ganha `sort?: ChatSort` e `chatTagId?: string`; `ChatListItem` (e o DTO do WebSocket, que é o mesmo) ganha `chatTagIds?: string[]`.
- `GET /api/chats` aceita `sort` e `chatTagId`; o cursor passa a carregar a ordem.
- Rotas novas: `PUT /api/chats/:id/tags`, `POST /api/chats/bulk/transfer`, `POST /api/chats/bulk/close`, `POST /api/chats/bulk/read`.

## 7. Interface (textos exatos)
- Lista: botão "Selecionar"; controle "Ordenar conversas" (dica "Ordenar: <opção>") com "Última mensagem: mais recentes", "Última mensagem: mais antigas", "Data de criação: mais recentes", "Data de criação: mais antigas", "Esperando há mais tempo".
- Seleção: caixa "Selecionar <contato>"; dica "Até 50 conversas por vez"; barra "N selecionadas" / "1 selecionada", "Transferir", "Finalizar", "Marcar como lida", "Cancelar"; diálogos "Transferir N conversas" / "Finalizar N conversas" ("1 conversa"); resultado "X de N concluídas." / "X de N concluídas; Y não puderam: <motivo>" / "1 não pôde"; motivos "Conversa não encontrada", "Erro inesperado" e os das ações individuais.
- Etiquetas: dicas "Etiqueta da conversa: <nome>" / "Etiqueta do contato: <nome>"; seção "Etiquetas da conversa"; filtros "Etiqueta do contato" e "Etiqueta da conversa".

## 8. Testes
- Ordem: cada uma das cinco ordens; "Esperando há mais tempo" com conversa antiga sem `waiting_since`; paginação que passa por toda conversa exatamente uma vez em toda ordem (inclusive na virada esperando → demais e com chaves iguais); cursor de outra ordem e do formato antigo → 400; fixadas no topo em toda ordem.
- `waiting_since`: primeira mensagem do contato, mensagens seguintes, resposta do atendente, mensagem do celular, finalizar, mensagem do chatbot/triagem.
- Massa: resultados por conversa (feita, finalizada, invisível, repetida); chatbot parado em "Perguntar" e mantido em "Manter"; destino inválido → 400 sem efeito; finalizar com falha da mensagem de encerramento em uma; marcar como lida só nas visíveis; mais de 50, lista vazia e sem Origin.
- Etiquetas da conversa: trocar o conjunto, separadas das do contato, em conversa finalizada e após reabrir, 400/404/403, ordem do catálogo, exclusão no catálogo, fusão de contatos, filtro, DTO do WebSocket.
- Web: resumo do resultado; ordem lembrada por usuário e com armazenamento bloqueado; cartão com as duas etiquetas diferentes e o "+N"; modo seleção (caixa, clique na linha, menu escondido, limite); barra e resultado na Entrada.

## 9. Aceite manual
Escolher "Esperando há mais tempo" e conferir que a conversa que espera há mais tempo está no topo; recarregar a página e a ordem continuar; rolar uma lista longa em "Data de criação: mais antigas" sem repetir nem pular conversa; selecionar 3 conversas (uma de outra aba finalizada antes por outra pessoa) e transferir — ver "2 de 3 concluídas; 1 não pôde: Conversa finalizada"; finalizar em massa com mensagem de encerramento e ver a mensagem no celular de teste; marcar como lidas; pôr a etiqueta "Prazo" numa conversa e ver o chip preenchido no cartão ao lado do chip contornado da etiqueta do contato; filtrar por "Etiqueta da conversa"; finalizar e reabrir mantendo a etiqueta.

## 10. Fora do escopo
"Selecionar todas" (inclusive páginas não carregadas), desfazer uma ação em massa, ações em massa além das três (fixar, etiquetar, excluir), ordenar por outros campos, mostrar "esperando há X" no cartão, etiquetas da conversa no cabeçalho ou como evento na linha do tempo, guardar a ordem no servidor, etiquetas da conversa nos blocos do chatbot.

# Conversa no dia a dia (notas, busca, favoritas, preferências) — design

- **Data:** 19/10/2026 · **Status:** decisões tomadas pelo controlador (o usuário dispensou mais perguntas) — aguardando revisão desta spec
- **Branch:** `feat/conversa-dia-a-dia` (a partir de `feat/redesign-tinta-e-latao`)
- **Base:** núcleo `2026-10-14-nucleo-atendimento-design.md` e ações de mensagem `2026-10-16-acoes-mensagem-design.md` (fluxo de edição, `message_edits`, tag "editada", menu da bolha).
- **Plano:** `docs/superpowers/plans/2026-10-19-conversa-dia-a-dia.md`.

## 1. Objetivo
Quatro coisas que o atendente usa todo dia e ainda faltam: corrigir ou apagar uma nota interna, achar uma mensagem antiga dentro da conversa, marcar mensagens importantes para a equipe e ajustar o próprio jeito de trabalhar (Enter, som, notificações do navegador).

## 2. Regras gerais
- Toda leitura e mutação passa por `getChatForUser`: quem não vê a conversa (`canSee`) recebe **404**. Toda mutação nova é uma rota `/api/*` não-GET (checagem de Origin global, como hoje).
- Notas, favoritas, busca e preferências **nunca chamam a Evolution**.
- Logs nunca levam texto de mensagem, telefone ou nome (só ids e nome/código do erro). Os dados de eventos novos também não levam texto.
- Migração gerada pelo drizzle-kit (`0006_conversa_dia_a_dia`), nunca editada à mão. Campos novos nos DTOs são opcionais (literais antigos continuam compilando; o servidor sempre preenche).
- Nenhuma dependência nova. Textos de interface em pt-BR; identificadores de código em inglês; cores só pelos tokens do tema.

## 3. Notas internas: editar e apagar
- Menu da bolha de uma **nota** (só em conversa aberta):
  - **"Editar nota"**: só o **autor** da nota. Reusa o fluxo de edição atual: a bolha vira caixa de texto (Enter salva, Esc cancela), `PATCH /api/messages/:id` `{ text }` (1–4096 caracteres), o texto anterior vai para `message_edits` (`source='office'`, `edited_by` = autor) e a bolha mostra a tag **"editada"**, que abre as versões anteriores.
  - **"Apagar nota"**: o **autor ou um administrador**. Confirmação **"Apagar nota?"** / **"A nota sai da conversa para todos."** (botão "Apagar nota"). `DELETE /api/notes/:id` → 204.
- **Decisão:** nota não tem prazo para editar (não existe janela do WhatsApp para ela).
- **Decisão:** editar nota **não** cria evento na linha do tempo (a tag "editada" e o histórico bastam; o evento "Mensagem editada" ficaria errado para uma nota).
- Apagar remove a linha da nota de verdade (o histórico de edições e a favorita dela vão junto, em cascata) e grava o evento **`note_deleted`** (`data: {}`, autor = quem apagou) — linha do tempo: **"Nota apagada por <nome>"**. As telas abertas recarregam a linha do tempo pelo `chat.updated` (não há evento de mensagem para uma linha que sumiu).
- **Decisão:** a rota de apagar nota só apaga linhas `kind='note'` (o `WHERE` repete a condição); uma mensagem do WhatsApp nunca sai por ela. Segundo clique (nota já apagada) → 404.
- Mensagens recusadas pela regra: 409 com o motivo em pt-BR ("Só quem escreveu a nota pode editá-la", "Só quem escreveu a nota ou um administrador pode apagá-la", "Esta mensagem não é uma nota"); conversa finalizada → 409 "Conversa finalizada".

## 4. Buscar na conversa e ir até a mensagem
- Botão de lupa **"Buscar na conversa"** no cabeçalho (conversa aberta, finalizada ou histórico). Abre uma barra logo abaixo do cabeçalho com a caixa "Buscar nesta conversa…"; **Esc** fecha.
- `GET /api/chats/:id/search?q=` procura só nesta conversa, em: texto, legenda, nota e **nome do arquivo**. Mínimo **2** e máximo **100** caracteres; resultados do **mais novo para o mais antigo**, no máximo **50**, cada um com `messageId`, tipo, direção, **trecho** (até 40 caracteres antes e 80 depois do termo, em uma linha, com "…" quando corta) e data.
- **Decisão (sem maiúsculas/acentos):** a busca ignora maiúsculas e acentos com `translate(lower(coluna), <acentuadas>, <sem acento>)` e a **mesma tabela** em JS (`foldText`, em `shared`). Não usamos a extensão `unaccent`: ela exigiria `CREATE EXTENSION` numa migração escrita à mão, e o drizzle-kit não gera isso. A tabela cobre os acentos do português (á à â ã ä å é è ê ë í ì î ï ó ò ô õ ö ú ù û ü ç ñ ý e as maiúsculas — sob o locale C o `lower()` do Postgres não baixa letra acentuada). `%` e `_` digitados valem como texto.
- **Decisão:** mensagens apagadas para todos entram na busca (o texto continua visível para a equipe); conversas finalizadas e de histórico também.
- Barra: o termo é buscado 300 ms depois da última tecla; mostra **"N resultados"** ("Nenhum resultado", "1 resultado"; com 50 mostra "50+ resultados"), a posição ("3/12"), a data e o trecho do resultado atual. Ao chegar a resposta, vai para o resultado mais novo. **↑** (ou Enter) vai para o anterior (mais antigo), **↓** (ou Shift+Enter) para o próximo (mais novo), dando a volta nas pontas.
- **Ir até a mensagem** (usado pela busca e pelas favoritas):
  - Se a mensagem já está carregada na linha do tempo, rola até ela.
  - Se não está, a linha do tempo entra em **modo âncora**: `GET /api/chats/:id/timeline?around=<id>` traz metade de uma página antes, a mensagem e metade depois; dali ela carrega mais antigas ao rolar para cima (`before=`, como hoje) e mais novas ao rolar para baixo (**novo `after=`**). Um botão flutuante **"Ir para as mensagens recentes"** volta ao fim; chegar ao fim rolando também volta.
  - **Decisão:** o modo âncora usa um cache separado (`['chats','timeline',chatId,'at',messageId]`); a linha do tempo normal continua intacta e recebendo mensagens. No modo âncora chegam só **atualizações** de mensagens já carregadas (reação, favorita, status); mensagem **nova** aparece ao voltar para as recentes.
  - A bolha encontrada ganha um **contorno (token `brass`) por 3 s**.
- `around` aceita só id de mensagem desta conversa; `before`, `after` e `around` são exclusivos (dois juntos → 400).

## 5. Mensagens favoritas
- **Compartilhadas por conversa**: a equipe toda que vê a conversa vê as mesmas favoritas. Nova tabela `message_favorites` (`message_id` chave primária → uma estrela por mensagem; `user_id` de quem marcou; `created_at`).
- Menu da bolha: **"Favoritar"** / **"Remover dos favoritos"**. `PUT /api/messages/:id/favorite` e `DELETE /api/messages/:id/favorite`, ambos devolvem o `MessageDto` e avisam as outras telas (`message.updated`).
- Bolha favorita: estrelinha preenchida (token `brass`) ao lado da hora, com a dica **"Favoritada por <nome>"**.
- Lista **"Favoritas"** na aba **"Detalhes da conversa"** do painel lateral: trecho da mensagem (ou o rótulo da mídia), data e "por <nome>", da estrela mais nova para a mais antiga (até 200); clicar **vai até a mensagem** (§4); no painel em gaveta (tela estreita) a gaveta fecha. Vazia: "Nenhuma mensagem favorita."
- **Decisões:**
  - Vale para **qualquer** mensagem, inclusive **apagada para todos** (o texto segue visível para a equipe, e para um escritório de advocacia marcar "o cliente apagou isto" é justamente útil), notas e mídia.
  - Vale também em conversa **finalizada** e de **histórico** (é marcação interna, não ação no WhatsApp).
  - Qualquer pessoa que vê a conversa marca ou desmarca (é da equipe). Marcar de novo uma já marcada mantém quem marcou primeiro.
  - Nota apagada leva a favorita junto.

## 6. Preferências pessoais
- Por usuário, guardadas no servidor (`users.preferences jsonb`, padrão `{}`; o que falta vem dos padrões):
  - **"Enter envia a mensagem"** — padrão **ligado**. Desligado: Enter quebra a linha e **Ctrl+Enter** (ou Cmd+Enter) envia. Vale para o compositor; a edição na bolha continua "Enter salva".
  - **"Sons"** — padrão **ligado**: um bipe curto (WebAudio, como hoje; sem arquivo) a cada mensagem nova **de contato** — **menos** a da conversa que está aberta na tela com a aba visível.
  - **"Notificações do navegador"** — **"Sempre"** / **"Só quando a aba está em segundo plano"** (padrão) / **"Nunca"**. Também aqui, nada para a conversa aberta na tela com a aba visível.
- **Decisão (padrões):** "Só quando a aba está em segundo plano" mantém o comportamento atual das mensagens. A mesma escolha passa a valer para a notificação do navegador do bloco "Notificar atendente" do chatbot (hoje ela aparece sempre); o aviso dentro do app (toast de 8 s) continua sempre.
- **Decisão (mudança de comportamento):** com "Sons" ligado, o bipe agora toca também com a aba visível, quando a mensagem é de outra conversa (hoje só toca com a aba em segundo plano).
- Página **Configurações → Você → "Preferências"**, para todo usuário (não só admin). Cada mudança salva na hora (`PUT /api/auth/me/preferences` com só os campos alterados → `Me`); a página mostra também o botão "Ativar notificações" do navegador quando a permissão ainda não foi dada.
- **Decisão:** o servidor mescla com `preferences || <campos>` (jsonb) num único `UPDATE`: duas abas salvando campos diferentes ao mesmo tempo não se apagam. Campo desconhecido ou valor inválido → 400. Um valor guardado que o esquema não aceita mais volta aos padrões.
- Outras abas já abertas pegam a mudança ao recarregar (`me` é lido uma vez por aba).

## 7. Dados e API
- `users.preferences jsonb not null default '{}'`.
- `message_favorites` (`message_id uuid pk → messages on delete cascade`, `user_id uuid null → users on delete set null`, `created_at timestamptz default now()`).
- `MessageDto.favorite?: { at: string; byName: string | null } | null`; `Me.preferences?: UserPreferences`; `ChatEventKind` ganha `note_deleted`; novo `MessageSearchHit { messageId, kind, direction, snippet, sentAt }`.
- Rotas novas: `GET /api/chats/:id/search?q=`, `GET /api/chats/:id/favorites`, `PUT|DELETE /api/messages/:id/favorite`, `DELETE /api/notes/:id`, `PUT /api/auth/me/preferences`; `GET /api/chats/:id/timeline` ganha `after` e `around`. `PATCH /api/messages/:id` passa a aceitar nota do próprio autor.

## 8. Interface (textos exatos)
- Menu da bolha: … · Copiar · Baixar arquivo · **Favoritar | Remover dos favoritos** · Editar · Apagar para todos; numa nota: Copiar · Favoritar · **Editar nota** · **Apagar nota**.
- Confirmação: "Apagar nota?" / "A nota sai da conversa para todos." / botão "Apagar nota". Evento: "Nota apagada por <nome>".
- Cabeçalho: botão "Buscar na conversa". Barra: caixa "Buscar mensagens" (placeholder "Buscar nesta conversa…"), "Buscando…", "Nenhum resultado", "1 resultado", "N resultados", "50+ resultados", botões "Resultado anterior", "Próximo resultado", "Fechar busca". Linha do tempo: "Ir para as mensagens recentes", "Carregando mensagens seguintes…".
- Painel: seção "Favoritas", "Nenhuma mensagem favorita.", "por <nome>"; bolha: dica "Favoritada por <nome>".
- Preferências: "Enter envia a mensagem" ("Desligado: Enter quebra a linha e Ctrl+Enter envia."), "Sons" ("Um bipe quando chega mensagem de um contato, menos na conversa que você está vendo."), "Notificações do navegador" com "Sempre", "Só quando a aba está em segundo plano", "Nunca".

## 9. Testes
- Notas: autor edita (histórico, tag, sem Evolution, sem evento); outro usuário não edita; autor e admin apagam, outro agente não; rota de nota recusa mensagem que não é nota; conversa finalizada; 404 para quem não vê.
- Favoritas: marcar/desmarcar, uma estrela por mensagem, lista da conversa, conversa finalizada, apagada para todos, cascata com a nota, 404.
- Busca: texto/legenda/nota/arquivo só desta conversa, ordem, sem maiúsculas/acentos, `%`/`_` literais, trecho, limite 50, 400 abaixo de 2 caracteres, 404.
- Linha do tempo: `around`, `after`, cursores inválidos e exclusivos; web: rola até a carregada, âncora com volta às recentes, cursores das duas pontas, WS atualiza a âncora sem inserir.
- Preferências: padrões, mescla por campo e por usuário, duas gravações simultâneas, 400/403/401; compositor com Enter desligado; regras de som/notificação; toasts do chatbot obedecem; página salva cada mudança.

## 10. Aceite manual
Escrever, editar e apagar uma nota (e ver "Nota apagada por …" na outra aba); como outro atendente, não ver "Editar nota"; buscar "contrato" e "acao" numa conversa longa de histórico, andar com ↑/↓ e cair numa mensagem antiga (contorno, "Ir para as mensagens recentes"); favoritar numa aba e ver a estrela e a lista na outra; desligar "Enter envia" e enviar com Ctrl+Enter; com outra conversa aberta, receber mensagem e ouvir o bipe; "Nunca" sem notificação do navegador.

## 11. Fora do escopo
Busca em todas as conversas, favoritas pessoais, atalhos de teclado globais (Ctrl+F), som configurável ou por arquivo, sincronizar preferências entre abas já abertas.

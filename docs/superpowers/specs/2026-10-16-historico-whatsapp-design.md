# Histórico do WhatsApp e sincronização — design

- **Data:** 16/10/2026 · **Status:** desenho aprovado em conversa (partes 1 e 2; parte 3 decidida pelo Claude a pedido do usuário) — aguardando revisão desta spec
- **Branch:** `feat/historico-whatsapp` (a partir de `develop`) → PR para `develop`
- **Base:** spec do núcleo `2026-10-14-nucleo-atendimento-design.md` (esta spec altera §6 "Evolution" e a regra de visibilidade de `2026-10-15-visibilidade-e-fotos.md` para conversas de histórico)
- **Próxima entrega (fora desta):** ações de mensagem — reagir, apagar para todos, editar, figurinhas, encaminhar, e mostrar quando o cliente apaga/edita.

## 1. Motivação e o que o teste mostrou

1. Em 15/10 às 17:34 (Cuiabá) o WhatsApp encerrou a sessão do sistema (código 401). Ficou 20 h desconectado sem ninguém perceber. Ao ler o QR de novo, o WhatsApp mandou o histórico recente, mas o sistema descartou tudo: a Evolution estava com `DATABASE_SAVE_DATA_HISTORIC=false` e o webhook não assina `MESSAGES_SET`.
2. O usuário quer importar o histórico do celular e não perder mais mensagens.

Teste real de 16/10 (número de teste, `HISTORIC/CHATS/CONTACTS=true`, só contagens, sem ler conteúdo):

| Medida | Resultado |
|---|---|
| Volume de uma leitura de QR | ~46 mil mensagens em ~52 s (início + "recente", progresso 100%) |
| Período | 99,5% de julho/2026 em diante (~3,5 meses); ~200 mensagens soltas até jul/2024 |
| Histórico completo (`syncFullHistory` + identidade "Windows/Desktop") | **Não funciona** na Evolution 2.3.7: o canal nunca gera QR e reconecta ~1×/s sem parar |
| Grupos | 15 mil mensagens de grupos gravadas mesmo com `groupsIgnore` |
| Contatos | 98,5% das mensagens individuais com telefone; 61 de 186 conversas individuais só com LID (código interno), sem telefone; só 2 mapeáveis hoje |
| Mídia | baixável só até ~3 semanas (Evolution não reenvia mídia expirada: HTTP 400 após ~5,5 s); 70% das mídias do histórico já expiradas |
| Leitura via `POST /chat/findMessages` | 46 mil em ~6 s (janelas mensais, página 500), 0 perdidas/duplicadas; o banco da Evolution tem ids repetidos (496) |
| Espaço na Evolution | +44 MB (~0,9 kB por mensagem, só texto) |

## 2. Escopo

**Dentro:** importar o histórico guardado na Evolution após cada leitura de QR (e sob demanda); recuperar mensagens que chegaram enquanto o app estava fora do ar; aviso de canal desconectado; QR que aparece mesmo quando demora; nome do canal na lista quando houver mais de um; configuração da Evolution (dev e produção).

**Fora:** ações de mensagem (próxima entrega), grupos, histórico completo além do que o WhatsApp manda por padrão, edição/remoção aplicadas a mensagens antigas, limpeza automática do banco da Evolution.

## 3. Decisões (do usuário)

- **Fonte:** copiar do banco da Evolution via `findMessages` (abordagem A), não do webhook `MESSAGES_SET`.
- **Período:** três opções escolhidas pelo usuário — **3 meses, 12 meses, tudo** — com o aviso de que o WhatsApp manda ~3,5 meses; a tela mostra a data da mensagem mais antiga trazida.
- **Tudo que vem por sincronização/recuperação é só histórico (opção B):** nunca conta como não lida, nunca vai para a fila, nunca dispara bot, triagem nem retoma bot.
- **Destino:** conversa aberta do contato, se houver; senão, uma conversa finalizada de histórico.
- **Contatos sem número** entram como contato sem telefone e são juntados automaticamente quando o número for descoberto.
- **Mídia:** baixar na importação as das últimas 3 semanas; as mais antigas ficam como indisponíveis.
- **Grupos ficam de fora.**
- **Visibilidade do histórico importado (parte 3, decidida pelo Claude):** **todos os atendentes veem** as conversas de histórico importado — elas são anteriores ao sistema e servem de contexto; a barreira entre setores continua valendo para todas as conversas criadas pelo sistema.

## 4. Configuração da Evolution

- `DATABASE_SAVE_DATA_HISTORIC`, `DATABASE_SAVE_DATA_CHATS`, `DATABASE_SAVE_DATA_CONTACTS` = `"true"` em `docker-compose.dev.yml` e `docker-compose.yml`.
- `syncFullHistory` continua `false` (não passar no `createInstance`); `CONFIG_SESSION_PHONE_CLIENT` volta a `Atendimento` (prod) / `Atendimento (teste)` (dev), sem `CONFIG_SESSION_PHONE_NAME`.
- Webhook continua com `MESSAGES_UPSERT, MESSAGES_UPDATE, MESSAGES_DELETE, CONNECTION_UPDATE, QRCODE_UPDATED` (o `MESSAGES_DELETE` veio das ações de mensagem) (sem `MESSAGES_SET`, sem `MESSAGES_EDITED`, que trava a fila da Evolution quando o app está fora).
- **LGPD (altera núcleo §6):** a Evolution passa a guardar o texto do histórico do celular (~1 kB/mensagem), inclusive de grupos. Esse banco já segue as regras de backup/LGPD do núcleo. Documentar em `docs/IMPLANTACAO.md` um procedimento manual (SQL) para apagar mensagens da Evolution mais antigas que N dias depois da importação; não há tela para isso.

## 5. Importação do histórico

### 5.1 Quando roda
- **Automática:** quando um canal passa para `connected` vindo de `connecting` (nova leitura de QR), cria uma importação com o período escolhido no canal. Como o celular manda o histórico em até ~45 min, a importação **repete a cópia a cada 2 min** enquanto aparecerem mensagens novas, e termina após 10 min sem novidade (no máximo 60 min).
- **Sob demanda:** botão **"Importar histórico"** no canal (admin), com o período; usa o que a Evolution já guardou, sem QR.
- Uma importação por canal por vez (a segunda pedida enquanto uma roda devolve 409 "Já existe uma importação em andamento").

### 5.2 Como copia
- `findMessages` com `where.messageTimestamp {gte, lte}` (ISO com `Z`, os dois limites sempre, `lte` ≤ 2038-01-19), janelas **mensais** do mais novo para o mais antigo dentro do período, página `offset` 500, todas as páginas; ids repetidos descartados por `key.id`.
- Cada registro passa pelo parser existente (`parseEvolutionWebhook({event:'messages.upsert', instance, data: records})`). Ficam de fora: grupos, `status@broadcast`, `@newsletter`, `protocolMessage`, `associatedChildMessage`, `secretEncryptedMessage`, reações e tudo que o parser já ignora.
- Insere só ids que ainda não existem (`unique(channel_id, external_id)`); **nunca atualiza** mensagem existente (a Evolution reescreve mensagens editadas/apagadas; isso é da próxima entrega).
- Lotes de 500 mensagens por transação; `created_at` explícito = `sent_at` (ordem estável com mensagens ao vivo e com a lógica do bot).
- Não chama hub por mensagem: ao fim de cada lote publica `chat.updated` das conversas abertas afetadas.

### 5.3 Para onde vai
- Contato pelo telefone/LID com o `resolveContact` do ingest (exportado; mesma normalização do 9º dígito).
- **Conversa aberta do contato no canal existe** → mensagens entram nela; `last_message_at`/prévia só avançam se a mensagem for mais nova; `unread`, `waiting`, `triage_pending` não mudam.
- **Senão** → conversa de histórico do contato no canal (`chats.history = true`, `state='closed'`, setor padrão, sem dono; `created_at` = primeira mensagem, `closed_at` = última); importações seguintes acrescentam nela. Evento `history_imported` `{count}`.
- Nunca: unread, waiting, triagem, bots, `startChannelBot`, `resumeOnReply`, busca de mídia ao vivo.

### 5.4 Contatos sem número (LID)
- Registro com `remoteJid` `@lid` sem `remoteJidAlt` → contato com `lid` e `phone` nulo; nome = `pushName`/nome do `Contact` da Evolution quando não for só dígitos, senão nulo (a tela mostra "Contato sem número").
- **Junção automática:** a cada recuperação (§6) o app lê na Evolution os pares LID↔telefone das mensagens ao vivo (`key.remoteJid` `@lid` + `remoteJidAlt`). Se existir contato só-LID e contato com aquele telefone, o só-LID é juntado no outro: conversas e mensagens passam para o contato com telefone (se os dois tiverem conversa aberta no mesmo canal, as mensagens vão para a aberta do contato com telefone), etiquetas/campos/notas são unidos (o valor do contato com telefone prevalece), o só-LID é apagado; evento `contact_merged`. Se não existir contato com o telefone, o só-LID apenas ganha o `phone`.

### 5.5 Mídia
- Mensagens importadas com mídia de **até 21 dias** entram numa fila de download em segundo plano (uma por vez, `getBase64FromMediaMessage` pelo `key.id`, timeout 30 s), gravadas como a mídia ao vivo.
- Mais antigas, ou download com 400: `media_unavailable` com motivo "expirada". A bolha mostra **"Arquivo não está mais disponível no WhatsApp"**.
- Botão **"Baixar"** na bolha quando a mídia nunca foi tentada ou falhou por erro temporário (tenta uma vez; 400 → expirada).

### 5.6 Progresso e estado
- Tabela `history_imports`: canal, período, estado (`running|done|failed`), iniciado/terminado, mensagens importadas, contatos criados, data da mais antiga, erro (só nome/código).
- Tela **Configurações › Canais**: seletor de período ao lado de "Conectar/Reconectar" e no "Importar histórico"; durante a importação "Importando histórico… N mensagens"; ao fim "Histórico importado: N mensagens, desde DD/MM/AAAA" (atualiza por WS `channel.status`).

## 6. Recuperação de mensagens perdidas (app fora do ar)
- Job a cada **5 min** e no boot: copia da Evolution as mensagens com `messageTimestamp` entre `backfill_until − 10 min` e `agora − 30 min` que o app não tem, com as mesmas regras de §5.2–5.3 (só histórico); avança `channels.backfill_until`.
- Os 30 min deixam para o webhook (a Evolution reenvia por ~20 min) as mensagens que ainda podem chegar como mensagem nova, com fila e bot.
- No mesmo ciclo: pares LID↔telefone (§5.4).

## 7. Canal
- **Aviso de canal desconectado:** para admins, faixa na caixa de entrada quando um canal está `disconnected` há mais de 1 min: "Canal X desconectado: leia o QR code em Configurações › Canais" (link). Some quando conecta.
- **QR do "Reconectar":** a tela consulta `GET /api/channels/:id/qr` enquanto o canal está `connecting`, mesmo que o `connect` tenha voltado sem QR; mostra "Gerando QR code…" até chegar. Corrige o caso de 16/10 em que o canal antigo nunca mostrava o QR.
- **Nome do canal no cartão da conversa** quando houver mais de um canal.

## 8. Visibilidade (altera a regra de 15/10)
- `canSee`/`visibleChatsWhere`: conversa com `history = true` é visível para **todo usuário logado** (só leitura; histórico não pode ser reaberto, transferido nem privado).
- Conversas de histórico não aparecem na aba **Finalizados**; aparecem no histórico do contato (ficha) e na busca.

## 9. Erros
- Evolution fora/erro em uma janela → a importação para com `failed` e o erro (nome/código), mantém o que já entrou; pode ser repetida.
- Logs só com ids, contagens e nomes de erro; nunca corpo, telefone, LID ou nome.
- Importação e recuperação nunca rodam dentro da transação do ingest ao vivo; lotes curtos para não travar webhooks.

## 10. Testes
- Parser de registros da Evolution (formato do `findMessages`) e filtros (grupos, protocol, etc.).
- Janelas/páginas: todas as páginas lidas, ids repetidos descartados, limites ISO.
- Destino: conversa aberta vs. conversa de histórico; nada de unread/waiting/bot/triagem; reimportação idempotente.
- Contato só-LID e junção automática (com e sem conversa aberta nos dois).
- Mídia: ≤21 dias entra na fila; mais antiga fica indisponível; 400 vira expirada.
- Recuperação: janela com folga de 30 min e avanço do `backfill_until`.
- Visibilidade de histórico; aba Finalizados sem histórico.
- Web: QR aparece quando chega depois do `connect`; faixa de canal desconectado; seletor e progresso da importação.

## 11. Aceite manual
Com o número de teste: ler o QR → importação automática com "3 meses" → contatos com telefone mostram o histórico na conversa/ficha; contatos sem número aparecem como "Contato sem número"; fotos/áudios recentes abrem e antigos mostram "não está mais disponível"; nada entrou como não lido nem disparou bot; derrubar o app por 40 min com mensagens chegando → elas aparecem como histórico após religar; desconectar o celular → faixa de aviso aparece.

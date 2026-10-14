# Mapa do Umbler Talk (uTalk) — engenharia reversa de UI

Fonte: navegação passiva na conta da organização (14/10/2026), versão do app `2026.10.14.1112-wasm`.
Prints em `../screenshots/` (ordem cronológica de captura). Spec completa da API: `utalk-openapi-v1.json`.
Nenhuma mensagem foi enviada, nenhum dado alterado. Dados de clientes não são reproduzidos aqui.

## 1. Stack observada (observação vs inferência)
- **Observado:** sufixo `-wasm` na versão → front .NET em WebAssembly (detalhes abaixo, confirmados com REA). Componentes compartilhados em `/_content/Umbler.Common.Components/` (Razor Class Library). Namespace da API: `Umbler.UTalk.Api` (ASP.NET Core + Swagger/OAS 3.0.4, auth Bearer JWT).
- **Observado:** o banner "Estabelecendo comunicação em tempo real…" / "Conectado!" corresponde à conexão Ably (ver abaixo; a hipótese inicial de SignalR foi descartada). Service worker `sleepDetector.worker.js`.
- **Observado:** mídia em S3 público `utalk-wamedia.s3.amazonaws.com/<org>/<chat>/<hash>`; login centralizado em `account.umbler.com` (Google/Facebook/e-mail+senha).
- **Observado:** tracking de terceiros (Clarity, GTM/GA, TikTok, Meta, OneSignal p/ push, Customer.io, RouteCDN). Não replicar.
- **Inferência:** WhatsApp Starter = sessão via QR (não oficial); WhatsApp Business API via **Gupshup** (API cita "Gupshup channels" e templates na Meta).
- **Observado com REA (Evidence `ev_7390eb1a…` análise de bundle, captura de cenário via CDP em /chats → /contacts):**
  - O front é **Blazor Web** (`blazor.web.js`, `_blazor/initializers`, `_blazor/disconnect`) com runtime .NET WASM (`dotnet.native.wasm`, `dotnet.runtime.js`), bundle de componentes `Umbler.Common.Components/dist/bundle.js` (webpack, ~1,3 MB; traz Chart.js e a lib Ably) e `Z.Blazor.Diagrams` (usada no editor de fluxos do chatbot). Configuração carregada em `/appsettings.json` e `/appsettings.Production.json`.
  - **O tempo real NÃO é SignalR: é Ably** (`wss://main.realtime.ably.net`, ably-js 2.28.0, JSON). O app pega um token curto via `POST main.realtime.ably.net/keys/<key>/requestToken` e abre o WebSocket (~73 frames em ~10 s de uso; mensagens de ~100–1000 bytes).
  - **API interna do front:** `GET /internal-api/v1/app-startup`, `/internal-api/v1/chats/`, `/chats/pinned/`, `/contacts/`, `/help/talk-status/` (mesmo estilo das rotas `/api/v1/*` da API pública). Mídias em `utalk-wamedia.s3.amazonaws.com` (71 requisições na tela de conversas). Cerca de 520 requisições totais em duas telas, 166 de arquivos do framework/conteúdo.
  - Cuidados da captura: foi sem corpos de requisição/resposta (evita dados de clientes); o service worker exigiu `service_workers: allow` na conexão ao Chrome. Um token Ably temporário apareceu na saída do terminal da sessão e não foi gravado em arquivo.
- **Não verificado:** o conteúdo (schema) das mensagens Ably por canal e os payloads de `/internal-api`; precisa de captura com corpos em uma conta de teste ou campos mascarados.

## 2. Layout global
- Barra lateral esquerda (ícones, expansível pelo `>`): Conversas · Contatos · Boards de contatos · Chatbots · Agentes de IA · Envio de campanha · Relatórios · Configurações. Rodapé: notificações (sino), ajuda, avatar/menu do usuário.
- Topbar com breadcrumb (`Configurações / Chatbots / Fluxo`). Tema escuro, toast "Conectado!".
- Rotas: `/chats`, `/chats/{id}`, `/contacts`, `/contact-boards`, `/chatbots`, `/ai-agents`, `/bulksend`, `/dashboard` (`?t=Ratings`), `/settings/*`, `/library`.
- IDs curtos tipo `aSBmAQEqrnVhYnCk` (16 chars base64url) em chats, bots e orgs.

## 3. Conversas (`/chats`)
- Painel esquerdo: alternância **Conversas / Conversas com equipe** (ícone de grupo; subtabs Todos·Atendentes·Grupos). Botão **+** → modal "Nova conversa" (abas Contato · Atendentes · Grupo de atendentes; busca nome/telefone, filtro Etiquetas, ordenação, botão adicionar contato).
- Abas de fila: **Entrada** (badge de não lidas), **Esperando** (contatos esperando resposta), **Finalizados** (≈9440 no total).
- Busca, **Filtrar conversas** (painel: Etiquetas incl. "Sem etiqueta", Atendentes, Setor, Canal, Período de criação: Qualquer/Hoje/7d/30d/Intervalo), **Ordenar** (por Data de criação / Última mensagem / Esperando resposta; mais recentes/antigas; "Mostrar ocultas"), **modo seleção em massa** (ícone check).
- Item da lista: avatar + ícone do canal, nome, prévia (tick de enviada/lida, ícone de mídia/"Mensagem excluída"/reação), horário, badge de não lidas, avatar do atendente dono, etiqueta do setor, etiquetas, cadeado (conversa privada), pin (até 3 fixadas, individual).
- Cabeçalho da conversa: avatar, nome, etiquetas, setor; ações: **Contato/Detalhes** (painel lateral), ícone de notas/detalhes, **Liberar atendimento** (tooltip), **Buscar na conversa**, **Fechar**.
- Corpo: bolhas (recebida à esquerda; enviada à direita com "Atendente: nome" e avatar do remetente — pode ser bot), separadores de data, **eventos de sistema** colapsáveis ("Conversa iniciada pelo contato", "Chatbot Fluxo iniciado", "Conversa tornada privada/pública", "Conversa finalizada"), anexos (PDF com ícone), botões de ir ao início/lista/rolar ao fim. Hover na mensagem: **reagir, responder, encaminhar, copiar, ⋮**.
- Rodapé de conversa finalizada: "Conversa finalizada — Nova conversa". **Compositor de conversa aberta NÃO mapeado** (precisa de uma conversa aberta e já lida; ver pendências).
- Painel lateral **Contato**: etiquetas do contato, Observações (notas, com fixar), Logs de atividade, LID, telefone fixo, e-mail, campos personalizados, Bloquear / Excluir contato, editar.
- Painel lateral **Detalhes da conversa**: etiquetas da conversa, mensagens favoritas, canal, setor, atendentes, última mensagem do contato, visibilidade (ocultar), etc.

## 4. Contatos (`/contacts`) — 2368 registros
Tabela: Contato (avatar+nome), Telefone, E-mail, Criado em, Última atividade, Ações (ver). Filtros: Todos/Bloqueados/Ativos, Etiquetas, Campos (colunas). Busca, **Adicionar contato**, menu ⋮: Importar, Exportar, Importação avançada. Seleção em massa. Linha abre drawer do contato (Etiquetas, Observações, Logs, **Todas as conversas deste contato**, LID, telefone fixo, e-mail, bloquear/excluir).

## 5. Boards de contatos (`/contact-boards`)
Kanban de contatos: lista de Boards à esquerda (+), estado vazio "Crie seu primeiro board!". (Conteúdo interno não mapeado — sem boards.)

## 6. Chatbots (`/chatbots` e `/settings/chatbots`)
Tabela: Nome, Canais, Criado em, Atualizado em, Execuções, Ações (relatório, editar, ativar/desativar, duplicar, excluir), reordenar, busca, **Novo chatbot**.
**Editor de fluxo** (`/settings/chatbots/editor/{id}`): canvas de nós estilo flowchart, desfazer/refazer, auto-organizar, salvar, pausar/ativar (indicador verde), exportar, zoom/fit/minimapa, **paleta de passos** (atalho Tab) com busca. Catálogo de blocos:
- **Início:** Iniciar por um canal · Iniciar manualmente.
- **Condição:** Dias da semana · Horários · Definir condição · Multi-condicional · Aguardar intervalo · Aguardar até · Distribuir fluxo (pesos) · O contato está ativo? (24h) · Etiquetas · O contato é um grupo? · Primeira conversa? · Campo do contato · Setor da conversa · Canal da conversa · Atendente da conversa · Presença do atendente · Mensagem contém · Valor · Bot paralelo em execução · Grupo do canal · Grupo do atendente · Status da conversa.
- **Ação:** Enviar mensagem · Criar nota no chat · Transferir para setor · Editar etiquetas · Transferir p/ atendente · Transferir p/ agentes de IA · Privar ou liberar · Pedir para escolher (opções; botão em Business API) · Pedir para digitar (validações: texto, e-mail, telefone, CPF, CNPJ, mídia pdf/áudio/imagem/vídeo, customizado) · Enviar template · Enviar formulário (WhatsApp Flow) · Acionar outro fluxo · Status esperando · Pedir para avaliar · Pedir feedback escrito · Campo do contato · Fluxo de espera · Notificar atendente · Mensagem para equipe · Visibilidade da conversa · Excluir contato · Bloquear contato.
- **Finalização:** Finalizar conversa (fechado por: dono do chat…). **Utilitários:** Bloco de notas. **Integrações:** Webhook · Pipedrive · Asaas.
- Cada nó tem saídas de erro ("Ativar fluxo se …não for possível"), variáveis `{{ Contexto.<id>:raw }}`, intervalos fixos/variáveis. Há snapshots (versões) de bot na API.

## 7. Agentes de IA (`/ai-agents`)
Lista: Nome, Tipo (ex. Vendas), Status (Rascunho…), Ações (Continuar, Testar, ⋮). Consome vaga de atendente + créditos de IA ("Limite de atendentes atingido"). API: Q&A, documentos, crawlers de site, bases de conhecimento, vozes, setores pré-treinados, snapshots, importar Q&A de chats, clonar KB. Também `AiAssistant`: melhorar texto e 3 sugestões de resposta.

## 8. Envio de campanha (`/bulksend`)
Estado vazio + **Novo envio de campanha de marketing** (WhatsApp, em massa, com templates). API `bulk-send-session` (enviados/agendados).

## 9. Relatórios (`/dashboard`)
Abas: **Geral** (subabas Conversas·Atendentes·Setores·Etiquetas·Contatos; filtros Canal, Atendente, "Comparar atendentes", Data de criação) · **Agora** (tempo real) · **Chatbots** (bot + data) · **Créditos** (Geral/Detalhado; intervalo mensal; consumidos, média diária, evolução) · **Mensagens** (período, canal, origem, atendente; total, por canal [recebidas/bot/atendente/fora do Talk], por dia) · **Avaliações** (avaliado, canal, chatbot; % respondidas, positivas/neutras/negativas).
KPIs do Geral: total de conversas, abertas, finalizadas, com interação, tempo 1ª resposta, tempo p/ finalizar; gráficos: abertas por atendente, por canal, tempos médios, por região/estado/DDD, por dia, por hora. Exportação via ícone de download nos cards.

## 10. Configurações (`/settings/*`) — menu lateral com busca; 💎 = recurso de plano superior
**Conta:** Perfil (`account`: nome, assinatura, telefone, mensagem de finalização pessoal, **Tokens de acesso** com nome/expiração) · Preferências pessoais (`preferences`: microfone, notificação do app [sempre/nunca/segundo plano], ação da tecla Enter [enviar/quebra de linha], espaçamento nome-mensagem, "Privar conversa ao enviar mensagem", sons).
**Atendimento:** Canais (`channels`: Nome, Tipo [WhatsApp Starter/Business], dispositivo, status Online, ações reiniciar/info/editar) · Atendentes (`agents`: permissão Operador/Admin/Proprietário, reatribuição, convite, limite do plano) · Setores (`sectors`: reordenar, setor padrão) · 💎 Horários (`business-hours`: múltiplos, "Horário padrão") · Etiquetas (`tags`: cor+emoji, reordenar) · 💎 Grupos (`groups`) · 💎 Campos personalizados (`custom-fields`: nome, tipo, descrição; ex. CPF) · Biblioteca de mídias (`/library`).
**Automação:** Agentes de IA · Bases de conhecimento · Chatbots · Respostas rápidas (`quickanswers`: nome, criada, visível p/ Todos/apenas você, anexo) · Templates WhatsApp (`templates`, só Business API) · Formulários do WhatsApp (`flows`) · Agendamentos (`scheduledmessages`: calendário/lista, Agendar) · 💎 Variáveis (`variables`).
**Organização:** Dados cadastrais (`organization/details`) · Conversas (`organization/chats`: comportamento do alerta de chatbot em execução, assinatura do atendente, ação ao finalizar [escolher/apenas finalizar/mensagem ou template/chatbot], mensagem padrão sugerida) · Reatribuição (`reassign`) · 💎 Inatividade (`inactivity`) · 💎 Espera (`waiting`) · 💎 Atalhos de chatbot (`bot-shortcuts`) · Transferência (`transfer`: quem aparece na lista) · 💎 Privacidade de dados (`data-privacy`: ocultar telefone) · Listar conversas (`chats-list`: visão admin de todas as conversas com filtros e exclusão) · Financeiro (link p/ assinatura em account.umbler.com).
**Sistema:** 💎 Webhooks · API (docs Swagger em `/api/docs/index.html`) · 💎 Atividades (`activityLogs`: quem fez o quê, "via App").
**Mais:** Criar organização · Indique seus amigos · versão do app.

## 11. API pública (spec salva em `utalk-openapi-v1.json`)
198 rotas, 951 schemas, base `https://app-utalk.umbler.com/api`, Bearer JWT (token de acesso do Perfil). Rate limit documentado (ex.: 100 req/5s). Domínios: ActivityLogs, AiAgents, AiAssistant, Bots(+flowchart), BulkSendSession, Channels(starter/waba, username), Chats(+tags, read/unread, pin, dm, internal, private-group, sandbox, credit-conversation, favorite-messages), ContactRatings, Contacts(+notes, custom-fields, tags, check-whatsapp), CustomFieldDefinitions, Flows/FlowMessages, KnowledgeBases, Members, Messages(+reactions, forward, transcribe, favorite, states, resend), BotShortcuts, OrganizationFiles, Groups, Invites, Preferences, Organizations, Tasks, Permissions, QuickAnswers, ScheduledMessages, Sectors, Stickers, Tags, Templates/TemplateMessages, UserNotifications, Variables, Webhooks.
**Este é o melhor guia do modelo de dados** — o nosso backend pode espelhar essas entidades.

## 11b. Formulários de criação (abertos sem salvar)
- **Novo contato** (`/contacts/create`, página e não modal): foto; Informações básicas: Nome, Celular* (seletor de país); abas **Dados complementares** (Telefone fixo, E-mail, Gênero, Data de criação, Endereço, Complemento, Cidade, Estado, CEP, País) e **Campos personalizados** (lista de definições com "Adicionar" + "Criar campo"); Salvar/Cancelar.
- **Novo setor** (modal): só Nome*; Fechar/Salvar.
- **Criar etiqueta** (modal): emoji + Nome (máx. 30 caracteres), Descrição (opcional), Cor de fundo (paleta de 20 cores), pré-visualização do chip; Criar.
- **Nova resposta rápida** (modal): Nome*, Visibilidade* (Para todos / Apenas para mim), Mensagem*, Anexar arquivo, **Adicionar variável** → placeholders `{{1}}`, `{{2}}`… com Nome da variável e Valor padrão escolhido de: Atendente.{Email, Id, NomeCompleto, PrimeiroNome}, Contato.{CEP, Cidade, Complemento, CPF, Email, Estado, Genero, Id, NomeCompleto, Numero, País, PrimeiroNome, Rua} (+ campos personalizados e variáveis da organização, segundo a API `quick-answers/render`).

- **Novo canal** (`/settings/channels?New=True`, modal com 3 cartões): **WhatsApp API Oficial** (recomendado, Meta Business Partner: estabilidade, mensagens em massa/modelos/botões interativos, independente do celular) · **WhatsApp Web** (espelha o celular via QR Code, ativação imediata) · **Webchat** (widget no site, sem WhatsApp). Cada um com "Criar canal".
- **Agendar** (`/settings/scheduledmessages`): escolha entre **Conversa** (mensagem para um contato) ou **Envio de campanha de marketing**. Em Conversa: seletor de contato (busca nome/telefone, filtro etiquetas, ordenação, +novo) → drawer "Agendamento de mensagens" com abas **Agendar / Agendadas (n) / Concluídas (n)** e três tipos: **Agendar uma mensagem**, **Agendar uma nota**, **Agendar um bot**. Formulário de mensagem: aviso (Starter só envia com celular conectado), data e hora (mostra "Será enviado daqui a X"), "Utilizar uma resposta rápida", toggle **Assinar**, Mensagem; Agendar/Cancelar.
- **Novo chatbot**: abre direto o editor (`/settings/chatbots/editor`) com modelo inicial — nós "Iniciar por um canal" (selecionar canais; alerta se vazio), "Iniciar manualmente" (Título, "Não listado") e "Enviar mensagem" ("Olá!") — e indicador "Alterações não salvas". Sair sem salvar não cria nada (conferido: a lista continuou com 3 bots).
- **Nova campanha** (`/bulksend/create`): bloqueada sem canal WhatsApp Business API ("Você não tem um canal compatível para envio!" + "Criar um Canal WhatsApp Business").
- **Editor de Agente de IA** (`/settings/ai-agents/{id}`): assistente de 6 passos — 1 Perfil · 2 Comportamento · 3 Conhecimento · 4 Habilidades · 5 Fluxo · 6 Conversa e ativação. Passo 1: "Comece com um modelo" (Setor da empresa, ex. Advocacia → funções-modelo **Triagem Jurídica** [popular], **Acompanhamento de Processos**, **Captação de Clientes**, cada uma com "Ideal para"), Identidade (Nome do agente*, Assinar conversa, Idioma, Nome da empresa*, Website, Outras opções), Avançar. Os passos 2–6 só abrem depois de avançar (que salva), por isso não foram abertos; os campos estão no schema `AiAgents` da API.

## 11d. Menus globais
- **Avatar** (rodapé): aba **Minha conta** (Meu perfil, Assinaturas e planos, Indique e ganha), **Minhas organizações** (lista com busca e troca de organização), **Sair**; aba **Preferências** (Reatribuição de chats: Off/Auto/Sempre; Aparência: Auto/Claro/Escuro; Som de notificação: Ativado/Desativado; link "Outras preferências pessoais").
- **Notificações** (sino): drawer com abas **Menções**, **Atividades**, **Novidades**.
- **Suporte** (ícone ?): atalho para o suporte da Umbler.
- **Sidebar expandida** (`>`): rótulos Conversas, Contatos, Boards de contatos, Chatbots, Agentes de IA, Campanhas, Relatórios, Configurações; rodapé Notificações, Suporte, usuário.
- **Erro de carregamento**: quando uma requisição demora demais aparece "Ocorreu um erro inesperado — A requisição foi cancelada após demorar mais do que o normal", com Copiar, Falar com suporte e Tentar novamente.

## 11e. Compositor de mensagens (conversa aberta e já lida, nada digitado/enviado — prints `../screenshots/rea/compositor-*`)
- **Cabeçalho de conversa aberta** (ícones Phosphor): Contato (`ph-user`), Detalhes (`ph-article`), Transferir (`ph-arrow-bend-up-right`), Privar/Liberar (`ph-lock-simple-open`), Agendar (`ph-calendar-blank`), Finalizar (`ph-check`), Buscar, Fechar. Faixa amarela de **mensagem fixada** com contador "(1)".
- **Modo** Mensagem / **Notas** (nota interna: caixa amarela, placeholder "Digite sua nota interna, acessível só aos atendentes do Umbler Talk…").
- **Caixa**: "Digite sua mensagem ou arraste um arquivo…" (drag-and-drop). Barra: **+ Mais opções**, atalhos fixáveis Arquivo · Respostas · Chatbot · Emoji, **Personalizar barra**, toggle **Assinatura** + Editar assinatura, botão **microfone** (vira enviar quando há texto).
- **Menu +**: Arquivo, Biblioteca, Respostas (atalho `/`), Chatbot (`Ctrl+B`) em destaque; lista Contato, Localização, Figurinhas, Emoji.
- **Personalizar barra**: abas Ferramentas / Atalhos; prévia "Como fica na barra"; 8 itens do + com estrela para fixar (padrão fixados: Arquivo, Respostas, Chatbot, Emoji).
- **Respostas** (drawer "Respostas rápidas"): busca, +, filtro Todas/Minhas, cartões título + texto.
- **Chatbot** (drawer "Executar chatbot"): contato alvo + lista de bots com bloco de início manual (vazio aqui).
- **Emoji**: picker com busca "Nome do emoji" e 8 categorias (Pessoas, natureza, comida, atividades, viagens, objetos, símbolos, bandeiras).
- **Hover em mensagem**: reagir, responder, encaminhar, copiar, ⋮.
- Atalho global: `Esc` fecha a conversa (`closeChatOnEscape.js`); `conversationNavigation.js` para navegar entre conversas.

## 11c. Sessão única por usuário (observado)
Com o mesmo login aberto em mais de um navegador, o app passa a carregar devagar e depois mostra a tela **"O Umbler Talk está sendo utilizado em mais de um dispositivo"**, listando dispositivos/abas (Primeiro, Segundo, Terceiro dispositivo — 1 Tab cada, "Este dispositivo") com o botão **"Usar aqui"**, que assume a sessão e derruba as outras. Recurso a replicar (controle de sessão ativa por atendente).

## 12. Pendências (não mapeado)
1. ~~Compositor~~ — feito (seção 11e). Não abertos: modal de Transferir, Agendar pelo cabeçalho, aba "Atalhos" do Personalizar barra.
2. IA (agentes, bases de conhecimento, assistente de texto): **fora do escopo por decisão do usuário (14/10/2026)**.
3. ~~Subabas dos relatórios~~ — feito com REA: Atendentes (abertas/finalizadas por atendente, tempos), Setores (por setor), Etiquetas (de conversa/de contato), Contatos (tabela Total/Abertas/Fechadas), Agora (em espera, em andamento, atendentes online, 1ª resposta na última hora, gráfico dos últimos minutos). Prints em `../screenshots/rea/`; endpoints em `ENDPOINTS-INTERNOS.md`.
4. Campos dos objetos: cobertos pela spec pública → `MODELO-DE-DADOS.md` (38+ schemas). A captura dos corpos reais foi **bloqueada pelo controle de dados pessoais** do Claude Code; o formato das mensagens Ably continua não verificado.
Prints do segundo lote em `../screenshots/lote2/`.

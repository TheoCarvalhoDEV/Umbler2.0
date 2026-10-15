# API interna do front (`/internal-api/v1`) — tela por tela

Fonte: capturas de rede do REA (`capture_browser_scenario`, Chrome via CDP, só metadados — sem corpos, sem valores de query, sem headers).
Evidências: `ev_dacd4d5a…`, `ev_6243ffcb…` (relatórios), capturas de configurações e conversas de 14/10/2026.
Todas as chamadas levam `organizationId` na query (omitido abaixo). `{id}` = ID curto de 16 caracteres.
Paginação padrão: `Skip`, `Take`, `Behavior`; ordenação: `OrderBy`, `Order`; filtros por coleção usam `X.Rule` + `X.Values`.

**Observação:** as rotas espelham a API pública (`/api/v1/*`, ver `utalk-openapi-v1.json`); o front usa o prefixo `internal-api`.
**Inferência:** setores, etiquetas, campos personalizados e grupos não geraram chamadas ao abrir suas telas → provavelmente já vêm em `app-startup` (não verificado sem ler o corpo).

## Global
| Quando | Chamada |
|---|---|
| Boot de qualquer página | `GET /app-startup` · `GET /appsettings.json` · `GET /appsettings.Production.json` |
| Tempo real | `POST main.realtime.ably.net/keys/<key>/requestToken` → WebSocket Ably (JSON) |
| Status do serviço | `GET /help/talk-status/` |
| Log de erros do cliente | `POST /logging/` |

## Conversas (`/chats`)
| Ação | Chamada |
|---|---|
| Lista (Entrada/Esperando/Finalizados) | `GET /chats/` ?Sectors.Rule, ChatState, ContactTypes, LastMessage, Order, ChatOrderBy, IncludePinneds, Visibility, Tags.Rule, Members.Rule, Channels.Rule, Channels.Values, Skip, Take, Behavior |
| Contadores/prévia | `GET /chats/` ?ChatState, ContactTypes, IncludePinneds, Visibility, Messages, Behavior |
| Fixadas | `GET /chats/pinned/` |
| Prévia de mensagem | `GET /messages/{id}/` |
| Abrir conversa | `GET /chats/{id}/` ?includeMessages, includeMetadata |
| Painel do contato | `GET /contacts/{id}/notes/` · `GET /contacts/{id}/chats/` ?ChatState, RelativeStartFromEventUTC, RelativeTakeDirection, Channels.*, Take |

## Contatos e boards
| Tela | Chamada |
|---|---|
| Contatos | `GET /contacts/` ?Skip, Take, Behavior, Tags.Rule, State, OrderBy, Order, includeGroups |
| Boards de contatos | `GET /contacts-boards/boards/` (não está na API pública) |

## Relatórios (`/dashboard`)
| Aba | Chamadas |
|---|---|
| Geral › Conversas | `reports/conversations-basic-infos`, `chats-members`, `chats-by-channel`, `chats-first-response-time`, `chats-time-to-close`, `chats-by-regions`, `chats-by-day`, `chats-by-hour` (?Date) — todas ?StartDate, EndDate, Members.Rule |
| Geral › Atendentes | `reports/members-first-response-time`, `members-close-response-time`, `members-activity`, `chats-members` |
| Geral › Setores | `reports/sectors-first-response-time`, `sectors-close-response-time`, `chats-sectors` |
| Geral › Etiquetas | `reports/chats-tags` (subabas Etiqueta de conversa / de contato) |
| Geral › Contatos | `reports/chats-contact` (tabela Total/Abertas/Fechadas por contato) |
| Agora | `reports/chats-waiting`, `chats-opened`, `last-hour-chats-first-response-time`, `last-hour-chats` |
| Chatbots | `bots/flowchart/` ?Behavior · `bots/flowchart/botinstances/` ?startUTC, endUTC |
| Créditos | `reports/credits-report` ?StartDate, EndDate |
| Mensagens | `reports/messages-count` ?StartDate, EndDate |
| Avaliações | `contact-ratings/simplified` · `contact-ratings/repositories` · `contact-ratings/` ?startUTC, endUTC, OrderBy, Order |

## Automação / campanhas
| Tela | Chamada |
|---|---|
| Agentes de IA | `GET /organizations/{id}/credits/` |
| Bases de conhecimento | `GET /ai-agents/knowledge-bases/` |
| Chatbots | `GET /bots/` ?OrderBy, Order, Skip, Take |
| Respostas rápidas | `GET /quick-answers/` ?viewFrom, OrderBy, Order |
| Templates | `GET /template-categories/` · `GET /templates/` ?status |
| Formulários WhatsApp | `GET /flows/` |
| Agendamentos | `GET /reports/schedules/` ?StartDate, EndDate · `GET /bots/flowchart/manual-starts/` · templates |
| Campanhas | `GET /bulk-send-session/` ?OrderBy, Order, Type.Rule |
| Biblioteca de mídias | `GET /organization-files/` ?SearchText, FileTypes.Rule, Order |

## Configurações
| Tela | Chamada |
|---|---|
| Perfil (tokens) | `GET /account-tokens/` (não está na API pública) |
| Canais | `GET /channels/{id}/channelstart/session/` ?keepOffline (status da sessão do WhatsApp Starter) |
| Atendentes | `GET /organization-invites/` |
| Horários | `GET /business-hours/` (não está na API pública) |
| Dados cadastrais | `GET /organizations/{id}/details/` |
| Org › Conversas | `GET /templates/` ?status · `GET /bots/flowchart/manual-starts/` |
| Listar conversas | `GET /chats/basic-info/` ?StartDate, EndDate, ChatState, ChatOrderBy, Order |
| Webhooks | `GET /webhooks/` |
| Logs de atividade | `GET /activity-logs/` ?StartDateUTC, EndDateUTC |

## Pistas da arquitetura .NET (console do navegador)
`Umbler.UTalk.UIShared.Components.ActivityLog.ActivityLogItemDetails` (com `ReadChatContact`), `Umbler.Common.Extensions.StringExtensions.AsJson` → componentes Blazor em biblioteca compartilhada `Umbler.UTalk.UIShared`, logging via `Microsoft.Extensions.Logging`, JSON com `System.Text.Json`.

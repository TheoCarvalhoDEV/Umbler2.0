# Barreira entre setores, sessão entre abas e fotos de perfil — design

- **Data:** 15/10/2026 · **Status:** aprovado pelo usuário em conversa
- **Branch:** `feat/visibilidade-e-fotos` (a partir de `develop`) → PR para `develop`
- **Base:** spec do núcleo `2026-10-14-nucleo-atendimento-design.md` (esta spec altera §5.5 e §6 "Autorização")

## Motivação (teste local de 15/10)
1. Duas contas admin viam todas as conversas: o admin não tinha barreira de setor. O usuário quer que a conversa fique exposta **só no setor onde está**.
2. Duas abas no mesmo navegador compartilham o cookie; ao logar com outra conta numa aba, a outra aba continuou mostrando a conta antiga e enviou mensagens assinadas pela nova.
3. Faltam fotos de perfil (clientes e atendentes), como no Umbler.

## Parte 1 — Barreira entre setores
- Nova regra única (`inbox/visibility.ts`):
  - `canSee(user, chat)`: `true` se `user.role === 'admin' && user.seeAllSectors`; senão `chat.ownerId === user.id || (!chat.private && user.sectorIds.includes(chat.sectorId))`.
  - `visibleChatsWhere(user)`: `undefined` só para admin com `seeAllSectors`; senão `owner = me OR (private = false AND sector IN mine)` (e só `owner = me` se o usuário não tem setores).
  - Admin **sem** "ver todos" é tratado exatamente como atendente para visibilidade de conversas (inclui privadas: só o dono). Permissões administrativas de cadastro/configuração não mudam. Ações que hoje aceitam "dono ou admin" (privar, transferir/finalizar privada) continuam aceitando admin, mas só sobre conversas que ele `canSee`.
- `users.see_all_sectors boolean not null default false` (migration nova). `AuthUser.seeAllSectors: boolean`; `Me.seeAllSectors: boolean`; `UserDto` não precisa.
- `PUT /api/auth/me/view` `{ seeAllSectors: boolean }` → `Me`. Só admin (agente → 403). Origin check vale (é mutação).
- Como o hub recarrega o `AuthUser` do banco a cada publish, a preferência vale para lista, conversa, timeline, mídia, histórico do contato e WS sem estado extra.
- Web: na caixa de entrada, para admin, um botão/alternador **"Ver todos os setores"** (ligado = olho aberto). Ao trocar: chama a rota, atualiza o `me` em cache e invalida as queries de conversas/contatos.
- Transferência: comportamento atual mantido (transferir só para setor limpa o dono e `private`); quem transferiu deixa de ver a conversa, salvo se pertence ao setor de destino ou é admin com "ver todos".
- Testes: matriz `canSee` atualizada (admin com/sem `seeAllSectors`, privada, dono fora do setor); `visibleChatsWhere` equivalente a `canSee`; REST: admin sem "ver todos" recebe 404 em conversa/timeline/mídia de outro setor e não a vê na lista nem no histórico do contato; com "ver todos" vê; WS: admin sem "ver todos" recebe `chat.removed` ao transferir para outro setor; rota `/me/view` (admin ok, agente 403, sem Origin 403).

## Parte 2 — Sessão consistente entre abas
- Web: após login e logout bem-sucedidos, gravar `localStorage['talk:session'] = '<userId|none>:<timestamp>'` (try/catch). Ouvir o evento `storage` dessa chave: se o `userId` mudou em relação ao usuário desta aba, recarregar a página (`location.reload()`), que volta com a conta certa ou cai no login.
- Teste: função pura/hook que decide recarregar quando a chave muda para outro usuário e não recarrega para o mesmo usuário.

## Parte 3 — Foto do WhatsApp dos clientes
- `contacts.avatar_path text` e `contacts.avatar_checked_at timestamptz` (mesma migration).
- `WhatsAppGateway.fetchProfilePicture(instance, address): Promise<string | null>` — Evolution v2.3.7 `POST /chat/fetchProfilePictureUrl/{instance}` `{ number }` → `profilePictureUrl` (confirmar no código-fonte da tag 2.3.7). `address` = telefone canônico ou `<lid>@lid` (mesma função `waAddress` do envio). Fake gateway: retorna `null` por padrão, com como configurar uma URL de teste.
- Ingest: depois do commit de uma mensagem `in` (nunca dentro da transação), se `avatar_checked_at` é nulo ou mais antigo que 7 dias, em segundo plano e sem derrubar nada: busca a URL, baixa a imagem (fetch com timeout de 15 s, só `image/*`, até 2 MB), salva em `<mediaDir>/avatars/<contactId>.<ext>` (sobrescreve), grava `avatar_path` e `avatar_checked_at = now()`; sem foto → `avatar_path = null`, `avatar_checked_at = now()`. Falha → registra o nome do erro (sem dados) e grava `avatar_checked_at` para não repetir a cada mensagem. Depois publica `chat.updated` das conversas abertas do contato.
- `GET /api/contacts/:id/avatar` (qualquer usuário logado; contatos são do escritório): envia o arquivo com `Cache-Control: private, max-age=86400`, `X-Content-Type-Options: nosniff`; 404 sem foto.
- DTOs: `ContactRef.avatarUrl: string | null` e `ContactDto.avatarUrl: string | null` = `/api/contacts/<id>/avatar?v=<epoch de avatar_checked_at>` quando há `avatar_path`, senão `null`.
- Web: componente único `Avatar` (imagem com fallback para iniciais em erro/null) usado na lista de conversas, cabeçalho da conversa, lista de contatos e ficha.
- Testes: ingest dispara a busca só quando necessário (nulo / > 7 dias) e não na transação; falha não afeta a mensagem; rota do avatar (200 com cabeçalhos, 404 sem foto, 401 sem login); DTO com `avatarUrl`.

## Parte 4 — Foto dos atendentes
- `users.avatar_path text` (mesma migration).
- `POST /api/auth/me/avatar` (multipart, campo `file`, só `image/jpeg|png|webp`, até 2 MB → 400 se inválido) salva em `<mediaDir>/avatars/users/<userId>.<ext>`; `DELETE /api/auth/me/avatar` remove. Ambos devolvem `Me`.
- `GET /api/users/:id/avatar` (qualquer usuário logado), mesmos cabeçalhos da Parte 3; 404 sem foto.
- DTOs: `Me.avatarUrl`, `UserDto.avatarUrl` (`/api/users/<id>/avatar?v=<hash curto do path ou updated_at>`), e `MessageDto.authorAvatarUrl: string | null`.
- Web: upload/remoção em **Configurações › Perfil**; avatar no menu do usuário, na lista de atendentes, ao lado das mensagens enviadas por atendentes e no indicador de dono na lista de conversas (reusa o `Avatar` da Parte 3).
- Testes: upload válido/ inválido (tipo, tamanho), remoção, rota GET, `Me`/`UserDto`/`MessageDto` com a URL.

## Restrições
As mesmas do plano do núcleo (`docs/superpowers/plans/2026-10-14-nucleo-atendimento.md` › Global Constraints): versões fixadas, sem novas dependências salvo necessidade justificada, nunca logar corpo de mensagem, `canSee`/`visibleChatsWhere` em toda leitura de conversa, Origin em toda mutação, commits Conventional com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

# Umbler 2.0 — atendimento WhatsApp do escritório

Sistema próprio de atendimento a clientes pelo WhatsApp, feito para substituir o Umbler Talk no escritório. Vários atendentes usam o mesmo número, organizados por setores, com transferência, notas internas, respostas rápidas e triagem automática.

> **Repositório privado.** O código vai guardar dados de clientes de um escritório de advocacia (LGPD). Nunca versione `.env`, `data/` ou `screenshots/`. O `.gitignore` já bloqueia esses caminhos.

## O que já funciona (núcleo, v0.1)

- **Conexão WhatsApp** por QR Code, via [Evolution API](https://github.com/EvolutionAPI/evolution-api) v2.3.7. A tela mostra o status do canal e tem o botão de reconectar.
- **Caixa de conversas:**
  - abas Entrada, Esperando e Finalizados;
  - busca e filtros por setor, atendente, etiqueta e período;
  - não lidas e conversas fixadas;
  - botão de nova conversa.
- **Conversa:**
  - texto, imagem, áudio (ouvir e gravar), vídeo e documento;
  - resposta citada, reações, status ✓✓ e notas internas;
  - linha do tempo de eventos e assinatura `*Setor - Nome:*`.
- **Atendimento:** assumir, transferir (setor e/ou atendente), privar ou liberar, finalizar (com mensagem de encerramento) e reabrir.
- **Contatos:** ficha, campos personalizados (ex.: CPF), observações, etiquetas, bloqueio e histórico.
- **Cadastros:**
  - setores, etiquetas e campos personalizados;
  - usuários (admin ou atendente);
  - respostas rápidas com `/` e variáveis como `{{contato.nome}}`.
- **Triagem:** menu de boas-vindas com opções numeradas que encaminham a conversa para o setor.
- **Tempo real e notificações:** atualização ao vivo pelo WebSocket, som e notificação do navegador.
- **Importador do Umbler Talk:** traz contatos, setores, etiquetas, respostas rápidas e campos, com simulação antes de gravar (`--dry-run`).

Fica para os próximos módulos (sub-projetos 2 e 3): editor visual de chatbot, horários, agendamentos, relatórios, logs de atividade, webhooks e permissões finas.

## Arquitetura

```
navegador ──HTTPS──► caddy ──► app (Node 24 · TypeScript · um processo)
                                 ├─ API REST (Fastify)        /api/*
                                 ├─ tempo real (WebSocket)    /ws
                                 ├─ webhook da Evolution      /webhooks/evolution/:segredo  (só rede interna)
                                 └─ telas React compiladas    /
                               ├──► postgres 16  (bancos talk e evolution)
                               └──► evolution-api v2.3.7 ──► WhatsApp (QR Code)
```

| Camada | Tecnologia |
|---|---|
| Servidor | Node 24, Fastify 5, Drizzle ORM, postgres.js, Zod 4, argon2id |
| Telas | React 19, Vite 8, Tailwind 4, TanStack Query 5, React Router 8, Phosphor Icons |
| Testes | Vitest 5, PGlite (Postgres em memória), Testing Library |
| Implantação | Docker Compose, Caddy (HTTPS automático), Postgres 16, Evolution API |

## Estrutura do repositório

```
shared/        tipos compartilhados entre servidor e telas (DTOs, eventos do WebSocket, paleta)
server/        API, tempo real, regras de atendimento, integração com a Evolution
  src/whatsapp/   único módulo que conhece a Evolution (envio, webhook, telefones BR)
  src/inbox/      regras de conversa e visibilidade (canSee)
  src/messages/   entrada, envio, mídia, respostas rápidas
  src/importer/   importação única do Umbler Talk
  drizzle/        migrations SQL
  test/           testes (rodam sem rede e sem Docker)
web/           telas (caixa de entrada, conversa, contatos, configurações)
scripts/       init do banco, backup, geração de segredos, ambiente de dev
docs/
  IMPLANTACAO.md   instalação no VPS, atualização, backup, restauração e checklist da virada
  superpowers/     especificação, plano de implementação e decisões
  umbler/          engenharia reversa do Umbler Talk (telas, endpoints, modelo de dados)
```

## Rodar localmente (desenvolvimento)

Requisitos: **Node 24.15+**, **Docker Desktop** e Git.

```bash
git clone https://github.com/TheoCarvalhoDEV/Umbler2.0.git
cd Umbler2.0
npm install

# 1. Variáveis do ambiente local (senhas só para o Docker local)
cp .env.dev.example .env.dev

# 2. Postgres + Evolution API em Docker (portas presas em 127.0.0.1)
npm run dev:up

# 3. API (porta 3000) + telas (porta 5173), com recarga automática
npm run dev

# 4. Em outro terminal, crie o primeiro administrador (a senha é pedida no terminal)
npm run dev:admin -- --email voce@exemplo.com --name "Seu Nome"
```

Abra **http://localhost:5173** e entre com o admin. Primeiros passos:

1. **Configurações › Setores:** crie os setores. O primeiro vira o padrão, para onde caem as conversas novas.
2. **Configurações › Canais:** clique em *Novo canal* e depois em *Conectar*. Leia o QR Code no WhatsApp do celular (*Aparelhos conectados*).
   > ⚠️ Use um **número de teste**. Ao ler o QR com o número do escritório, ele **sai do Umbler Talk** na hora.
3. Mande uma mensagem de outro celular para o número conectado. Ela aparece na caixa de entrada.

Para desligar: `Ctrl+C` no `npm run dev` e `npm run dev:down` (os dados ficam no volume do Docker). Para apagar tudo: `docker compose -f docker-compose.dev.yml --env-file .env.dev down -v`.

## Testes

```bash
npm test            # servidor + telas (não precisa de Docker: o banco de teste é o PGlite em memória)
npm run typecheck
npm run build
```

## Produção

Veja **[docs/IMPLANTACAO.md](docs/IMPLANTACAO.md)**: requisitos do VPS, instalação passo a passo, primeiro admin, conexão do WhatsApp, importação do Umbler, atualização (com volta), backup, ensaio de restauração e checklist da virada.

## Branches e fluxo de trabalho

| Branch | Papel |
|---|---|
| `main` | Versão estável, a que roda em produção. Só recebe merge de `develop` por Pull Request, e cada versão leva uma tag (`v0.1.0`, …). |
| `develop` | Integração: onde as funcionalidades prontas se juntam antes de virar versão. |
| `feat/<nome>` | Uma funcionalidade nova, criada a partir de `develop` (ex.: `feat/nucleo-atendimento`, `feat/chatbot-fluxo`). |
| `fix/<nome>` | Correção, criada a partir de `develop`. Para uma urgência em produção, crie a partir de `main` e leve a correção para as duas branches. |

Fluxo: `feat/*` → PR para `develop` → testes passando → PR `develop` → `main` → tag da versão → deploy.
Mensagens de commit no padrão [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).

## Documentação do projeto

- [Especificação do núcleo](docs/superpowers/specs/2026-10-14-nucleo-atendimento-design.md): o que o sistema faz, regras e segurança.
- [Plano de implementação](docs/superpowers/plans/2026-10-14-nucleo-atendimento.md) e [decisões tomadas](docs/superpowers/plans/2026-10-14-nucleo-atendimento-decisoes.md).
- [Mapa do Umbler Talk](docs/umbler/MAPA-UMBLER-TALK.md), [endpoints internos](docs/umbler/ENDPOINTS-INTERNOS.md) e [modelo de dados](docs/umbler/MODELO-DE-DADOS.md): a referência usada para reproduzir o sistema.

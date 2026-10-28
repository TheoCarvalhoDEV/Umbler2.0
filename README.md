# Umbler 2.0 — atendimento WhatsApp do escritório

Sistema próprio de atendimento a clientes pelo WhatsApp, feito para substituir o Umbler Talk no escritório. Vários atendentes usam o mesmo número, organizados por setores, com transferência, notas internas, respostas rápidas e triagem automática.

> **Repositório privado.** O código vai guardar dados de clientes de um escritório de advocacia (LGPD). Nunca versione `.env`, `data/` ou `screenshots/`. O `.gitignore` já bloqueia esses caminhos.

## Núcleo do atendimento

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
- **Importar do Umbler** (Ajustes › Importar do Umbler, admin): traz tudo do Umbler Talk, inclusive as conversas abertas e finalizadas com mensagens, notas e arquivos. Analisa antes de gravar e só lê o Umbler. Passo a passo em `docs/IMPLANTACAO.md` › Importar do Umbler Talk.

## Chatbot (entrega 2a)

- **Editor visual de fluxos** em Chatbot, no menu lateral (ou Ajustes › Chatbots):
  - blocos ligados por setas (React Flow) e paleta por categoria com busca (atalho `Tab`);
  - auto-organizar e desfazer/refazer;
  - salvar rascunho e **Salvar e publicar** (só publica um fluxo sem problemas);
  - versões com restauração, e importar ou exportar em JSON.
- **Blocos:**
  - início por um canal ou manual;
  - condições: dia da semana, horário, aguardar intervalo, regras com E/OU, várias condições, comparar valor, distribuir por peso, contato ativo, primeira conversa, campo e etiquetas do contato, setor, canal, atendente e situação da conversa, mensagem contém e outro chatbot rodando;
  - ações: enviar mensagem e arquivo, nota interna, pedir para escolher, pedir informação (com validação de CPF, CNPJ, e-mail, telefone, mídia ou expressão própria), preencher campo, editar etiquetas, transferir para setor ou atendente, privacidade, notificar atendente, acionar outro fluxo e bloquear contato;
  - finalizar conversa;
  - anotação.
- **Motor gravado no banco:** cada passo fica salvo no Postgres. As esperas (resposta do contato, intervalo de tempo, "sem resposta em X horas") voltam sozinhas por um relógio interno, mesmo depois de reiniciar o servidor.
- **Modelo "Fluxo do escritório":** recria o fluxo usado hoje no Umbler com **Criar a partir do modelo**. Ele passa por horário, boas-vindas, menu, comunicado e CPF validado e salvo no campo, e termina no setor certo com o atendente notificado.
- **Na conversa:**
  - as mensagens do bot aparecem com o ícone de robô e "Chatbot <nome>", e os eventos do bot entram na linha do tempo;
  - o botão de robô no compositor executa ou para um chatbot;
  - em Ajustes › Conversas você escolhe o que fazer quando o atendente escreve com o bot rodando: Perguntar, Parar o bot ou Manter rodando.
- Com um chatbot ativo que inicia pelo canal, a triagem simples não roda nesse canal.
- **Modelo "Triagem inteligente"**, ao lado do "Fluxo do escritório": o menu aceita número ou palavras-chave (boleto, processo, audiência…) e pula o CPF quando ele já está no cadastro. O botão **Importar** do editor cria um chatbot a partir de um arquivo exportado.

## Histórico do WhatsApp

- **Importação ao ler o QR:** o celular manda o histórico recente (cerca de 3,5 meses) e o sistema copia da Evolution, no período escolhido em Ajustes › Canais (**3 meses**, **12 meses** ou **Tudo**). A cópia se repete a cada 2 minutos enquanto chegam mensagens novas e termina após 10 minutos sem novidade (no máximo 1 hora). A tela mostra "Importando histórico… N mensagens" e, no fim, "Histórico importado: N mensagens, desde DD/MM/AAAA".
- **Importar histórico** (admin) copia de novo o que a Evolution já guardou, sem QR. Uma importação por canal de cada vez.
- **Só histórico:** nada importado conta como não lido, vai para a fila ou dispara chatbot ou triagem. Vai para a conversa aberta do contato, se houver; senão, para uma **conversa de histórico** (finalizada, só leitura, visível para todos os atendentes; aparece na aba Finalizados com a etiqueta "Histórico do WhatsApp", na ficha do contato e na busca).
- **Contatos sem número:** quem o WhatsApp só identifica por um código interno aparece como "Contato sem número" e é juntado sozinho ao contato com telefone quando o número aparece.
- **Mídia:** fotos, áudios, vídeos e documentos das últimas 3 semanas são baixados em segundo plano; os mais antigos mostram "Arquivo não está mais disponível no WhatsApp". O botão **Baixar** tenta de novo quando a mídia ainda não veio.
- **Recuperação:** a cada 5 minutos (e ao ligar o servidor) o sistema copia da Evolution, como histórico, as mensagens que chegaram enquanto ele estava fora do ar.
- **Canal:** aviso para os admins quando um canal fica desconectado por mais de 1 minuto; o QR aparece mesmo quando demora ("Gerando QR code…"); com mais de um canal, o nome do canal aparece no cartão da conversa.
- Grupos ficam de fora. Guardar o histórico na Evolution tem efeito na LGPD: veja `docs/IMPLANTACAO.md` › Histórico do WhatsApp e LGPD.

## Dia a dia, agenda e relatórios

- **Ações de mensagem:** reagir, apagar, editar, figurinhas e encaminhar. Negrito, itálico, riscado e monoespaçado do WhatsApp aparecem formatados.
- **Na conversa:** editar e apagar notas internas, buscar dentro da conversa, mensagens favoritas (valem para a equipe), baixar mídias e ver fotos e PDFs na própria página.
- **Na lista:** escolher a ordem (inclusive "quem espera há mais tempo"), agir em várias conversas de uma vez (transferir, finalizar, marcar como lida) e etiquetas da conversa. O cartão mostra setor, etiqueta e atendente.
- **Agenda** (menu lateral):
  - mensagens agendadas, enviadas no horário de Cuiabá como o autor;
  - compromissos (audiência, perícia, reunião…) com lembretes automáticos ao cliente, que se recalculam quando o horário muda;
  - controle dos compromissos: situação (confirmado, compareceu, faltou…), contadores, filtros, busca e visão de semana e mês.
- **Regras automáticas** (Ajustes › Regras automáticas): devolver à fila as conversas paradas e finalizar por inatividade.
- **Cliente que volta** (Ajustes › Conversas): a conversa nova de quem foi atendido há até N dias (padrão 90) abre no mesmo setor e com o mesmo atendente, sem chatbot nem triagem.
- **Relatórios** (menu lateral, admins): primeira resposta, conversas por dia, horários de pico, por setor e por atendente, com período de hoje até 366 dias.
- **Excluir** atendente (as conversas abertas voltam para a fila do setor) e canal (desconecta o WhatsApp e apaga as conversas do canal).
- **Preferências** (Ajustes › Preferências, para todos): Enter envia ou quebra linha, som de nova mensagem (Suave, Gota ou Sino) e notificações do navegador. Tema claro e escuro.

Fica para os próximos módulos:
- chatbot 2b (avaliação, etiquetas da conversa, fluxo de espera, presença do atendente e outros blocos);
- chatbot 2c (Webhook, Pipedrive, Asaas);
- logs de atividade, webhooks e permissões finas.

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
| Telas | React 19, Vite 8, Tailwind 4, TanStack Query 5, React Router 8, Phosphor Icons, React Flow 12 (`@xyflow/react`), dagre |
| Testes | Vitest 5, PGlite (Postgres em memória), Testing Library |
| Implantação | Docker Compose, Caddy (HTTPS automático), Postgres 16, Evolution API |

## Estrutura do repositório

```
shared/        tipos compartilhados entre servidor e telas (DTOs, eventos do WebSocket, paleta)
server/        API, tempo real, regras de atendimento, integração com a Evolution
  src/whatsapp/   único módulo que conhece a Evolution (envio, webhook, telefones BR)
  src/inbox/      regras de conversa e visibilidade (canSee)
  src/messages/   entrada, envio, mídia, respostas rápidas
  src/bots/       chatbot: motor, blocos, relógio, validação dos fluxos, modelo do escritório
  src/history/    histórico do WhatsApp: cópia da Evolution, junção de contatos, fila de mídia
  src/automation/ mensagens agendadas, compromissos e regras automáticas (relógio a cada 15 s / 1 min)
  src/reports/    relatórios
  src/importer/   importação única do Umbler Talk
  drizzle/        migrations SQL
  test/           testes (rodam sem rede e sem Docker)
web/           telas (caixa de entrada, conversa, contatos, agenda, relatórios, ajustes, editor de chatbot)
scripts/       init do banco, backup, geração de segredos, ambiente de dev, servidor do Windows
docs/
  IMPLANTACAO.md      instalação num VPS, atualização, backup, restauração e checklist da virada
  SERVIDOR-WINDOWS.md o computador do escritório como servidor
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

1. **Ajustes › Setores:** crie os setores. O primeiro vira o padrão, para onde caem as conversas novas.
2. **Ajustes › Canais:** clique em *Novo canal* e depois em *Gerar novo QR / Reconectar*. Leia o QR Code no WhatsApp do celular (*Aparelhos conectados*).
   > ⚠️ Use um **número de teste**. Ao ler o QR com o número do escritório, ele **sai do Umbler Talk** na hora.
3. Mande uma mensagem de outro celular para o número conectado. Ela aparece na caixa de entrada.

Para desligar: `Ctrl+C` no `npm run dev` e `npm run dev:down` (os dados ficam no volume do Docker). Para apagar tudo: `docker compose -f docker-compose.dev.yml --env-file .env.dev down -v`.

## Backup e mudança de computador

Vale para a instalação acima (`docker-compose.dev.yml`). Em produção, veja [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).

```bash
npm run backup -- E:/TalkBackup   # use uma pasta em OUTRO disco
```

O backup grava na pasta:
- `banco/banco-AAAA-MM-DD.sql`: os bancos `talk` e `evolution`, ou seja, conversas, setores, atendentes, etiquetas, notas, chatbots, ajustes e o login do WhatsApp. Ficam os 7 últimos. As chaves de criptografia do WhatsApp ficam no volume do Docker e não entram no backup (passo 5 abaixo).
- `arquivos/`: fotos, áudios e documentos. Só copia o que é novo ou mudou, e nunca apaga.
- `.env.dev`: as senhas. Sem elas, o banco restaurado não abre. Quem lê a pasta lê tudo, então trate a pasta como o próprio `.env.dev`.

Para restaurar no mesmo computador ou num computador novo (Git Bash, na raiz do projeto, com `npm install` feito):

1. **Desligue o sistema no computador antigo**: pare o servidor e rode `npm run dev:down`. O WhatsApp não pode ficar conectado em dois lugares.
2. Copie o `.env.dev` do backup para a raiz do projeto.
3. Restaure o banco. O servidor do app tem que estar parado, porque com conexões abertas o `DROP DATABASE` do dump falha:
   ```bash
   npm run dev:up
   docker compose -f docker-compose.dev.yml --env-file .env.dev stop evolution
   docker exec -i talk-dev-postgres-1 psql -q -U postgres -d postgres < E:/TalkBackup/banco/banco-AAAA-MM-DD.sql > /dev/null
   ```
4. Copie `E:/TalkBackup/arquivos/` para `data/dev-media/`.
5. Rode `npm run dev:up` de novo e suba o servidor.
6. **Num computador novo**, vá em Ajustes › Canais, clique em **Gerar novo QR / Reconectar** e leia o QR com o celular do escritório, **mesmo que o canal mostre Conectado**. Sem as chaves de criptografia, que não vão no backup, muitas mensagens dos clientes não chegam. No mesmo computador as chaves continuam no volume do Docker e o canal volta sozinho.

## Servidor do escritório (Windows)

Um computador do escritório ligado 24 horas, com acesso pela internet por túnel do Cloudflare: [docs/SERVIDOR-WINDOWS.md](docs/SERVIDOR-WINDOWS.md). Resumo: `npm run servidor`.

## Testes

```bash
npm test            # servidor + telas (não precisa de Docker: o banco de teste é o PGlite em memória)
npm run typecheck
npm run build
```

## Produção

Hoje o sistema roda num computador do escritório, com o arranjo do desenvolvimento e um túnel do Cloudflare: **[docs/SERVIDOR-WINDOWS.md](docs/SERVIDOR-WINDOWS.md)**.

Para um VPS com domínio próprio, use **[docs/IMPLANTACAO.md](docs/IMPLANTACAO.md)** (`docker-compose.yml` com Caddy): requisitos, instalação passo a passo, primeiro admin, conexão do WhatsApp, importação do Umbler, atualização (com volta), backup, ensaio de restauração e checklist da virada.

## Branches e fluxo de trabalho

| Branch | Papel |
|---|---|
| `main` | A versão que roda no escritório. Só recebe merge por Pull Request. |
| `feat/<nome>` | Uma funcionalidade nova, criada a partir de `main` (ex.: `feat/relatorios`). |
| `fix/<nome>` | Uma correção, criada a partir de `main`. |
| `docs/<nome>` | Só documentação. |

Fluxo: branch a partir de `main` → testes passando → PR para `main` → merge → atualizar o servidor (docs/SERVIDOR-WINDOWS.md › Atualizar o sistema).
Mensagens de commit no padrão [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).

## Documentação do projeto

- [Especificação do núcleo](docs/superpowers/specs/2026-10-14-nucleo-atendimento-design.md): o que o sistema faz, regras e segurança. [Plano](docs/superpowers/plans/2026-10-14-nucleo-atendimento.md) e [decisões tomadas](docs/superpowers/plans/2026-10-14-nucleo-atendimento-decisoes.md).
- Uma especificação por módulo em [docs/superpowers/specs/](docs/superpowers/specs/) e o plano de cada uma em [docs/superpowers/plans/](docs/superpowers/plans/): [chatbot 2a](docs/superpowers/specs/2026-10-15-chatbot-fluxos-2a-design.md), [visibilidade e fotos](docs/superpowers/specs/2026-10-15-visibilidade-e-fotos.md), [ações de mensagem](docs/superpowers/specs/2026-10-16-acoes-mensagem-design.md), [histórico do WhatsApp](docs/superpowers/specs/2026-10-16-historico-whatsapp-design.md), [conversa no dia a dia](docs/superpowers/specs/2026-10-19-conversa-dia-a-dia-design.md), [lista no dia a dia](docs/superpowers/specs/2026-10-20-lista-dia-a-dia-design.md), [agendamentos e regras](docs/superpowers/specs/2026-10-20-agendamentos-e-regras-design.md), [compromissos](docs/superpowers/specs/2026-10-21-compromissos-design.md), [controle de compromissos](docs/superpowers/specs/2026-10-23-controle-compromissos-design.md) e [importar do Umbler](docs/superpowers/specs/2026-10-21-importar-umbler-design.md).
- Roteiros de aceite manual (`*-aceite.md` em [docs/superpowers/plans/](docs/superpowers/plans/)): chatbot, ações de mensagem, histórico do WhatsApp, compromissos e importar do Umbler. Os módulos mais recentes (relatórios, cliente que volta, excluir atendente, backup, servidor do Windows) estão descritos nos próprios PRs.
- [Mapa do Umbler Talk](docs/umbler/MAPA-UMBLER-TALK.md), [endpoints internos](docs/umbler/ENDPOINTS-INTERNOS.md) e [modelo de dados](docs/umbler/MODELO-DE-DADOS.md): a referência usada para reproduzir o sistema.

# Implantação em produção (VPS)

Sistema próprio de atendimento pelo WhatsApp que substitui o Umbler Talk.

Um VPS roda, via Docker Compose:

- **caddy**: HTTPS automático, a única porta aberta;
- **app**: API, tempo real e telas;
- **postgres**: bancos `talk` e `evolution`;
- **evolution**: a ponte com o WhatsApp, conectada por QR Code.

A mídia fica em `/opt/talk/data/media` e os backups em `/opt/talk/data/backup`.

> Segurança:
> - O arquivo `.env` contém todos os segredos. Ele nunca vai para o git.
> - Guarde uma cópia do `.env` fora do servidor, num gerenciador de senhas. Sem ela não há restauração.
> - O banco `evolution` também guarda cópias de mensagens de clientes. Ele entra no backup e segue as mesmas regras da LGPD do banco `talk`.

## 1. Requisitos do VPS

- Ubuntu 24.04 LTS, 2 vCPU, 4 GB de RAM, 40 GB de disco ou mais (a mídia cresce com o uso).
- Um domínio, por exemplo `talk.jvo.adv.br`, com registro DNS **A** apontando para o IP do VPS.
- Portas 80 e 443 liberadas no firewall do provedor. Só o Caddy publica portas: Postgres e Evolution ficam na rede interna do Docker.
- Backup automático ou snapshot do provedor ativado. Confirme no painel que a cópia fica **fora** do VPS e anote a retenção. Se o provedor não oferecer, use o restic (seção 7.1).

## 2. Instalação passo a passo

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # saia e entre de novo no SSH

# 2. Firewall
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable

# 3. Código
sudo mkdir -p /opt/talk && sudo chown "$USER" /opt/talk
git clone https://github.com/TheoCarvalhoDEV/Umbler2.0.git /opt/talk
cd /opt/talk

# 4. Segredos (gera .env com chmod 600; troque pelo seu domínio)
sh scripts/gen-secrets.sh talk.jvo.adv.br

# 5. Pastas de dados (o app roda como usuário 1000 dentro do container).
#    700: dumps e mídia têm dados de clientes; nenhuma outra conta do VPS deve lê-los.
mkdir -p data/media data/backup && chmod 700 data/backup
sudo chown -R 1000:1000 data/media && sudo chmod 700 data/media

# 6. Subir tudo (a primeira vez compila a imagem: alguns minutos)
docker compose up -d --build
docker compose ps
curl -fsS https://talk.jvo.adv.br/api/health
```

- O Postgres cria os bancos `talk` e `evolution` na primeira subida (`scripts/init-db.sh`).
- O app aplica as migrations sozinho toda vez que inicia.
- Se o `curl` falhar logo no início, espere um minuto: o Caddy ainda está emitindo o certificado.

## 3. Primeiro administrador

```bash
cd /opt/talk
read -rs -p 'Senha do administrador (mín. 8): ' SEED_ADMIN_PASSWORD; echo; export SEED_ADMIN_PASSWORD
docker compose exec -e SEED_ADMIN_PASSWORD app node --import tsx server/src/auth/seed-admin.ts --email voce@jvo.adv.br --name "Seu Nome"
unset SEED_ADMIN_PASSWORD
```

Saída esperada: `Administrador criado: voce@jvo.adv.br`.

Depois disso, entre em `https://talk.jvo.adv.br` e crie os demais usuários pela tela de Configurações.

## 4. Conectar o WhatsApp

1. Entre como administrador e vá em **Configurações → Canais**.
2. Crie o canal. Em **Período do histórico** escolha **3 meses**, **12 meses** ou **Tudo** e clique em **Gerar novo QR / Reconectar**. Enquanto o código é preparado a tela mostra "Gerando QR code…".
3. No celular do escritório: WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** → leia o QR.
4. O status muda para **Conectado** e aparece "Importando histórico… N mensagens". O celular manda o histórico recente (cerca de 3,5 meses, mesmo com "12 meses" ou "Tudo") e o sistema copia em segundo plano por até 1 hora. No fim: "Histórico importado: N mensagens, desde DD/MM/AAAA".

Atenção: conectar o mesmo número aqui desconecta o número do Umbler Talk. Faça isso só no dia da virada (seção 10).

Se o canal cair (logout pelo celular, QR expirado), depois de 1 minuto os administradores veem na caixa de entrada a faixa "Canal X desconectado: leia o QR code em Configurações › Canais". Repita os passos 2 e 3. **Importar histórico** copia de novo o que a Evolution já guardou, sem ler o QR.

### 4.1 Histórico do WhatsApp e LGPD

A Evolution guarda o histórico que o celular manda a cada leitura de QR (`DATABASE_SAVE_DATA_HISTORIC`, `DATABASE_SAVE_DATA_CHATS` e `DATABASE_SAVE_DATA_CONTACTS` = `"true"` no `docker-compose.yml`). Isso muda a decisão do núcleo (§6), que não guardava esse texto:

- o banco `evolution` passa a ter o **texto** das conversas do celular, cerca de 1 kB por mensagem (~45 MB por leitura de QR com o volume do escritório), **inclusive de grupos**: o sistema não importa grupos, mas a Evolution os guarda;
- a mídia não fica na Evolution: o sistema baixa só a das últimas 3 semanas para `data/media`;
- esse banco já está no backup diário (`pg_dumpall`, seção 7) e segue as mesmas regras de acesso e retenção do núcleo. O dump fica maior.

Não há tela para apagar o histórico da Evolution. Depois que a importação terminou ("Histórico importado…" em Configurações › Canais), você pode apagar da Evolution as mensagens com mais de N dias. O que já foi importado continua no sistema. Use N de pelo menos **30**: o botão **Baixar** e a recuperação de mensagens perdidas usam as linhas recentes. **Importar histórico** só traz de novo o que ainda estiver na Evolution.

```bash
docker compose exec postgres psql -U postgres -d evolution
```

```sql
-- 1) Conte antes (troque 90 pelo número de dias que vai manter):
SELECT i.name AS instancia, count(*) AS mensagens
FROM evolution_api."Message" m
JOIN evolution_api."Instance" i ON i.id = m."instanceId"
WHERE m."messageTimestamp" < extract(epoch FROM now() - interval '90 days')
GROUP BY i.name;

-- 2) Apague só a instância do canal (o nome "talk-xxxxxxxx" do passo 1).
--    As linhas de "MessageUpdate" dessas mensagens saem junto (cascata).
BEGIN;
DELETE FROM evolution_api."Message" m
USING evolution_api."Instance" i
WHERE i.id = m."instanceId"
  AND i.name = 'talk-xxxxxxxx'
  AND m."messageTimestamp" < extract(epoch FROM now() - interval '90 days');
COMMIT;
```

Rode o passo 1 de novo: a instância não deve aparecer. Anote a data e o N usado no registro de tratamento de dados do escritório.

## 5. Importar do Umbler Talk

A tela **Ajustes › Importar do Umbler** (só administradores) traz do Umbler Talk tudo o que o escritório tem lá: contatos (com etiquetas, campos e observações), setores, etiquetas, campos personalizados, respostas rápidas, atendentes e **todas as conversas**, abertas e finalizadas, com mensagens, notas internas e arquivos. O importador só **lê** o Umbler (só `GET`; nunca marca conversa como lida).

1. No Umbler Talk, entre com o **Proprietário**: **Conta → Perfil → Tokens de acesso** → crie um token.
2. No servidor, coloque o token no `.env` e recrie o app. O token nunca aparece na tela, nos logs nem no banco:

```bash
cd /opt/talk
read -rs -p 'Token do Umbler: ' UMBLER_TOKEN; echo
printf 'UMBLER_TOKEN=%s\n' "$UMBLER_TOKEN" >> .env; unset UMBLER_TOKEN
chmod 600 .env
docker compose up -d app
```

3. Em **Ajustes › Regras automáticas**, desligue as duas regras: com elas ligadas a importação fica bloqueada.
4. Em **Ajustes › Importar do Umbler**, clique em **Analisar** (cerca de 1 minuto). Confira as contagens, os avisos e o destino de cada canal, setor e atendente. Atendente sem e-mail igual aqui vira usuário **inativo**: guarda quem atendeu cada conversa e pode ser ativado em Ajustes › Atendentes.
5. Clique em **Importar**. A cópia roda em segundo plano (algumas horas, conforme o volume de arquivos), retoma sozinha se o sistema reiniciar e termina com um relatório na mesma tela. Se parar, a tela diz o motivo e oferece **Continuar**.
6. Com o relatório conferido: apague o token no Umbler, tire a linha `UMBLER_TOKEN` do `.env` e rode `docker compose up -d app`.

**Ensaio (ambiente de teste, antes da virada).** O ensaio recebe dados reais de clientes: o ambiente de teste precisa da mesma proteção da produção (HTTPS, senhas fortes, acesso restrito). No mapeamento, escolha o canal de teste para o canal do Umbler. Ninguém responde cliente pelo número de teste. Siga o [roteiro de aceite](superpowers/plans/2026-10-21-importar-umbler-aceite.md) e, no fim, apague o ambiente inteiro: `docker compose down -v` e a pasta `data/media`.

**Dia da virada (produção), nesta ordem:**

1. Fim do expediente no Umbler; anote as contagens de Entrada, Esperando e Finalizados.
2. Conecte o número oficial em Ajustes › Canais (isso desconecta o Umbler, que fica congelado) e espere a importação automática do histórico do WhatsApp terminar.
3. Analisar → conferir o mapeamento e as contagens → Importar. As conversas abertas chegam nos primeiros minutos e o escritório já atende aqui; as finalizadas chegam depois, das mais recentes para as mais antigas.
4. Relatório conferido ("casadas com o histórico do WhatsApp" maior que zero e uma conversa recente sem mensagens repetidas) → apague o token → uma semana de consulta → cancele o Umbler e peça o encerramento da organização.

Se o Umbler deixar de responder à API com o canal desconectado, a ordem inversa (importar antes de conectar, com o escritório parado) também funciona: as mensagens repetidas são casadas nos dois sentidos.

## 6. Atualizar

### 6.1 Atualizar o sistema

```bash
cd /opt/talk
sh scripts/backup.sh                       # sempre antes de atualizar
git log -1 --format=%h > data/backup/versao-anterior.txt
git pull
docker compose up -d --build app
docker compose logs --tail 50 app          # migrations aplicadas, sem erro
curl -fsS https://talk.jvo.adv.br/api/health
```

Chatbots durante a atualização:
- Uma execução que espera resposta do contato ou um tempo continua sozinha depois que o app volta.
- Uma execução que estava no meio de um passo quando o app parou fica como falhou, com o motivo "Interrompido por reinício do servidor". A conversa segue com os atendentes.

**Voltar a versão** se algo quebrar:

```bash
git checkout "$(cat data/backup/versao-anterior.txt)"
docker compose up -d --build app
```

Se a atualização tinha migration de banco, restaure também o banco da hora do backup. Pare antes o app e a Evolution: com conexões abertas, o `DROP DATABASE` do dump falha e o banco fica pela metade.

```bash
docker compose stop app evolution
docker compose exec -T postgres psql -U postgres -d postgres < data/backup/db.sql > /dev/null
docker compose up -d
curl -fsS https://talk.jvo.adv.br/api/health
```

Até dois erros sobre o papel `postgres` (`current user cannot be dropped`, `role "postgres" already exists`) são normais. Qualquer outro erro deve ser investigado. Mensagens recebidas depois do backup se perdem nesse caso.

### 6.2 Atualizar a Evolution API (com volta)

A Evolution usa tag fixa no `FROM` de `evolution/Dockerfile` (hoje `evoapicloud/evolution-api:v2.3.7`). Nunca use `latest`. O Dockerfile aplica um conserto no Baileys: sem ele, depois de o canal ficar fora do ar, a fila de mensagens pendentes para nos primeiros 100 itens e as mensagens novas não chegam. O comentário no Dockerfile explica o conserto.

1. Leia as notas da nova versão em https://github.com/EvolutionAPI/evolution-api/releases.
2. Anote a tag atual e faça um dump só do banco da Evolution:

```bash
cd /opt/talk
grep '^FROM' evolution/Dockerfile | tee -a data/backup/evolution-tags.txt
docker compose exec -T postgres pg_dump -U postgres -Fc evolution > data/backup/evolution-antes-da-atualizacao.dump
```

3. Troque a tag no `FROM` de `evolution/Dockerfile`, por exemplo `v2.3.7` por `v2.3.8`, e suba. Se o build falhar com "Baileys mudou", a nova versão mexeu no trecho consertado. Nesse caso, veja se ela já resolve o problema e ajuste ou remova o conserto.

```bash
docker compose build --pull evolution
docker compose up -d evolution
docker compose logs --tail 50 evolution
```

4. Teste: o canal continua **Conectado**, e uma mensagem enviada e uma recebida funcionam (texto e uma imagem).

**Voltar** se algo falhar:

```bash
docker compose stop evolution
# devolva a tag anterior no FROM de evolution/Dockerfile (está em data/backup/evolution-tags.txt)
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE evolution' -c 'CREATE DATABASE evolution OWNER evolution'
docker compose exec -T postgres pg_restore -U postgres -d evolution < data/backup/evolution-antes-da-atualizacao.dump
docker compose up -d --build evolution
```

Se o canal não voltar a **Conectado**, use **Gerar novo QR / Reconectar** (seção 4).

## 7. Backup

`scripts/backup.sh` faz o dump do banco:

- **Banco:** `pg_dumpall` dos bancos `talk` e `evolution`. O dump vai para `data/backup/db.sql`, gravado primeiro como `.tmp` e só renomeado no fim. Um dump com falha nunca apaga o último bom. A pasta `data/backup` fica com permissão 700.
- O dump da Evolution guarda as credenciais e as mensagens, mas não as chaves de criptografia (volume `evolution_instances`). Depois de restaurar em servidor novo, gere um novo QR (seção 9, passo 9).
- **Mídia:** `data/media` **não** é copiada localmente (uma cópia no mesmo disco ocuparia o dobro do espaço e se perderia junto com ele). Ela é coberta pelo snapshot do provedor ou pelo restic (seção 7.1).

Agende uma vez:

```bash
sudo crontab -e
# adicione a linha:
30 3 * * * sh /opt/talk/scripts/backup.sh >> /var/log/talk-backup.log 2>&1
```

Confira no dia seguinte:

```bash
tail -n 3 /var/log/talk-backup.log
ls -l /opt/talk/data/backup
```

O log deve ter `backup ok`, com data de hoje.

### 7.1 Cópia fora do servidor

O backup acima fica **no mesmo VPS**: se o VPS for perdido, ele se perde junto. Use uma das opções:

- **Backup do provedor** (preferido, se existir): ative o backup ou snapshot diário automático do VPS. Confirme que é armazenado fora da máquina e com retenção de pelo menos 7 dias.
- **restic** (se o provedor não oferecer): siga as instruções comentadas no fim de `scripts/backup.sh`. Elas enviam `db.sql` e `data/media`, criptografados, para o Backblaze B2. Guarde a `RESTIC_PASSWORD` fora do VPS.

Os backups contêm dados pessoais de clientes (LGPD). Restrinja o acesso ao bucket e ao painel do provedor a quem administra o sistema.

## 8. Ensaio de restauração (obrigatório antes da virada)

Faça uma vez, num VPS descartável ou numa máquina com Docker, seguindo a seção 9 com o backup real. Só considere o ensaio concluído quando:

- o login funcionar;
- as conversas, contatos e cadastros aparecerem;
- uma mídia antiga abrir;
- depois de **Gerar novo QR / Reconectar** (com um número de teste), uma mensagem enviada por um contato que já existia chegar na caixa de entrada.

Depois, destrua a máquina de ensaio: ela contém dados de clientes.

## 9. Restauração (runbook)

Use este roteiro se perder o VPS ou o banco.

1. Crie o novo VPS e faça as etapas 1 a 3 da seção 2: Docker, firewall e código.
2. Restaure o `.env` guardado fora do servidor:

```bash
cd /opt/talk
nano .env          # cole o conteúdo guardado
chmod 600 .env
```

3. Traga `db.sql` e a mídia para `/opt/talk/data`:
   - **Do restic:**

```bash
sudo sh -c '. /root/.restic-env && restic restore latest --target /tmp/restauracao'
mkdir -p data/backup
sudo cp /tmp/restauracao/opt/talk/data/backup/db.sql data/backup/
sudo cp -a /tmp/restauracao/opt/talk/data/media data/
```

   - **Do snapshot do provedor:** restaure o snapshot inteiro ou copie dele `data/backup/db.sql` e `data/media`.
4. Ajuste o dono e as permissões:

```bash
sudo chown -R 1000:1000 data/media && sudo chmod 700 data/media
chmod 700 data/backup
```

5. Suba **só** o Postgres e espere ficar pronto:

```bash
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -h 127.0.0.1 -U postgres; do sleep 2; done
```

6. Restaure os dois bancos. Num servidor que já está rodando, pare antes o app e a Evolution (`docker compose stop app evolution`): com conexões abertas o restore falha.

```bash
docker compose exec -T postgres psql -U postgres -d postgres < data/backup/db.sql > /dev/null
```

   Até dois erros sobre o papel `postgres` (`current user cannot be dropped`, `role "postgres" already exists`) são normais. Qualquer outro erro deve ser investigado.

7. Suba o resto e confira:

```bash
docker compose up -d --build
curl -fsS https://talk.jvo.adv.br/api/health
```

8. Se o IP mudou, atualize o registro DNS **A** do domínio.
9. Entre no sistema, vá em **Configurações → Canais** e, depois de restaurar em servidor novo, **sempre** use **Gerar novo QR / Reconectar** e leia o QR com o celular do escritório, mesmo que o canal mostre **Conectado**. As chaves de criptografia do WhatsApp ficam no volume `evolution_instances`, que o backup não copia: sem novo QR, as mensagens dos clientes não chegam.
10. Reative o cron do backup (seção 7) e a cópia fora do servidor (seção 7.1).

## 10. Checklist da virada

**Antes do dia:**

- [ ] Sistema instalado, HTTPS funcionando, primeiro administrador criado.
- [ ] Usuários criados, cada um com seus setores e sua assinatura.
- [ ] "Importar do Umbler" ensaiado no ambiente de teste (seção 5, roteiro de aceite), relatório revisado e ambiente de teste apagado.
- [ ] No dia da virada: Importar do Umbler na ordem da seção 5 (depois de conectar o número oficial e de o histórico do WhatsApp terminar).
- [ ] Menu de triagem e mensagem de encerramento configurados.
- [ ] Chatbot: em Configurações › Chatbots, clicar em **Criar a partir do modelo** e preencher:
  - o nome do escritório;
  - o canal;
  - os três destinos (Atendimento, Financeiro e Processos), cada um com o seu setor e o seu atendente. O campo personalizado **CPF** é reaproveitado, ou criado se não existir.
- [ ] Chatbot: abrir o **Fluxo do escritório** no editor e conferir os textos e o bloco **Horário** com o horário real do escritório. O modelo vem com seg–sex, 08:00–12:00 e 14:00–18:00, no horário de Cuiabá. Se mudar algo, clicar em **Salvar e publicar**.
- [ ] Chatbot: clicar em **Ativar** na lista, porque o modelo é criado pausado. Com ele ativo, a triagem simples deixa de rodar nesse canal.
- [ ] Configurações › Conversas: escolher o que acontece quando o atendente escreve com o chatbot rodando. O padrão é Perguntar.
- [ ] Cron de backup rodando (`backup ok` no log) e cópia fora do servidor confirmada (seção 7.1).
- [ ] `.env` guardado fora do servidor.
- [ ] Ensaio de restauração feito (seção 8).
- [ ] Admins: entrar nos setores em Configurações › Atendentes ou usar “Ver todos os setores” na caixa de entrada (por padrão o admin vê só os próprios setores).
- [ ] Fotos: conferir a foto do cliente após a primeira mensagem e enviar a foto de cada atendente em Configurações › Perfil.
- [ ] Ao atualizar o sistema com o sistema em uso, recarregar as abas que estavam abertas durante a atualização.

**Teste manual com um número de teste, antes de conectar o número oficial:**

- [ ] Conectar pelo QR e ver o status **Conectado**.
- [ ] Receber e enviar: texto, imagem, áudio (ouvir e gravar), documento e vídeo.
- [ ] Responder citando uma mensagem, nos dois sentidos.
- [ ] Reação do contato aparece na mensagem. Um 👍 numa conversa **finalizada** não reabre a conversa.
- [ ] Ações de mensagem (reagir, apagar, editar, figurinhas, encaminhar): o [roteiro de aceite](superpowers/plans/2026-10-16-acoes-mensagem-aceite.md) passa inteiro, com as partes A a F marcadas.
- [ ] Mensagem digitada no celular do escritório aparece como enviada, sem ligar "Esperando", sem menu de triagem e sem iniciar o chatbot.
- [ ] Transferir para outro setor: o atendente do setor antigo deixa de ver a conversa.
- [ ] Finalizar com e sem a mensagem de encerramento; reabrir.
- [ ] Iniciar conversa: com um contato existente e com um telefone novo.
- [ ] Responder um contato que aparece sem telefone (só LID): a mensagem chega. Se a Evolution recusar o endereço `@lid`, anote para tratar.
- [ ] Triagem (com o chatbot pausado): o contato novo recebe o menu, escolhe uma opção e a conversa vai para o setor certo.
- [ ] Chatbot (ativo): o [roteiro de aceite](superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md) passa inteiro, com todas as partes, de A a F, marcadas.
- [ ] Anexo `.html` enviado pelo contato é baixado, não aberto no navegador.
- [ ] Desconectar pelo celular → banner vermelho → **Gerar novo QR / Reconectar** volta a conectar.

**Virada:**

1. [ ] Importar os cadastros mais recentes do Umbler (seção 5), se mudaram desde o teste.
2. [ ] Conectar o **número oficial** no sistema novo (seção 4). Isso desconecta o número do Umbler.
3. [ ] Se o número oficial ficou num canal diferente do canal de teste: no **Fluxo do escritório**, marcar esse canal no bloco **Iniciar por um canal** e clicar em **Salvar e publicar**. Em seguida, conferir na lista que o fluxo está ativo e mandar um `Oi` de um celular de teste para ver as boas-vindas.
4. [ ] Durante uma semana, consultar o histórico antigo no Umbler quando preciso.
5. [ ] Cancelar a assinatura do Umbler Talk.

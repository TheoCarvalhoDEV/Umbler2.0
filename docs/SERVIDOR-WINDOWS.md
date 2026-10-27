# Servidor do escritório no Windows

Um computador do escritório, ligado 24 horas, no mesmo arranjo do desenvolvimento: Postgres e Evolution no Docker, o app no Node e o acesso pela internet com um túnel do Cloudflare. Não precisa estar na mesma rede de ninguém, só ter internet.

Este guia serve para a pessoa e para o Claude Code rodando no próprio servidor. As partes marcadas **(pessoa)** mexem na BIOS, em contas ou em configurações de segurança do Windows. O Claude não faz essas partes, só confere.

## 1. Preparar o computador (pessoa)

- Nobreak e, de preferência, cabo de rede.
- **BIOS:** "Restore on AC Power Loss" (ou parecido) em **Power On**, e virtualização ligada (Intel VT-x ou AMD SVM).
- **Windows:**
  - Energia: nunca suspender.
  - Windows Update: "horário ativo" cobrindo o expediente.
  - Entrada automática: Win+R, `netplwiz`, desmarque "Os usuários devem digitar um nome de usuário e uma senha". Sem isso, depois de reiniciar, o sistema só volta quando alguém entra no Windows.
- **Programas:**
  - Docker Desktop, com "Start Docker Desktop when you sign in" marcado.
  - Git.
  - Node.js 24 LTS.
  - cloudflared: `winget install --id Cloudflare.cloudflared`.
- Entrar no GitHub no navegador. O repositório é privado, e o `git clone` abre o login.

Confira, num terminal novo:

```powershell
git --version; node -v; docker info --format "{{.ServerVersion}}"; cloudflared --version
```

## 2. Instalar o sistema

Use um caminho sem espaços.

```powershell
git clone https://github.com/TheoCarvalhoDEV/Umbler2.0.git C:\Umbler2.0
cd C:\Umbler2.0
npm install
```

O `.env.dev` com as senhas **vem do backup**, no dia da mudança (seção 4). Não gere um novo para o uso de verdade: com senhas diferentes, o banco restaurado não abre.

## 3. Ensaio sem dados (antes da mudança)

Serve para ver se o Docker, o túnel e o app ligam neste computador.

```powershell
copy .env.dev.example .env.dev
npm run servidor
```

Se o Windows perguntar se o Node.js pode usar a rede, permita **(pessoa)**: é por aí que a Evolution entrega as mensagens ao app. Espere a linha `no ar: https://….trycloudflare.com`. O link também fica em `data\link.txt`. Abra o link em outro aparelho: deve aparecer a tela de login. Feche com Ctrl+C.

Depois, apague o ensaio para começar limpo na mudança. Apaga só os dados de teste deste computador.

```powershell
docker compose -f docker-compose.dev.yml --env-file .env.dev down -v
del .env.dev
```

## 4. Dia da mudança

Combine um horário com a equipe. O atendimento fica fora do ar por cerca de 30 minutos. As mensagens de WhatsApp que chegarem nesse tempo aparecem quando o sistema volta.

**No computador antigo:**
1. Pare o servidor e o túnel.
2. Faça o último backup: `npm run backup -- E:/TalkBackup`.
3. Desligue os containers: `npm run dev:down`. O WhatsApp não pode ficar conectado em dois lugares.
4. Copie a pasta `E:\TalkBackup` inteira para um pendrive ou HD externo. Ela tem dados de clientes e as senhas: não use nuvem.

**No servidor:**
1. Copie a pasta do pendrive para `C:\TalkBackup`.
2. Restaure seguindo o [README › Backup e mudança de computador](../README.md#backup-e-mudança-de-computador). O `.env.dev` vem de `C:\TalkBackup\.env.dev`.
3. Acrescente ao `.env.dev`, numa linha nova, a pasta do backup diário. De preferência num segundo disco; se não houver, numa pasta fora do projeto:
   ```
   SERVIDOR_BACKUP_DIR=D:/TalkBackup
   ```
4. Rode `npm run servidor`. Confira em Ajustes › Canais que o WhatsApp está conectado e mande o link para a equipe.
5. Depois de conferir, apague a cópia do pendrive.

## 5. Ligar sozinho

Uma tarefa do Windows roda `scripts\servidor.cmd` toda vez que o Windows entra. Ela abre uma janela "Umbler 2.0 - servidor": **não feche essa janela**.

```powershell
schtasks /Create /TN "Umbler 2.0" /SC ONLOGON /TR "C:\Umbler2.0\scripts\servidor.cmd"
```

Teste reiniciando o computador. Ele deve entrar sozinho e, alguns minutos depois, o sistema volta no ar.

O que o `npm run servidor` faz:
- espera o Docker, sobe os containers e compila as telas;
- abre o túnel;
- religa o app se ele parar, e abre outro túnel se o túnel cair;
- faz o backup todo dia às 3h, se `SERVIDOR_BACKUP_DIR` estiver definido.

O registro fica em:
- `data\servidor.log`: o que o servidor fez, o link e o resultado de cada backup;
- `data\app.log`: só os avisos e erros do app.

## 6. Link fixo (quando houver domínio no Cloudflare)

Sem domínio, o link é temporário e **muda a cada início** (está em `data\link.txt` e no `servidor.log`). Para ter um link fixo:

1. **(pessoa)** No Cloudflare, abra Zero Trust › Networks › Tunnels e crie um túnel do tipo **cloudflared**.
2. Em **Public hostname**, use, por exemplo, `atendimento.seudominio.com.br` com o serviço `http://127.0.0.1:3000`. Outro sistema neste mesmo computador ganha outro hostname no mesmo túnel.
3. Copie o token do túnel. No `.env.dev`, acrescente a linha `TUNNEL_TOKEN` e **troque** a linha `APP_ORIGIN` que já existe:
   ```
   TUNNEL_TOKEN=o-token-do-túnel
   APP_ORIGIN=https://atendimento.seudominio.com.br
   ```
4. Feche a janela do servidor e rode `scripts\servidor.cmd` de novo.

## 7. Atualizar o sistema

```powershell
cd C:\Umbler2.0
npm run backup -- D:/TalkBackup
git pull
npm install
```

Depois, feche a janela do servidor e rode `scripts\servidor.cmd`. As telas são recompiladas toda vez que o servidor liga.

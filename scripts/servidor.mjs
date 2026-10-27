// Servidor do escritório num Windows, no mesmo arranjo do desenvolvimento (Postgres e Evolution no Docker, o app no Node):
// espera o Docker, sobe os containers, compila as telas, abre o túnel do Cloudflare e religa o que cair.
// Uso, na raiz do projeto: npm run servidor. Passo a passo e variáveis: docs/SERVIDOR-WINDOWS.md.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

process.loadEnvFile('.env.dev'); // não sobrescreve o que já veio do ambiente
const { TUNNEL_TOKEN, APP_ORIGIN, SERVIDOR_BACKUP_DIR, PORT = '3000', CLOUDFLARED = 'cloudflared' } = process.env;
const fixedOrigin = TUNNEL_TOKEN ? APP_ORIGIN : null; // sem túnel nomeado, o APP_ORIGIN do .env.dev é o do desenvolvimento

mkdirSync('data', { recursive: true });
function say(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync('data/servidor.log', `${line}\r\n`);
}
const run = (cmd, quiet = false) => spawnSync(cmd, { shell: true, stdio: quiet ? 'ignore' : 'inherit' }).status === 0;

// 1. O Docker Desktop leva um tempo para ligar depois que o Windows entra.
for (let i = 0; !run('docker info', true); i++) {
  if (i === 60) throw new Error('O Docker não ligou em 5 minutos. Abra o Docker Desktop e rode de novo.');
  await sleep(5000);
}
if (!run('npm run dev:up') || !run('npm run build')) throw new Error('Não deu para subir os containers ou compilar as telas.');

// 2. Túnel: nomeado (link fixo, TUNNEL_TOKEN lido do ambiente pelo cloudflared) ou temporário (link novo a cada início).
function openTunnel() {
  const args = TUNNEL_TOKEN ? ['tunnel', '--no-autoupdate', 'run'] : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];
  const child = spawn(CLOUDFLARED, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const origin = new Promise((ok, fail) => {
    if (fixedOrigin) ok(fixedOrigin);
    let seen = '';
    child.stderr.on('data', (d) => {
      seen = (seen + d).slice(-4000); // sempre lido, senão o cloudflared trava com a saída cheia
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(seen);
      if (m) ok(m[0]);
    });
    child.on('error', fail);
    child.on('exit', () => fail(new Error('O túnel fechou antes de dar o link.')));
  });
  const closed = new Promise((ok) => child.on('close', ok));
  return { child, origin, closed };
}

// 3. O app, com o link do túnel como origem. Só avisos e erros vão para o log (LOG_LEVEL), para ele não crescer sem fim.
function startApp(origin) {
  const env = { ...process.env, APP_ORIGIN: origin, COOKIE_SECURE: 'true', WEB_DIST_DIR: resolve('web/dist'), LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' };
  const child = spawn(process.execPath, ['--env-file=../.env.dev', '--import', 'tsx', 'src/index.ts'], { cwd: 'server', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = createWriteStream('data/app.log', { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  return { child, exited: new Promise((ok) => child.on('exit', ok)) };
}

// 4. Backup todo dia às 3h do escritório (Cuiabá, UTC-4 sem horário de verão: 7h UTC).
if (SERVIDOR_BACKUP_DIR) {
  void (async () => {
    for (;;) {
      const next = new Date();
      next.setUTCHours(7, 0, 0, 0);
      if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);
      await sleep(next.getTime() - Date.now());
      say(run(`npm run backup -- "${SERVIDOR_BACKUP_DIR}"`) ? 'backup ok' : 'BACKUP FALHOU: veja a janela do servidor');
    }
  })();
}

for (;;) {
  const tunnel = openTunnel();
  let origin;
  try {
    origin = await tunnel.origin;
  } catch (err) {
    say(`túnel: ${err.message} Tentando de novo em 10 s.`);
    tunnel.child.kill();
    await sleep(10_000);
    continue;
  }
  if (!fixedOrigin) writeFileSync('data/link.txt', `${origin}\r\n`);
  say(`no ar: ${origin}`);
  let app = startApp(origin);
  for (;;) {
    const what = await Promise.race([app.exited.then(() => 'app'), tunnel.closed.then(() => 'tunnel')]);
    if (what === 'tunnel') break;
    say('o app parou; religando em 5 s');
    await sleep(5000);
    app = startApp(origin);
  }
  // ponytail: com o túnel nomeado o link não muda e daria para manter o app; reiniciar tudo é mais simples e raro
  say('o túnel caiu; abrindo outro');
  app.child.kill();
  await app.exited;
  await sleep(5000);
}

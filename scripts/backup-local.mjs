// Backup da instalação local (docker-compose.dev.yml): os bancos talk + evolution, os arquivos e o .env.dev, numa
// pasta de OUTRO disco. O banco evolution tem o login do WhatsApp, mas as chaves de criptografia ficam no volume
// evolution_instances, fora do backup: num computador novo, leia o QR de novo.
// Uso, na raiz do projeto:  npm run backup -- E:\TalkBackup
// Restaurar ou mudar de computador: README.md › "Backup e mudança de computador".
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const KEEP_DUMPS = 7;
const MEDIA = 'data/dev-media'; // MEDIA_DIR do .env.dev, visto da raiz

const dest = process.argv[2];
if (!dest) {
  console.error('Uso: npm run backup -- <pasta de destino>');
  process.exit(1);
}
const dumps = join(dest, 'banco');
mkdirSync(dumps, { recursive: true });

// 1. Bancos. Grava em .tmp e só renomeia no fim: um dump com falha nunca apaga o último bom.
const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Cuiaba' }); // AAAA-MM-DD
const dump = join(dumps, `banco-${day}.sql`);
const pg = spawn('docker', ['exec', 'talk-dev-postgres-1', 'pg_dumpall', '-U', 'postgres', '--clean', '--if-exists'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const [[code]] = await Promise.all([once(pg, 'close'), pipeline(pg.stdout, createWriteStream(`${dump}.tmp`))]);
if (code !== 0) throw new Error(`pg_dumpall saiu com código ${code}; o backup anterior continua valendo`);
renameSync(`${dump}.tmp`, dump);
for (const old of readdirSync(dumps).filter((f) => /^banco-.*\.sql$/.test(f)).sort().slice(0, -KEEP_DUMPS)) {
  rmSync(join(dumps, old));
}

// 2. Arquivos: copia só o que é novo ou mudou (as fotos de perfil são regravadas no mesmo caminho). Nunca apaga.
function copyChanged(src, dst) {
  let n = 0;
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    if (e.isDirectory()) {
      n += copyChanged(from, to);
      continue;
    }
    const a = statSync(from);
    const b = existsSync(to) ? statSync(to) : null;
    if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue; // a cópia ganha a hora em que foi feita
    copyFileSync(from, to);
    n += 1;
  }
  return n;
}
const copied = copyChanged(MEDIA, join(dest, 'arquivos'));

// 3. Segredos: sem as mesmas senhas, o banco restaurado não abre. Trate a pasta de backup como o próprio .env.dev.
copyFileSync('.env.dev', join(dest, '.env.dev'));

console.log(`${new Date().toISOString()} backup ok: ${dump} (${Math.round(statSync(dump).size / 1e6)} MB), ${copied} arquivos novos`);

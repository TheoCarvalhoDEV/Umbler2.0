import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPgDb } from '../db/client.js';
import { importUmbler } from './umbler.js';

// One-off import at go-live, after the app has started once (migrations applied):
//   npm run import:umbler -w server -- --token <UMBLER_TOKEN> --dry-run   (simulate, prints the report)
//   npm run import:umbler -w server -- --token <UMBLER_TOKEN>             (imports, saves the report)
// Production (README §5): docker compose exec -T -e UMBLER_TOKEN app node --import tsx server/src/importer/cli.ts --dry-run, then without --dry-run
// UMBLER_TOKEN in the environment works too and keeps the token out of shell history and `ps`.
const USAGE = 'Uso: npm run import:umbler -w server -- --token <UMBLER_TOKEN> [--dry-run]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { token: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const token = values.token ?? process.env.UMBLER_TOKEN;
  if (!token) throw new Error(USAGE);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definido');
  const mediaDir = process.env.MEDIA_DIR ?? '/data/media';

  const report = await importUmbler({ db: createPgDb(url), mediaDir, token, dryRun: values['dry-run'] === true });
  const json = JSON.stringify(report, null, 2);
  console.log(json);

  if (report.dryRun) {
    console.error('Simulação: nada foi gravado.');
    return;
  }
  // data/import-report.json, next to data/media (/data/import-report.json in production).
  const file = join(dirname(mediaDir), 'import-report.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${json}\n`);
  console.error(`Relatório gravado em ${file}`);
}

main().then(
  () => process.exit(0), // postgres.js keeps the pool open; exit explicitly
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

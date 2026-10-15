import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { createPgDb, type Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { loadAuthUser, type AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict } from '../lib/http-error.js';
import { hashPassword } from './password.js';

export async function seedAdmin(db: Db, input: { email: string; name: string; password: string }): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!email.includes('@') || !name) throw badRequest('Informe --email e --name');
  if (input.password.length < 8) throw badRequest('A senha precisa de pelo menos 8 caracteres');

  const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (existing) throw conflict('Já existe um usuário com este e-mail');

  const id = randomUUID();
  await db.insert(users).values({
    id,
    name,
    email,
    passwordHash: await hashPassword(input.password),
    role: 'admin',
    signature: null,
    active: true,
  });
  const admin = await loadAuthUser(db, id);
  if (!admin) throw new Error('Administrador não encontrado após a criação');
  return admin;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definido');

  let password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    // ponytail: the prompt echoes the typed password; set SEED_ADMIN_PASSWORD to avoid that.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Senha do administrador (mín. 8 caracteres): ');
    rl.close();
  }

  const admin = await seedAdmin(createPgDb(url), { email: values.email ?? '', name: values.name ?? '', password });
  console.log(`Administrador criado: ${admin.email}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0), // postgres.js keeps the pool open; exit explicitly
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}

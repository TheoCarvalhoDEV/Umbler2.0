import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Role, SectorDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { Avatar } from '../../components/Avatar';
import { ErrorText, Loading, Section, btn, btnPrimary, field, send, useSend } from '../../components/settings/common';

interface UserInput {
  name: string;
  email: string;
  role: Role;
  signature: string;
  password: string;
  sectorIds: string[];
}

export function UsersSettings() {
  const me = useCurrentUser();
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const save = useSend(qk.users);
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);

  if (!users.data || !sectors.data) return <Loading error={users.error ?? sectors.error} />;
  const sectorList = [...sectors.data].sort((a, b) => a.position - b.position);
  const sectorName = new Map(sectorList.map((s) => [s.id, s.name]));
  const target = editing;

  function open(value: UserDto | 'new') {
    save.reset();
    setEditing(value);
  }

  function submit(v: UserInput) {
    const body = {
      name: v.name.trim(),
      email: v.email.trim().toLowerCase(),
      role: v.role,
      signature: v.signature.trim() || null,
      sectorIds: v.sectorIds,
      ...(v.password ? { password: v.password } : {}),
    };
    save.mutate(
      () => (target && target !== 'new' ? send(`/api/users/${target.id}`, 'PATCH', body) : send('/api/users', 'POST', body)),
      { onSuccess: () => setEditing(null) },
    );
  }

  function toggleActive(u: UserDto) {
    if (u.active && !window.confirm(`Desativar ${u.name}? A pessoa perde o acesso na hora.`)) return;
    save.mutate(() => send(`/api/users/${u.id}`, 'PATCH', { active: !u.active }));
  }

  return (
    <Section
      title="Atendentes"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
          Novo atendente
        </button>
      }
    >
      {target && (
        <UserForm
          key={target === 'new' ? 'new' : target.id}
          initial={target === 'new' ? undefined : target}
          sectors={sectorList}
          pending={save.isPending}
          error={save.error}
          onSubmit={submit}
          onCancel={() => setEditing(null)}
        />
      )}
      {!target && <ErrorText error={save.error} />}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 font-medium">Nome</th>
            <th className="py-2 font-medium">E-mail</th>
            <th className="py-2 font-medium">Papel</th>
            <th className="py-2 font-medium">Setores</th>
            <th className="py-2 font-medium">Situação</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.data.map((u) => (
            <tr key={u.id} className={`border-b border-border ${u.active ? '' : 'text-muted'}`}>
              <td className="py-2">
                <span className="flex items-center gap-2">
                  <Avatar name={u.name} src={u.avatarUrl} className="size-7 text-xs bg-primary text-white" />
                  {u.name}
                </span>
              </td>
              <td className="py-2">{u.email}</td>
              <td className="py-2">{u.role === 'admin' ? 'Administrador' : 'Atendente'}</td>
              <td className="py-2">{u.sectorIds.map((id) => sectorName.get(id)).filter(Boolean).join(', ') || '—'}</td>
              <td className="py-2">{u.active ? 'Ativo' : 'Desativado'}</td>
              <td className="space-x-2 py-2 text-right whitespace-nowrap">
                <button type="button" onClick={() => open(u)} className={btn}>
                  Editar
                </button>
                {u.id !== me.id && (
                  <button type="button" onClick={() => toggleActive(u)} disabled={save.isPending} className={btn}>
                    {u.active ? 'Desativar' : 'Reativar'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function UserForm({
  initial,
  sectors,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: UserDto;
  sectors: SectorDto[];
  pending: boolean;
  error: unknown;
  onSubmit(v: UserInput): void;
  onCancel(): void;
}) {
  const [v, setV] = useState<UserInput>({
    name: initial?.name ?? '',
    email: initial?.email ?? '',
    role: initial?.role ?? 'agent',
    signature: initial?.signature ?? '',
    password: '',
    sectorIds: initial?.sectorIds ?? [],
  });
  const set = (patch: Partial<UserInput>) => setV((cur) => ({ ...cur, ...patch }));
  const toggleSector = (id: string) =>
    set({ sectorIds: v.sectorIds.includes(id) ? v.sectorIds.filter((x) => x !== id) : [...v.sectorIds, id] });

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(v);
  }

  return (
    <form onSubmit={submit} className="mb-6 grid grid-cols-2 gap-4 rounded border border-border p-4">
      <label className="block text-sm font-medium">
        Nome
        <input required value={v.name} onChange={(e) => set({ name: e.target.value })} className={field} />
      </label>
      <label className="block text-sm font-medium">
        E-mail
        <input required type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} className={field} />
      </label>
      <label className="block text-sm font-medium">
        Papel
        <select value={v.role} onChange={(e) => set({ role: e.target.value as Role })} className={field}>
          <option value="agent">Atendente</option>
          <option value="admin">Administrador</option>
        </select>
      </label>
      <label className="block text-sm font-medium">
        {initial ? 'Nova senha (deixe em branco para manter)' : 'Senha'}
        <input
          type="password"
          autoComplete="new-password"
          required={!initial}
          minLength={8}
          value={v.password}
          onChange={(e) => set({ password: e.target.value })}
          className={field}
        />
      </label>
      <label className="col-span-2 block text-sm font-medium">
        Assinatura (opcional)
        <input value={v.signature} maxLength={60} onChange={(e) => set({ signature: e.target.value })} className={field} />
        <span className="mt-1 block text-xs font-normal text-muted">Se ficar vazia, as mensagens saem como “Setor - Nome”.</span>
      </label>
      <fieldset className="col-span-2">
        <legend className="text-sm font-medium">Setores</legend>
        <div className="mt-1 flex flex-wrap gap-4 text-sm">
          {sectors.map((s) => (
            <label key={s.id} className="flex items-center gap-1">
              <input type="checkbox" checked={v.sectorIds.includes(s.id)} onChange={() => toggleSector(s.id)} />
              {s.name}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">
          Administradores veem todas as conversas. Atendentes veem as dos seus setores e as que são deles.
        </p>
      </fieldset>
      <div className="col-span-2">
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={btn}>
            Cancelar
          </button>
          <button type="submit" disabled={pending} className={btnPrimary}>
            Salvar
          </button>
        </div>
      </div>
    </form>
  );
}

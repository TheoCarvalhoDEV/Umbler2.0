import { useState, type FormEvent } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { Role, SectorDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { Avatar } from '../../components/Avatar';
import { badge, badgeTone, button, checkbox, field, fieldLabel, fieldSelect } from '../../components/ui';
import { ErrorText, Loading, Section, block, btnDanger, btnPrimary, btnSecondary, hint, send, useSend } from '../../components/settings/common';
import { confirmDialog } from '../../lib/confirm';

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

  async function toggleActive(u: UserDto) {
    const body = 'A pessoa perde o acesso na hora.';
    if (u.active && !(await confirmDialog({ title: `Desativar ${u.name}?`, body, confirmLabel: 'Desativar', cancelLabel: 'Manter ativo' }))) return;
    save.mutate(() => send(`/api/users/${u.id}`, 'PATCH', { active: !u.active }));
  }

  return (
    <Section
      title="Atendentes"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
          <PlusIcon size={16} weight="bold" aria-hidden />
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

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs leading-4 text-muted">
              <th scope="col" className="h-10 px-3 font-semibold">Nome</th>
              <th scope="col" className="h-10 px-3 font-semibold">E-mail</th>
              <th scope="col" className="h-10 px-3 font-semibold">Papel</th>
              <th scope="col" className="h-10 px-3 font-semibold">Setores</th>
              <th scope="col" className="h-10 px-3 font-semibold">Situação</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id} className={`border-t border-border transition-colors hover:bg-sidebar-hover ${u.active ? '' : 'text-muted'}`}>
                <td className="h-[60px] px-3 py-1">
                  <span className="flex items-center gap-3">
                    <Avatar name={u.name} src={u.avatarUrl} className="size-9 text-[13px]" />
                    <span className="font-bold whitespace-nowrap">{u.name}</span>
                  </span>
                </td>
                <td className="px-3 py-1 text-[13px]">{u.email}</td>
                <td className="px-3 py-1 text-[13px] whitespace-nowrap">{u.role === 'admin' ? 'Administrador' : 'Atendente'}</td>
                <td className="px-3 py-1 text-[13px]">{u.sectorIds.map((id) => sectorName.get(id)).filter(Boolean).join(', ') || '—'}</td>
                <td className="px-3 py-1">
                  <span className={`${badge} ${u.active ? badgeTone.success : badgeTone.neutral}`}>{u.active ? 'Ativo' : 'Desativado'}</span>
                </td>
                <td className="px-3 py-1 text-right whitespace-nowrap">
                  <span className="inline-flex gap-2">
                    <button type="button" onClick={() => open(u)} className={btnSecondary}>
                      Editar
                    </button>
                    {u.id !== me.id && (
                      <button type="button" onClick={() => toggleActive(u)} disabled={save.isPending} className={u.active ? btnDanger : btnSecondary}>
                        {u.active ? 'Desativar' : 'Reativar'}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    <form onSubmit={submit} className={`${block} mb-5 grid grid-cols-2 gap-4`}>
      <label className="block">
        <span className={fieldLabel}>Nome</span>
        <input required value={v.name} onChange={(e) => set({ name: e.target.value })} className={field} />
      </label>
      <label className="block">
        <span className={fieldLabel}>E-mail</span>
        <input required type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} className={field} />
      </label>
      <label className="block">
        <span className={fieldLabel}>Papel</span>
        <select value={v.role} onChange={(e) => set({ role: e.target.value as Role })} className={fieldSelect}>
          <option value="agent">Atendente</option>
          <option value="admin">Administrador</option>
        </select>
      </label>
      <label className="block">
        <span className={fieldLabel}>{initial ? 'Nova senha (deixe em branco para manter)' : 'Senha'}</span>
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
      <label className="col-span-2 block">
        <span className={fieldLabel}>Assinatura (opcional)</span>
        <input value={v.signature} maxLength={60} onChange={(e) => set({ signature: e.target.value })} className={field} />
        <span className={hint}>Se ficar vazia, as mensagens saem como “Setor - Nome”.</span>
      </label>
      <fieldset className="col-span-2">
        <legend className="mb-2 text-[13px] leading-[18px] font-semibold">Setores</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2.5 text-sm">
          {sectors.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={v.sectorIds.includes(s.id)} onChange={() => toggleSector(s.id)} className={checkbox} />
              {s.name}
            </label>
          ))}
        </div>
        <p className={hint}>
          Administradores veem todas as conversas. Atendentes veem as dos seus setores e as que são deles.
        </p>
      </fieldset>
      <div className="col-span-2">
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={button('ghost')}>
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

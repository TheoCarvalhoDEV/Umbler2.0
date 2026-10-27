import { useState, type FormEvent } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { Role, SectorDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/conversation/ChatDialogs';
import { badge, badgeTone, checkbox, field, fieldLabel, fieldSelect } from '../../components/ui';
import { ErrorText, ListRow, Loading, PageHeader, RowMenu, btnPrimary, btnSecondary, hint, send, useSend } from '../../components/settings/common';
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

  async function remove(u: UserDto) {
    const ok = await confirmDialog({
      title: `Excluir ${u.name}?`,
      body: 'A pessoa sai da lista e não entra mais no sistema. As conversas abertas dela voltam para a fila do setor. O nome continua nas mensagens, notas e compromissos que ela fez. Não dá para desfazer.',
      confirmLabel: 'Excluir atendente',
      cancelLabel: 'Manter',
    });
    if (ok) save.mutate(() => send(`/api/users/${u.id}`, 'DELETE'));
  }

  // no empty state: the admin looking at it is always on the list
  return (
    <>
      <PageHeader
        title="Atendentes"
        description="Quem atende pelo sistema, com o papel e os setores de cada pessoa."
        action={
          <button type="button" onClick={() => open('new')} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Novo atendente
          </button>
        }
      />
      {target && (
        <Modal title={target === 'new' ? 'Novo atendente' : 'Editar atendente'} onCancel={() => setEditing(null)}>
          <UserForm
            key={target === 'new' ? 'new' : target.id}
            initial={target === 'new' ? undefined : target}
            sectors={sectorList}
            pending={save.isPending}
            error={save.error}
            onSubmit={submit}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {!target && <ErrorText error={save.error} />}

      <ul className="mt-5">
        {users.data.filter((u) => !u.deleted).map((u) => {
          const sectorsText = u.sectorIds.map((id) => sectorName.get(id)).filter(Boolean).join(', ');
          return (
            <ListRow
              key={u.id}
              leading={<Avatar name={u.name} src={u.avatarUrl} className="size-10 text-sm" />}
              title={u.name}
              subtitle={sectorsText ? `${u.email} · ${sectorsText}` : u.email}
              badges={
                <>
                  <span className={`${badge} ${u.role === 'admin' ? badgeTone.accent : badgeTone.neutral}`}>
                    {u.role === 'admin' ? 'Administrador' : 'Atendente'}
                  </span>
                  {!u.active && <span className={`${badge} ${badgeTone.warning}`}>Inativo</span>}
                </>
              }
              actions={
                <RowMenu
                  label={`Opções do atendente ${u.name}`}
                  items={[
                    { label: 'Editar', onSelect: () => open(u) },
                    u.id !== me.id && {
                      label: u.active ? 'Desativar' : 'Reativar',
                      onSelect: () => void toggleActive(u),
                      danger: u.active,
                      disabled: save.isPending,
                    },
                    u.id !== me.id && { label: 'Excluir', onSelect: () => void remove(u), danger: true, disabled: save.isPending },
                  ]}
                />
              }
            />
          );
        })}
      </ul>
    </>
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

  // one column: the dialog is narrow
  return (
    <form onSubmit={submit} className="space-y-4">
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
      <label className="block">
        <span className={fieldLabel}>Assinatura (opcional)</span>
        <input value={v.signature} maxLength={60} onChange={(e) => set({ signature: e.target.value })} className={field} />
        <span className={hint}>Se ficar vazia, as mensagens saem como “Setor - Nome”.</span>
      </label>
      <fieldset>
        <legend className={fieldLabel}>Setores</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2.5 text-sm">
          {sectors.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={v.sectorIds.includes(s.id)} onChange={() => toggleSector(s.id)} className={checkbox} />
              {s.name}
            </label>
          ))}
        </div>
        <p className={hint}>Administradores veem todas as conversas. Atendentes veem as dos seus setores e as que são deles.</p>
      </fieldset>
      <ErrorText error={error} />
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className={btnSecondary}>
          Cancelar
        </button>
        <button type="submit" disabled={pending} className={btnPrimary}>
          Salvar
        </button>
      </div>
    </form>
  );
}

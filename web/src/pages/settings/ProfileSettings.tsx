import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { Avatar } from '../../components/Avatar';
import { ErrorText, Section, btn, btnPrimary, field, send, useSend } from '../../components/settings/common';

export function ProfileSettings() {
  const me = useCurrentUser();
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const sectorNames =
    (sectors.data ?? [])
      .filter((s) => me.sectorIds.includes(s.id))
      .map((s) => s.name)
      .join(', ') || '—';

  return (
    <Section title="Perfil">
      <PhotoEditor me={me} />
      <dl className="mb-6 grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
        <dt className="text-muted">E-mail</dt>
        <dd>{me.email}</dd>
        <dt className="text-muted">Papel</dt>
        <dd>{me.role === 'admin' ? 'Administrador' : 'Atendente'}</dd>
        <dt className="text-muted">Setores</dt>
        <dd>{sectorNames}</dd>
        {me.role !== 'admin' && (
          <>
            <dt className="text-muted">Nome</dt>
            <dd>{me.name}</dd>
            <dt className="text-muted">Assinatura</dt>
            <dd>{me.signature || `Setor da conversa - ${me.name}`}</dd>
          </>
        )}
      </dl>
      {me.role === 'admin' ? (
        <ProfileForm me={me} />
      ) : (
        // ponytail: no self-service route in the REST contract; agents ask an admin (known limitation)
        <p className="text-sm text-muted">Para alterar nome, assinatura ou senha, peça a um administrador.</p>
      )}
    </Section>
  );
}

/** Own picture: upload (JPEG/PNG/WebP up to 2 MB, checked by the server) or remove. */
function PhotoEditor({ me }: { me: Me }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (file: File | null) => (file ? api.auth.setAvatar(file) : api.auth.removeAvatar()),
    onSuccess: (next) => {
      qc.setQueryData(qk.me, next);
      // the users list and the timeline's authorAvatarUrl carry the old URL
      void qc.invalidateQueries({ queryKey: qk.users });
      void qc.invalidateQueries({ queryKey: qk.chats });
    },
  });

  return (
    <div className="mb-6 flex items-center gap-4">
      <Avatar name={me.name} src={me.avatarUrl} className="size-16 text-xl" />
      <label className={`${btn} cursor-pointer has-[:disabled]:opacity-50`}>
        Trocar foto
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={save.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // picking the same file again still fires change
            if (file) save.mutate(file);
          }}
          className="sr-only"
        />
      </label>
      {me.avatarUrl && (
        <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending} className={btn}>
          Remover foto
        </button>
      )}
      <ErrorText error={save.error} />
    </div>
  );
}

function ProfileForm({ me }: { me: Me }) {
  const save = useSend(qk.users, qk.me);
  const [name, setName] = useState(me.name);
  const [signature, setSignature] = useState(me.signature ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = password !== confirm;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch || !name.trim()) return;
    const body = { name: name.trim(), signature: signature.trim() || null, ...(password ? { password } : {}) };
    save.mutate(() => send(`/api/users/${me.id}`, 'PATCH', body), {
      // a new password ends every session of the user (§6), this one included
      onSuccess: () => {
        if (password) window.location.assign('/login');
      },
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm font-medium">
        Nome
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <label className="block text-sm font-medium">
        Assinatura
        <input value={signature} maxLength={60} onChange={(e) => setSignature(e.target.value)} className={field} />
        <span className="mt-1 block text-xs font-normal text-muted">
          Prévia no WhatsApp: <b>*{signature.trim() || `Setor da conversa - ${name.trim()}`}:*</b>. Se ficar vazia, usa “Setor - Nome”.
        </span>
      </label>
      <fieldset className="space-y-2 rounded border border-border p-3">
        <legend className="px-1 text-sm font-medium">Trocar senha (opcional)</legend>
        <label className="block text-sm">
          Nova senha
          <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          Repita a nova senha
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
        </label>
        {password && mismatch && <p className="text-sm text-danger">As senhas não conferem.</p>}
        <p className="text-xs text-muted">Ao trocar a senha, você sai de todos os aparelhos e entra de novo.</p>
      </fieldset>
      <ErrorText error={save.error} />
      {save.isSuccess && !password && <p className="text-sm text-success">Perfil salvo.</p>}
      <button type="submit" disabled={save.isPending || mismatch || !name.trim()} className={btnPrimary}>
        Salvar
      </button>
    </form>
  );
}

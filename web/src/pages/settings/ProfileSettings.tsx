import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { Avatar } from '../../components/Avatar';
import { blockTitle, field, fieldLabel } from '../../components/ui';
import { ErrorText, Section, block, btnPrimary, btnSecondary, hint, okText, send, useSend } from '../../components/settings/common';

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
      <dl className={`${block} mb-5 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2.5 text-sm`}>
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
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <Avatar name={me.name} src={me.avatarUrl} className="size-16 text-xl" />
      <label className={`${btnSecondary} cursor-pointer has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary`}>
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
        <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending} className={btnSecondary}>
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
    <form onSubmit={submit} className="space-y-5">
      <label className="block">
        <span className={fieldLabel}>Nome</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <label className="block">
        <span className={fieldLabel}>Assinatura</span>
        <input value={signature} maxLength={60} onChange={(e) => setSignature(e.target.value)} className={field} />
        <span className={hint}>
          Prévia no WhatsApp: <b className="font-bold text-fg-2">*{signature.trim() || `Setor da conversa - ${name.trim()}`}:*</b>. Se ficar vazia, usa “Setor - Nome”.
        </span>
      </label>
      <fieldset className={block}>
        <legend className={`${blockTitle} float-left mb-4 w-full`}>Trocar senha (opcional)</legend>
        <div className="clear-both space-y-4">
          <label className="block">
            <span className={fieldLabel}>Nova senha</span>
            <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Repita a nova senha</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
          </label>
          {password && mismatch && <p className="text-[13px] font-semibold text-danger">As senhas não conferem.</p>}
          <p className="text-[13px] leading-[18px] text-muted">Ao trocar a senha, você sai de todos os aparelhos e entra de novo.</p>
        </div>
      </fieldset>
      <ErrorText error={save.error} />
      {save.isSuccess && !password && <p className={okText}>Perfil salvo.</p>}
      <button type="submit" disabled={save.isPending || mismatch || !name.trim()} className={btnPrimary}>
        Salvar
      </button>
    </form>
  );
}

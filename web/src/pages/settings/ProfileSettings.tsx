import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraIcon } from '@phosphor-icons/react';
import type { Me } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { Avatar } from '../../components/Avatar';
import { badge, badgeTone, button, fieldLabel } from '../../components/ui';
import { ErrorText, PageHeader, SaveBar, SettingRow, SettingsSection, field, hint, send, useSend } from '../../components/settings/common';

export function ProfileSettings() {
  const me = useCurrentUser();
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const sectorNames = (sectors.data ?? []).filter((s) => me.sectorIds.includes(s.id)).map((s) => s.name);

  return (
    <>
      <PageHeader title="Perfil" description="Sua foto, seu nome e como você assina as mensagens." />
      <Identity me={me} sectorNames={sectorNames} />
      {me.role === 'admin' ? (
        <ProfileForm me={me} />
      ) : (
        // ponytail: no self-service route in the REST contract; agents ask an admin (known limitation)
        <SettingsSection title="Seus dados" description="Para alterar nome, assinatura ou senha, peça a um administrador.">
          <SignaturePreview label={me.signature || `Setor da conversa - ${me.name}`} />
        </SettingsSection>
      )}
    </>
  );
}

/** Picture (upload JPEG/PNG/WebP up to 2 MB, checked by the server, or remove), name, e-mail, role and sectors. */
function Identity({ me, sectorNames }: { me: Me; sectorNames: string[] }) {
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
    <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
      <div className="flex flex-col items-center gap-1.5">
        <div className="relative">
          <Avatar name={me.name} src={me.avatarUrl} className="size-20 text-2xl" />
          <label
            title="Trocar foto"
            className="absolute -right-1 -bottom-1 grid size-8 cursor-pointer place-items-center rounded-full bg-primary text-on-primary ring-[3px] ring-surface transition-colors hover:bg-primary-hover has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary"
          >
            <CameraIcon size={18} aria-hidden />
            <input
              type="file"
              aria-label="Trocar foto"
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
        </div>
        {me.avatarUrl && (
          <button
            type="button"
            onClick={() => save.mutate(null)}
            disabled={save.isPending}
            className="rounded-full px-2 text-xs font-bold text-danger hover:underline disabled:opacity-50"
          >
            Remover foto
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-lg font-bold">{me.name}</p>
        <p className="truncate text-sm text-muted">{me.email}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className={`${badge} ${badgeTone.accent}`}>{me.role === 'admin' ? 'Administrador' : 'Atendente'}</span>
          {sectorNames.map((name) => (
            <span key={name} className={`${badge} ${badgeTone.neutral}`}>
              {name}
            </span>
          ))}
        </div>
      </div>
      <ErrorText error={save.error} className="basis-full" />
    </div>
  );
}

/** The signature as WhatsApp shows it: "*label:*" (bold) on top of the message, in a sent bubble. */
function SignaturePreview({ label }: { label: string }) {
  return (
    <div className="mt-4">
      <p className={fieldLabel}>Como o cliente vê</p>
      <div className="w-fit max-w-full rounded-card rounded-br-md bg-bubble-out px-3.5 py-2.5 text-sm text-fg sm:max-w-[360px]">
        <p className="font-bold break-words">{label}:</p>
        <p>Olá! Tudo bem?</p>
        <p className="mt-1 text-right text-[11px] leading-[14px] text-bubble-meta tabular-nums">10:30</p>
      </div>
    </div>
  );
}

function ProfileForm({ me }: { me: Me }) {
  const save = useSend(qk.users, qk.me);
  const [name, setName] = useState(me.name);
  const [signature, setSignature] = useState(me.signature ?? '');
  const [changingPassword, setChangingPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = password !== confirm;
  const dirty = name.trim() !== me.name || signature.trim() !== (me.signature ?? '') || !!password || !!confirm;

  function closePassword() {
    setChangingPassword(false);
    setPassword('');
    setConfirm('');
  }

  function discard() {
    setName(me.name);
    setSignature(me.signature ?? '');
    closePassword();
    save.reset();
  }

  function submit() {
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <SettingsSection title="Seus dados">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block max-w-[360px]">
            <span className={fieldLabel}>Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <div className="max-w-[360px]">
            <label className="block">
              <span className={fieldLabel}>Assinatura</span>
              <input value={signature} maxLength={60} onChange={(e) => setSignature(e.target.value)} className={field} />
            </label>
            <p className={hint}>Se ficar vazia, usa “Setor - Nome”.</p>
          </div>
        </div>
        <SignaturePreview label={signature.trim() || `Setor da conversa - ${name.trim()}`} />
      </SettingsSection>
      <SettingsSection title="Senha">
        <SettingRow
          label="Senha"
          description="Pelo menos 8 caracteres."
          control={
            <button
              type="button"
              aria-expanded={changingPassword}
              onClick={changingPassword ? closePassword : () => setChangingPassword(true)}
              className={button(changingPassword ? 'ghost' : 'secondary')}
            >
              {changingPassword ? 'Cancelar' : 'Trocar senha'}
            </button>
          }
        />
        {changingPassword && (
          <div className="grid gap-4 pt-2 sm:grid-cols-2">
            <label className="block max-w-[360px]">
              <span className={fieldLabel}>Nova senha</span>
              <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
            </label>
            <label className="block max-w-[360px]">
              <span className={fieldLabel}>Repita a nova senha</span>
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
            </label>
            {password && mismatch && <p className="text-[13px] font-semibold text-danger sm:col-span-2">As senhas não conferem.</p>}
            <p className="text-[13px] leading-[18px] text-muted sm:col-span-2">Ao trocar a senha, você sai de todos os aparelhos e entra de novo.</p>
          </div>
        )}
      </SettingsSection>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        onDiscard={discard}
        error={save.error}
        saved={save.isSuccess}
        disabled={mismatch || !name.trim()}
      />
    </form>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, type BrowserNotificationMode, type Me, type UserPreferences } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { usePreferences } from '../../lib/auth';
import { NotificationPermissionButton } from '../../lib/notify';
import { ErrorText, Section } from '../../components/settings/common';

const MODES: Array<{ value: BrowserNotificationMode; label: string }> = [
  { value: 'always', label: 'Sempre' },
  { value: 'background', label: 'Só quando a aba está em segundo plano' },
  { value: 'never', label: 'Nunca' },
];

function Toggle(props: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-0.5 size-4 accent-primary"
      />
      <span>
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="block text-xs text-muted">{props.hint}</span>
      </span>
    </label>
  );
}

/** Spec 2026-10-19 §6: every user's own choices. Each change saves at once, only the field that changed. */
export function PreferencesSettings() {
  const qc = useQueryClient();
  const prefs = usePreferences();
  const save = useMutation({
    mutationFn: (patch: Partial<UserPreferences>) => api.auth.setPreferences(patch),
    // optimistic: the control flips now; the answer (or a refetch after an error) settles it
    onMutate: (patch) =>
      qc.setQueryData<Me | null>(qk.me, (me) => me && { ...me, preferences: { ...DEFAULT_PREFERENCES, ...me.preferences, ...patch } }),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
    onError: () => void qc.invalidateQueries({ queryKey: qk.me }),
  });

  return (
    <Section title="Preferências">
      <div className="space-y-6">
        <Toggle
          label="Enter envia a mensagem"
          hint="Desligado: Enter quebra a linha e Ctrl+Enter envia."
          checked={prefs.enterSends}
          onChange={(enterSends) => save.mutate({ enterSends })}
        />
        <Toggle
          label="Sons"
          hint="Um bipe quando chega mensagem de um contato, menos na conversa que você está vendo."
          checked={prefs.sounds}
          onChange={(sounds) => save.mutate({ sounds })}
        />
        <fieldset>
          <legend className="text-sm font-medium">Notificações do navegador</legend>
          <div className="mt-2 space-y-1.5">
            {MODES.map((m) => (
              <label key={m.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="browser-notifications"
                  value={m.value}
                  checked={prefs.browserNotifications === m.value}
                  onChange={() => save.mutate({ browserNotifications: m.value })}
                  className="accent-primary"
                />
                {m.label}
              </label>
            ))}
          </div>
          <div className="-mx-3 mt-2">
            <NotificationPermissionButton />
          </div>
        </fieldset>
        <ErrorText error={save.error} />
      </div>
    </Section>
  );
}

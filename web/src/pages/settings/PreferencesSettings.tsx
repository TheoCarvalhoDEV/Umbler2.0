import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PREFERENCES, SOUNDS, type BrowserNotificationMode, type Me, type NotificationSound, type UserPreferences,
} from '@talk/shared';
import { api, qk } from '../../lib/api';
import { usePreferences } from '../../lib/auth';
import { NotificationPermissionButton } from '../../lib/notify';
import { playSound } from '../../lib/sounds';
import { btnSecondary, ErrorText, PageHeader, SettingRow, SettingsSection, Switch } from '../../components/settings/common';
import { fieldSelect, radio } from '../../components/ui';

const MODES: Array<{ value: BrowserNotificationMode; label: string }> = [
  { value: 'always', label: 'Sempre' },
  { value: 'background', label: 'Só quando a aba está em segundo plano' },
  { value: 'never', label: 'Nunca' },
];

/** Spec 2026-10-19 §6: every user's own choices. Each change saves at once, only the field that changed. */
export function PreferencesSettings() {
  const qc = useQueryClient();
  const prefs = usePreferences();
  const sound = prefs.sound ?? 'soft';
  const save = useMutation({
    mutationFn: (patch: Partial<UserPreferences>) => api.auth.setPreferences(patch),
    // optimistic: the control flips now; the answer (or a refetch after an error) settles it
    onMutate: (patch) =>
      qc.setQueryData<Me | null>(qk.me, (me) => me && { ...me, preferences: { ...DEFAULT_PREFERENCES, ...me.preferences, ...patch } }),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
    onError: () => void qc.invalidateQueries({ queryKey: qk.me }),
  });

  return (
    <>
      <PageHeader title="Preferências" description="Escolhas só suas. Cada mudança vale na hora." />
      <SettingsSection title="Escrita">
        <SettingRow
          label="Enter envia a mensagem"
          description="Desligado: Enter quebra a linha e Ctrl+Enter envia."
          control={<Switch label="Enter envia a mensagem" checked={prefs.enterSends} onChange={(enterSends) => save.mutate({ enterSends })} />}
        />
      </SettingsSection>
      <SettingsSection title="Avisos">
        <SettingRow
          label="Sons"
          description="Um som quando chega mensagem de um contato, menos na conversa que você está vendo."
          control={<Switch label="Sons" checked={prefs.sounds} onChange={(sounds) => save.mutate({ sounds })} />}
        />
        <SettingRow
          label="Som da notificação"
          htmlFor="notification-sound"
          control={
            <div className="flex items-center gap-2">
              <select
                id="notification-sound"
                value={sound}
                disabled={!prefs.sounds}
                onChange={(e) => save.mutate({ sound: e.target.value as NotificationSound })}
                className={`${fieldSelect} w-36`}
              >
                {SOUNDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!prefs.sounds} onClick={() => playSound(sound)} className={btnSecondary}>
                Ouvir
              </button>
            </div>
          }
        />
        <SettingRow
          label="Notificações do navegador"
          description="Quando o navegador mostra um aviso de mensagem nova."
          wide
          control={
            <>
              <div role="radiogroup" aria-label="Notificações do navegador" className="flex flex-col gap-2.5">
                {MODES.map((m) => (
                  <label key={m.value} className="flex cursor-pointer items-center gap-3 text-sm">
                    <input
                      type="radio"
                      name="browser-notifications"
                      value={m.value}
                      checked={prefs.browserNotifications === m.value}
                      onChange={() => save.mutate({ browserNotifications: m.value })}
                      className={radio}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
              <div className="-mx-3 mt-2">
                <NotificationPermissionButton />
              </div>
            </>
          }
        />
      </SettingsSection>
      <ErrorText error={save.error} />
    </>
  );
}

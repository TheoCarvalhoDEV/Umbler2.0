import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { remindersProblem, type AppointmentRemindersDto } from '@talk/shared';
import { ReminderRows, type ReminderSample } from '../../components/conversation/Appointments';
import { api, qk } from '../../lib/api';
import { Loading, PageHeader, SaveBar, SettingsSection, useSend } from '../../components/settings/common';

// ponytail: a fixed example for "Vai sair assim" (10/11/2026 14:00 in Cuiabá); there is no appointment on this page
const SAMPLE: ReminderSample = { nome: 'Maria', titulo: 'Audiência', startsAt: '2026-11-10T18:00:00.000Z' };

export function AppointmentSettings() {
  const saved = useQuery({ queryKey: qk.appointmentReminders, queryFn: api.settings.appointmentReminders.get });
  if (!saved.data) return <Loading error={saved.error} />;
  return <AppointmentRemindersForm saved={saved.data} />;
}

/** Spec 2026-10-21 compromissos §4: the reminders every new appointment starts with; the server checks the same rules. */
function AppointmentRemindersForm({ saved }: { saved: AppointmentRemindersDto }) {
  const [reminders, setReminders] = useState(saved.reminders);
  const save = useSend(qk.appointmentReminders);
  const dirty = JSON.stringify(reminders) !== JSON.stringify(saved.reminders);
  const problem = remindersProblem(reminders, null); // no contact here: {nome} is fine

  function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    // keep the server's answer (trimmed texts), or the form would stay "unsaved"
    save.mutate(async () => setReminders((await api.settings.appointmentReminders.put({ reminders })).reminders));
  }

  function discard() {
    setReminders(saved.reminders);
    save.reset();
  }

  return (
    <>
      <PageHeader
        title="Compromissos"
        description="Lembretes que já vêm preenchidos em todo compromisso novo. Cada compromisso pode mudar os seus."
      />
      <form onSubmit={submit}>
        <SettingsSection title="Lembretes">
          <ReminderRows reminders={reminders} onChange={setReminders} sample={SAMPLE} />
        </SettingsSection>
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onDiscard={discard}
          error={save.error ?? (problem ? new Error(problem) : null)}
          saved={save.isSuccess}
          disabled={!!problem}
          savedText="Lembretes salvos."
        />
      </form>
    </>
  );
}

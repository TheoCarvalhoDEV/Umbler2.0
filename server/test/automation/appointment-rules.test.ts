// Review Focus 2: "N dias antes" must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPOINTMENT_REMINDERS, SCHEDULE_MAX_AHEAD_MS, appointmentTimeProblem, fillReminderText, reminderSendAt,
  reminderTextProblem, remindersProblem,
} from '@talk/shared';

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe('reminderSendAt (spec 2026-10-21 compromissos §3.2, decision 7)', () => {
  it('"N dias antes" keeps the Cuiabá wall time, across a month and a year (Review Focus 2)', () => {
    // 25/10/2026 14:00 Cuiabá − 2 days = 23/10/2026 14:00 Cuiabá (the spec's example)
    expect(iso(reminderSendAt(at('2026-10-25T18:00:00.000Z'), 2, 'days'))).toBe('2026-10-23T18:00:00.000Z');
    // month: 01/11/2026 08:30 − 1 day = 31/10/2026 08:30
    expect(iso(reminderSendAt(at('2026-11-01T12:30:00.000Z'), 1, 'days'))).toBe('2026-10-31T12:30:00.000Z');
    // year: 01/01/2027 10:00 − 2 days = 30/12/2026 10:00
    expect(iso(reminderSendAt(at('2027-01-01T14:00:00.000Z'), 2, 'days'))).toBe('2026-12-30T14:00:00.000Z');
    // the Cuiabá date, not the UTC one: 31/12/2026 23:30 Cuiabá is already 01/01 in UTC (and in Tokyo)
    expect(iso(reminderSendAt(at('2027-01-01T03:30:00.000Z'), 1, 'days'))).toBe('2026-12-31T03:30:00.000Z');
    // 30 days back across February (28 days in 2027): 02/03/2027 09:00 → 31/01/2027 09:00
    expect(iso(reminderSendAt(at('2027-03-02T13:00:00.000Z'), 30, 'days'))).toBe('2027-01-31T13:00:00.000Z');
  });

  it('"N horas antes" takes exactly N × 60 minutes', () => {
    expect(iso(reminderSendAt(at('2026-10-25T18:00:00.000Z'), 1, 'hours'))).toBe('2026-10-25T17:00:00.000Z');
    expect(iso(reminderSendAt(at('2026-10-25T18:00:00.000Z'), 48, 'hours'))).toBe('2026-10-23T18:00:00.000Z');
  });
});

describe('appointment rules shared by the web and the server (spec §3.1–3.2)', () => {
  it('appointmentTimeProblem: empty, now, the past and past 1 year', () => {
    const now = at('2026-10-20T12:00:00.000Z');
    expect(appointmentTimeProblem(null, now)).toBe('Escolha a data e a hora');
    expect(appointmentTimeProblem(at('nope'), now)).toBe('Escolha a data e a hora');
    expect(appointmentTimeProblem(now, now)).toBe('Este horário já passou; escolha uma data e hora futuras');
    expect(appointmentTimeProblem(at('2026-10-20T11:59:00.000Z'), now)).toBe('Este horário já passou; escolha uma data e hora futuras');
    expect(appointmentTimeProblem(at('2026-10-20T12:01:00.000Z'), now)).toBeNull();
    expect(appointmentTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS), now)).toBeNull();
    expect(appointmentTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS + 60_000), now)).toBe('Escolha um horário em até 1 ano');
  });

  it('fillReminderText: {data} and {hora} in Cuiabá time with the host in Tokyo, and nothing read as a pattern', () => {
    // 20/10/2026 13:30 in Cuiabá is already 21/10 02:30 in Tokyo
    const startsAt = '2026-10-20T17:30:00.000Z';
    expect(fillReminderText(DEFAULT_APPOINTMENT_REMINDERS.reminders[1]!.text, { nome: 'Maria', titulo: 'Audiência', startsAt })).toBe(
      'Olá, Maria! Seu compromisso (Audiência) é às 13:30 de 20/10/2026 (horário de Cuiabá).',
    );
    expect(fillReminderText('{nome} {nome} $& {titulo}', { nome: 'Ana', titulo: 'R$ 10', startsAt })).toBe('Ana Ana $& R$ 10');
  });

  it('reminderTextProblem and remindersProblem (decision 6)', () => {
    expect(reminderTextProblem('Olá, {nome}! {titulo} em {data} às {hora}', 'Maria')).toBeNull();
    expect(reminderTextProblem('Olá, {Nome}!')).toBe('Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}');
    expect(reminderTextProblem('Olá, {nome}!', null)).toBe('O contato não tem nome cadastrado; tire {nome} do lembrete');
    expect(reminderTextProblem('Olá, {nome}!', '  ')).toBe('O contato não tem nome cadastrado; tire {nome} do lembrete');
    expect(reminderTextProblem('Olá, {nome}!')).toBeNull(); // Configurações: no contact
    expect(reminderTextProblem('Olá!', null)).toBeNull();

    const startsAt = at('2026-10-25T18:00:00.000Z');
    const r = (amount: number, unit: 'days' | 'hours', text = 'Lembrete') => ({ amount, unit, text });
    expect(remindersProblem([], startsAt, 'Maria')).toBe('Inclua pelo menos um lembrete');
    expect(remindersProblem([r(1, 'days', '  ')], startsAt, 'Maria')).toBe('Digite o texto do lembrete');
    expect(remindersProblem([r(2, 'days'), r(48, 'hours')], startsAt, 'Maria')).toBe('Dois lembretes cairiam no mesmo horário');
    expect(remindersProblem([r(2, 'days'), r(48, 'hours')], null)).toBe('Dois lembretes cairiam no mesmo horário');
    expect(remindersProblem(DEFAULT_APPOINTMENT_REMINDERS.reminders, startsAt, 'Maria')).toBeNull();
    expect(remindersProblem(DEFAULT_APPOINTMENT_REMINDERS.reminders, startsAt, null)).toBe(
      'O contato não tem nome cadastrado; tire {nome} do lembrete',
    );
  });
});

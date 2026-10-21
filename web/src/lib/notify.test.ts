import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, type ChatDetail, type ContactRef, type UserPreferences } from '@talk/shared';
import { api, qk } from './api';
import { browserNotificationAllowed, chatContact, messageAlerts, messageNotification } from './notify';

const p = (over: Partial<UserPreferences> = {}): UserPreferences => ({ ...DEFAULT_PREFERENCES, ...over });

describe('message alerts (spec 2026-10-19 §6)', () => {
  it('stays quiet for the chat being read in a visible tab (Review Focus 7)', () => {
    expect(messageAlerts(p({ browserNotifications: 'always' }), { hidden: false, chatOnScreen: true })).toEqual({
      sound: false, browser: false,
    });
  });

  it('beeps for another chat or a hidden tab while Sons is on, never with it off', () => {
    expect(messageAlerts(p(), { hidden: false, chatOnScreen: false }).sound).toBe(true);
    expect(messageAlerts(p(), { hidden: true, chatOnScreen: true }).sound).toBe(true);
    expect(messageAlerts(p({ sounds: false }), { hidden: true, chatOnScreen: false }).sound).toBe(false);
  });

  it('follows Sempre, Só quando a aba está em segundo plano and Nunca', () => {
    expect(messageAlerts(p({ browserNotifications: 'always' }), { hidden: false, chatOnScreen: false }).browser).toBe(true);
    expect(messageAlerts(p(), { hidden: false, chatOnScreen: false }).browser).toBe(false);
    expect(messageAlerts(p(), { hidden: true, chatOnScreen: true }).browser).toBe(true);
    expect(messageAlerts(p({ browserNotifications: 'never' }), { hidden: true, chatOnScreen: false }).browser).toBe(false);
    expect(browserNotificationAllowed('background', true)).toBe(true);
    expect(browserNotificationAllowed('never', true)).toBe(false);
  });
});

const maria: ContactRef = { id: 'k1', name: 'Maria Souza', phone: '5565999990001', avatarUrl: '/api/contacts/k1/avatar?v=1' };

describe('message notification content', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the contact name as the title, the message as the body and the photo as the icon', () => {
    expect(messageNotification(maria, { body: 'Qual horário', kind: 'text' }, 'http://localhost:5173')).toEqual({
      title: 'Maria Souza', body: 'Qual horário', icon: 'http://localhost:5173/api/contacts/k1/avatar?v=1',
    });
  });

  it('falls back to the phone, a media label, no icon, and "Nova mensagem" when the contact is unknown', () => {
    const noName = { ...maria, name: null, avatarUrl: null };
    const n = messageNotification(noName, { body: null, kind: 'audio' }, 'http://x');
    expect(n.title).not.toBe('Nova mensagem');
    expect(n.title).toMatch(/99999/);
    expect(n.body).not.toBe('');
    expect(n.icon).toBeUndefined();
    expect(messageNotification(null, { body: 'oi', kind: 'text' }, 'http://x')).toEqual({ title: 'Nova mensagem', body: 'oi' });
  });

  it('finds the contact in the chat cache, then in a loaded list page, else asks the server', async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.chat('c1'), { id: 'c1', contact: maria } as unknown as ChatDetail);
    expect(await chatContact(qc, 'c1')).toEqual(maria);

    qc.setQueryData([...qk.chatLists, { tab: 'inbox' }], { pages: [{ items: [{ id: 'c2', contact: { ...maria, id: 'k2' } }] }], pageParams: [null] });
    expect((await chatContact(qc, 'c2'))?.id).toBe('k2');

    const get = vi.spyOn(api.chats, 'get').mockResolvedValue({ id: 'c3', contact: { ...maria, id: 'k3' } } as unknown as ChatDetail);
    expect((await chatContact(qc, 'c3'))?.id).toBe('k3');
    expect(get).toHaveBeenCalledWith('c3');

    get.mockRejectedValue(new Error('404'));
    expect(await chatContact(qc, 'c4')).toBeNull();
  });
});

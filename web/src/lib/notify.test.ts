import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type UserPreferences } from '@talk/shared';
import { browserNotificationAllowed, messageAlerts } from './notify';

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

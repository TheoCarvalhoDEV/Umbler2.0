import { afterEach, expect, it, vi } from 'vitest';
import { SOUND_VALUES } from '@talk/shared';
import { playSound } from './sounds';

const param = (peaks: number[]) => ({
  value: 0,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn((v: number) => peaks.push(v)),
  exponentialRampToValueAtTime: vi.fn(),
});
const node = (peaks: number[]) => ({
  connect: vi.fn(function (this: unknown, n: unknown) { return n; }),
  disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
  frequency: param(peaks), gain: param(peaks), delayTime: param(peaks),
});

afterEach(() => vi.unstubAllGlobals());

it('stays silent without throwing when the browser has no audio, then plays every sound below 0.08', () => {
  vi.stubGlobal('AudioContext', vi.fn(() => { throw new Error('blocked'); }));
  expect(() => playSound('soft')).not.toThrow();

  const peaks: number[] = [];
  const made = vi.fn();
  vi.stubGlobal('AudioContext', vi.fn(function () {
    made();
    return {
      state: 'suspended', currentTime: 0, destination: {}, resume: vi.fn(() => Promise.resolve()),
      createOscillator: () => node(peaks), createGain: () => node(peaks), createDelay: () => node(peaks),
    };
  }));
  for (const kind of SOUND_VALUES) playSound(kind);
  expect(made).toHaveBeenCalledTimes(1); // one context, reused
  expect(peaks.length).toBeGreaterThan(0);
  expect(Math.max(...peaks)).toBeLessThanOrEqual(0.08);
});

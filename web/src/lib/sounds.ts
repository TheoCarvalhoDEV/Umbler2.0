// Notification sounds, synthesized with WebAudio (no audio files). Peaks stay at 0.05–0.08, far from clipping.
import type { NotificationSound } from '@talk/shared';

let ctx: AudioContext | null = null;

/** One note: attack to `peak`, exponential release to silence at `start + dur`. glideTo: pitch slides there. */
function tone(c: AudioContext, out: AudioNode, freq: number, start: number, dur: number, peak: number, attack: number, glideTo?: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.setValueAtTime(freq, start);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur * 0.6);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(out);
  osc.onended = () => gain.disconnect();
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

const SYNTHS: Record<NotificationSound, (c: AudioContext, t: number) => void> = {
  // Suave: two rising notes (E5, A5), sine plus a soft 2nd harmonic; ~300 ms
  soft: (c, t) => {
    for (const [freq, at] of [[659, 0], [880, 0.12]] as const) {
      tone(c, c.destination, freq, t + at, 0.18, 0.065, 0.012);
      tone(c, c.destination, freq * 2, t + at, 0.12, 0.01, 0.012);
    }
  },
  // Gota: a "plim" gliding down 1400 → 500 Hz with a fast decay; ~200 ms
  drop: (c, t) => tone(c, c.destination, 1400, t, 0.2, 0.075, 0.004, 500),
  // Sino: inharmonic partials (1 : 2.76 : 5.4 over 880 Hz), ~700 ms decay, and a faint echo (180 ms, feedback 0.25)
  bell: (c, t) => {
    const delay = c.createDelay();
    const feedback = c.createGain();
    const wet = c.createGain();
    delay.delayTime.value = 0.18;
    feedback.gain.value = 0.25;
    wet.gain.value = 0.3;
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(c.destination);
    const bus = c.createGain();
    bus.connect(c.destination);
    bus.connect(delay);
    tone(c, bus, 880, t, 0.7, 0.05, 0.003);
    tone(c, bus, 880 * 2.76, t, 0.45, 0.016, 0.003);
    tone(c, bus, 880 * 5.4, t, 0.25, 0.007, 0.003);
    // the echo loop never ends on its own: cut it once the tail is gone
    setTimeout(() => [bus, delay, feedback, wet].forEach((n) => n.disconnect()), 2000);
  },
};

/** Plays a sound. One AudioContext, made on the first play and reused. Silent when the browser blocks audio. */
export function playSound(kind: NotificationSound): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    SYNTHS[kind](ctx, ctx.currentTime + 0.01);
  } catch {
    // navegador bloqueou o áudio (sem interação prévia); a notificação ainda aparece
  }
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AudioPlayer, formatClock } from './AudioPlayer';

// jsdom has no media playback: play/pause flip `paused` and fire the events the browser would.
beforeEach(() => {
  let paused = new WeakMap<HTMLMediaElement, boolean>();
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
    return paused.get(this) ?? true;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false);
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, true);
    this.dispatchEvent(new Event('pause'));
  });
  return () => {
    paused = new WeakMap();
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const withDuration = (audio: HTMLAudioElement, seconds: number) => {
  Object.defineProperty(audio, 'duration', { configurable: true, value: seconds });
  fireEvent.loadedMetadata(audio);
};

describe('AudioPlayer', () => {
  it('formats m:ss and hides an unknown length', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65.9)).toBe('1:05');
    expect(formatClock(Infinity)).toBe('');
    expect(formatClock(Number.NaN)).toBe('');
  });

  it('plays and pauses, and shows elapsed / total once the length is known', () => {
    const { container } = render(<AudioPlayer src="/api/media/a1" insetClass="" />);
    const audio = container.querySelector('audio')!;
    withDuration(audio, 65);
    expect(screen.getByText('0:00 / 1:05')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ouvir áudio' }));
    expect(screen.getByRole('button', { name: 'Pausar áudio' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar áudio' }));
    expect(screen.getByRole('button', { name: 'Ouvir áudio' })).toBeTruthy();
  });

  it('the seek bar moves the playback position', () => {
    const { container } = render(<AudioPlayer src="/api/media/a1" insetClass="" />);
    const audio = container.querySelector('audio')!;
    withDuration(audio, 65);
    fireEvent.change(screen.getByLabelText('Posição do áudio'), { target: { value: '30' } });
    expect(audio.currentTime).toBe(30);
    expect(screen.getByText('0:30 / 1:05')).toBeTruthy();
  });

  it('cycles the speed 1× → 1,5× → 2× → 1×', () => {
    const { container } = render(<AudioPlayer src="/api/media/a1" insetClass="" />);
    const audio = container.querySelector('audio')!;
    fireEvent.click(screen.getByRole('button', { name: 'Velocidade 1×' }));
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByRole('button', { name: 'Velocidade 1,5×' }));
    expect(audio.playbackRate).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Velocidade 2×' }));
    expect(audio.playbackRate).toBe(1);
  });

  it('starting one audio pauses the one that was playing', () => {
    render(
      <>
        <AudioPlayer src="/api/media/a1" insetClass="" />
        <AudioPlayer src="/api/media/a2" insetClass="" />
      </>,
    );
    const [first, second] = screen.getAllByRole('button', { name: 'Ouvir áudio' });
    fireEvent.click(first!);
    fireEvent.click(second!);
    expect(screen.getAllByRole('button', { name: 'Pausar áudio' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Ouvir áudio' })).toHaveLength(1);
  });

  it('a file that cannot load says so and cannot be played', () => {
    const { container } = render(<AudioPlayer src="/api/media/a1" insetClass="" />);
    fireEvent.error(container.querySelector('audio')!);
    expect(screen.getByText('Áudio indisponível')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Ouvir áudio' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

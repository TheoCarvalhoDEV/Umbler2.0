import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from '@phosphor-icons/react';

const SPEEDS = [1, 1.5, 2] as const;
const speedLabel = (s: number) => `${String(s).replace('.', ',')}×`;

/** m:ss; an unknown length (some recorded files report Infinity until fully read) shows nothing. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Like WhatsApp: starting one audio pauses the one that was playing.
let playing: HTMLAudioElement | null = null;

/** A voice note or audio file in a bubble: play/pause, a seek bar, elapsed/total time and 1× / 1,5× / 2×. */
export function AudioPlayer({ src, insetClass }: { src: string; insetClass: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const [speed, setSpeed] = useState<number>(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el && playing === el) playing = null;
    };
  }, []);

  function toggle() {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setFailed(true));
    else el.pause();
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!;
    setSpeed(next);
    if (ref.current) ref.current.playbackRate = next;
  }

  const total = formatClock(duration);
  return (
    <div className="flex min-w-60 max-w-full items-center gap-2.5">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={(e) => {
          if (playing && playing !== e.currentTarget) playing.pause();
          playing = e.currentTarget;
          setIsPlaying(true);
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={(e) => {
          e.currentTarget.currentTime = 0;
          setTime(0);
          setIsPlaying(false);
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        onClick={toggle}
        disabled={failed}
        aria-label={isPlaying ? 'Pausar áudio' : 'Ouvir áudio'}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
      >
        {isPlaying ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" className="translate-x-px" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          type="range"
          aria-label="Posição do áudio"
          min={0}
          max={Number.isFinite(duration) ? duration : 0}
          step={0.1}
          value={time}
          disabled={failed || !Number.isFinite(duration)}
          onChange={(e) => {
            const t = Number(e.target.value);
            setTime(t);
            if (ref.current) ref.current.currentTime = t;
          }}
          className="h-1 w-full cursor-pointer accent-primary disabled:cursor-default"
        />
        <span className="text-[11px] leading-4 text-muted tabular-nums">
          {failed ? 'Áudio indisponível' : total ? `${formatClock(time)} / ${total}` : formatClock(time)}
        </span>
      </div>
      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={`Velocidade ${speedLabel(speed)}`}
        title="Velocidade"
        className={`h-6 min-w-10 shrink-0 rounded-full px-2 text-xs font-bold text-fg-2 tabular-nums hover:text-fg ${insetClass}`}
      >
        {speedLabel(speed)}
      </button>
    </div>
  );
}

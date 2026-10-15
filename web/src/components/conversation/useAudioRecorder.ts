import { useEffect, useRef, useState } from 'react';

// WhatsApp voice notes are ogg/opus. Firefox records ogg natively; Chromium only webm/opus,
// which Evolution's sendWhatsAppAudio converts.
const AUDIO_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];

export function useAudioRecorder() {
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  function release(): void {
    recorder.current?.stream.getTracks().forEach((t) => t.stop()); // turns the browser's mic indicator off
    recorder.current = null;
    setRecording(false);
  }

  /** Throws when there is no microphone, permission is denied or MediaRecorder does not exist. */
  async function start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    r.start();
    recorder.current = r;
    setRecording(true);
  }

  /** Stops and returns the recording, or null if nothing was captured. */
  function stop(): Promise<File | null> {
    const r = recorder.current;
    if (!r) return Promise.resolve(null);
    return new Promise((resolve) => {
      r.onstop = () => {
        const type = (r.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks.current, { type });
        release();
        resolve(blob.size > 0 ? new File([blob], `audio.${type === 'audio/ogg' ? 'ogg' : 'webm'}`, { type }) : null);
      };
      r.stop();
    });
  }

  function discard(): void {
    const r = recorder.current;
    if (r) {
      r.ondataavailable = null;
      r.onstop = null;
      if (r.state !== 'inactive') r.stop();
    }
    release();
  }

  // switching chats mid-recording frees the microphone
  useEffect(() => discard, []);

  return { recording, seconds, start, stop, discard };
}

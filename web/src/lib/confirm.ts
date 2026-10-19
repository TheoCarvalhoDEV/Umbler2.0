// Drop-ins for window.confirm / window.prompt with the app's look: a native <dialog> (focus trap, Esc, backdrop for free).
// Built with plain DOM so any click handler can `await` them without mounting a component.

interface Shell {
  dialog: HTMLDialogElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
  /** Shows the dialog; resolves with the value from `value()` when OK closes it, else null. */
  open: <T>(value: () => T) => Promise<T | null>;
}

function shell(opts: { title: string; body?: string; confirmLabel: string; cancelLabel?: string; danger: boolean }, middle?: HTMLElement): Shell {
  const dialog = document.createElement('dialog');
  dialog.className = 'm-auto w-[min(28rem,calc(100%-2rem))] rounded-lg bg-panel p-5 text-fg shadow-xl backdrop:bg-black/50';

  const title = document.createElement('h3');
  title.className = 'text-base font-semibold';
  title.textContent = opts.title; // textContent, never innerHTML: titles carry user-typed names
  dialog.append(title);
  dialog.setAttribute('aria-label', opts.title);

  if (opts.body) {
    const body = document.createElement('p');
    body.className = 'mt-2 text-sm text-muted';
    body.textContent = opts.body;
    dialog.append(body);
  }
  if (middle) dialog.append(middle);

  const actions = document.createElement('div');
  actions.className = 'mt-5 flex justify-end gap-2';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'rounded px-3 py-2 text-sm hover:bg-surface';
  cancel.textContent = opts.cancelLabel ?? 'Cancelar';
  const ok = document.createElement('button');
  ok.type = 'button';
  const tone = opts.danger ? 'bg-danger-strong hover:brightness-110' : 'bg-primary hover:bg-primary-hover';
  ok.className = `rounded px-3 py-2 text-sm font-medium text-white disabled:opacity-50 ${tone}`;
  ok.textContent = opts.confirmLabel;
  actions.append(cancel, ok);
  dialog.append(actions);

  const open = <T,>(value: () => T) =>
    new Promise<T | null>((resolve) => {
      let result: T | null = null;
      cancel.onclick = () => dialog.close();
      ok.onclick = () => {
        result = value();
        dialog.close();
      };
      dialog.onclose = () => {
        dialog.remove();
        resolve(result);
      };
      document.body.append(dialog);
      dialog.showModal();
    });
  return { dialog, ok, cancel, open };
}

export async function confirmDialog(opts: {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** false for a harmless confirmation (e.g. unblock): primary blue instead of red */
  danger?: boolean;
}): Promise<boolean> {
  const s = shell({ ...opts, danger: opts.danger !== false });
  const result = s.open(() => true);
  s.cancel.focus(); // the safe choice gets the initial focus
  return (await result) === true;
}

/** One-line text input. Resolves with the trimmed text, or null when cancelled or left unchanged. */
export async function promptDialog(opts: {
  title: string;
  body?: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  maxLength?: number;
}): Promise<string | null> {
  const input = document.createElement('input');
  input.className = 'mt-4 w-full rounded border border-field bg-transparent px-2 py-1.5 text-sm';
  input.setAttribute('aria-label', opts.label);
  input.value = opts.initial ?? '';
  if (opts.maxLength) input.maxLength = opts.maxLength;

  const s = shell({ ...opts, danger: false }, input);
  const sync = () => {
    s.ok.disabled = input.value.trim() === '';
  };
  input.oninput = sync;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !s.ok.disabled) {
      e.preventDefault();
      s.ok.click();
    }
  };
  sync();
  const result = s.open(() => input.value.trim());
  input.focus();
  input.select();
  const next = await result;
  return next && next !== (opts.initial ?? '').trim() ? next : null;
}

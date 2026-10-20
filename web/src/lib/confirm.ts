// Drop-ins for window.confirm / window.prompt with the app's look: a native <dialog> (focus trap, Esc, backdrop for free).
// Built with plain DOM so any click handler can `await` them without mounting a component.
import { button, dialog as dialogClass, dialogTitle, field } from '../components/ui';

interface Shell {
  dialog: HTMLDialogElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
  /** Shows the dialog; resolves with the value from `value()` when OK closes it, else null. */
  open: <T>(value: () => T) => Promise<T | null>;
}

function shell(opts: { title: string; body?: string; confirmLabel: string; cancelLabel?: string; danger: boolean }, middle?: HTMLElement): Shell {
  const dialog = document.createElement('dialog');
  dialog.className = dialogClass; // the scrim comes from dialog::backdrop in index.css

  const title = document.createElement('h3');
  title.className = dialogTitle;
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
  actions.className = 'mt-6 flex flex-wrap justify-end gap-2';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = button('secondary');
  cancel.textContent = opts.cancelLabel ?? 'Cancelar';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = button(opts.danger ? 'danger' : 'primary'); // as Dialogos.dc.html: Cancelar on fill, Excluir in danger-soft
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
  /** false for a harmless confirmation (e.g. unblock): the primary button instead of red */
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
  input.className = `${field} mt-4`;
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

// Drop-in for window.confirm with the app's look: a native <dialog> (focus trap, Esc, backdrop for free).
// Built with plain DOM so any click handler can `await` it without mounting a component.
export function confirmDialog(opts: {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** false for a harmless confirmation (e.g. unblock): primary blue instead of red */
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
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

    const actions = document.createElement('div');
    actions.className = 'mt-5 flex justify-end gap-2';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'rounded px-3 py-2 text-sm hover:bg-surface';
    cancel.textContent = opts.cancelLabel ?? 'Cancelar';
    const ok = document.createElement('button');
    ok.type = 'button';
    const tone = opts.danger === false ? 'bg-primary hover:bg-primary-hover' : 'bg-danger-strong hover:brightness-110';
    ok.className = `rounded px-3 py-2 text-sm font-medium text-white ${tone}`;
    ok.textContent = opts.confirmLabel;
    actions.append(cancel, ok);
    dialog.append(actions);

    let result = false;
    cancel.onclick = () => dialog.close();
    ok.onclick = () => {
      result = true;
      dialog.close();
    };
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };

    document.body.append(dialog);
    dialog.showModal();
    cancel.focus(); // the safe choice gets the initial focus
  });
}

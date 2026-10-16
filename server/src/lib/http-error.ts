export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra fields the error handler sends next to `error` (e.g. code, runs, problems). */
    public body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m = 'Requisição inválida') => new HttpError(400, m);
export const forbidden = (m = 'Sem permissão') => new HttpError(403, m);
export const notFound = (m = 'Não encontrado') => new HttpError(404, m);
export const conflict = (m = 'Conflito') => new HttpError(409, m);

/** Spec §5.5 `ask`: the composer and the transfer dialog show "Parar e enviar / Enviar e manter / Cancelar". */
export function botRunningError(runs: Array<{ id: string; botName: string }>): HttpError {
  return new HttpError(409, 'O chatbot está em execução nesta conversa', { code: 'BOT_RUNNING', runs });
}

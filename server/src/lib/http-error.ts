export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m = 'Requisição inválida') => new HttpError(400, m);
export const forbidden = (m = 'Sem permissão') => new HttpError(403, m);
export const notFound = (m = 'Não encontrado') => new HttpError(404, m);
export const conflict = (m = 'Conflito') => new HttpError(409, m);

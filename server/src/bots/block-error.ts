/** A block failure whose pt-BR message is shown in bot_failed.reason. Never put contact data (CPF, answers) in it. */
export class BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockError';
  }
}

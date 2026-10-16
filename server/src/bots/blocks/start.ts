import type { BlockRegistry } from '../registry.js';

// Start blocks only hand over to `next`. Which channels and manual flags apply lives on the bot row (spec §4 Início).
export const startBlocks: BlockRegistry = {
  start_channel: { type: 'start_channel', run: async () => ({ next: 'next' }) },
  start_manual: { type: 'start_manual', run: async () => ({ next: 'next' }) },
  // Unreachable: validateGraph forbids edges to a sticky note. It is here so the registry covers every BlockType.
  sticky_note: { type: 'sticky_note', run: async () => ({ end: 'failed', error: 'Anotação não executa' }) },
};

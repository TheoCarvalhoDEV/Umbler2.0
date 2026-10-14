import type { Db } from './db/client.js';
import type { Config } from './config.js';
import type { WhatsAppGateway } from './whatsapp/types.js';

// Grows with the plan: Task 7 adds `hub: Hub` (final shape in the plan's Shared Contract).
export interface AppCtx {
  db: Db;
  config: Config;
  wa: WhatsAppGateway;
}

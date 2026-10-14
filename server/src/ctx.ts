import type { Config } from './config.js';

// Grows with the plan: Task 2 adds `db: Db`, Task 4 adds `wa: WhatsAppGateway`, Task 7 adds `hub: Hub`
// (final shape in the plan's Shared Contract).
export interface AppCtx {
  config: Config;
}

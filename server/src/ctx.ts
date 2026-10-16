import type { BotRuntime } from './bots/runtime.js';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import type { Hub } from './realtime/hub.js';
import type { WhatsAppGateway } from './whatsapp/types.js';

export interface AppCtx {
  db: Db;
  config: Config;
  wa: WhatsAppGateway;
  hub: Hub;
  botRuntime: BotRuntime;
}

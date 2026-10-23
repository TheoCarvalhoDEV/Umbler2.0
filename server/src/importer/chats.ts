import type { Query, UmblerClient, UmblerMessage } from './umbler.js';

// Spec 2026-10-21 importar-umbler §7.6-7.8: Umbler chats and their messages, page by page.

/** §4: the first relative-messages page starts here; the next one at the last eventAtUTC - 1 ms. */
export const FIRST_EVENT = '2000-01-01T00:00:00Z';
export const MESSAGES_TAKE = 250; // the route's maximum

/** §4: direct conversations only, hidden ones included, without the token owner's pinned chats mixed in. */
export function chatQuery(org: string, state: 'open' | 'closed'): Query {
  return {
    organizationId: org,
    ContactTypes: ['DirectMessage'],
    Visibility: ['Show', 'Hide', 'HideUntilNextMessage'],
    IncludePinneds: false,
    ...(state === 'open'
      ? { ChatState: 'Open', ChatOrderBy: 'CreatedAtUTC', Order: 'Asc' }
      : { ChatState: 'Closed', ChatOrderBy: 'ClosedAtUTC', Order: 'Desc' }),
  };
}

export interface MessagePage { hasMessagesBeforeAllowedOrganizationPlan?: boolean; messages?: UmblerMessage[] }

/** One relative-messages page from `from` on (§4), without timeline events. "Analisar" reads with it too (§5.1). */
export function fetchMessagePage(client: UmblerClient, org: string, chatId: string, from: Date): Promise<MessagePage> {
  return client.get<MessagePage>(
    '/v1/chats/{chatId}/relative-messages/',
    { organizationId: org, FromEventUTC: from.toISOString(), Direction: 'TakeAfter', Take: MESSAGES_TAKE, IncludeMetadata: false },
    { chatId },
  );
}

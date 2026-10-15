// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto } from '@talk/shared';
import { MessageBubble } from './MessageBubble';

afterEach(cleanup);

const base: MessageDto = {
  id: 'm1', chatId: 'c1', direction: 'out', kind: 'text', body: 'Olá', media: null, mediaUnavailable: false,
  authorId: 'u1', authorName: 'Ana Lima', authorAvatarUrl: '/api/users/u1/avatar?v=abc', replyTo: null, reaction: null,
  status: 'sent', error: null, sentAt: '2026-10-15T12:00:00.000Z',
};

function renderBubble(m: MessageDto) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble m={m} onReply={() => {}} />
    </QueryClientProvider>,
  ).container;
}

describe('MessageBubble author avatar', () => {
  it('shows the agent picture next to messages sent by an agent', () => {
    expect(renderBubble(base).querySelector('img')?.getAttribute('src')).toBe('/api/users/u1/avatar?v=abc');
  });

  it('falls back to the agent initials without a picture', () => {
    const c = renderBubble({ ...base, authorAvatarUrl: null });
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('[data-author-avatar]')?.textContent).toBe('AL');
  });

  it('shows no author avatar on incoming messages or phone/system sends', () => {
    expect(renderBubble({ ...base, direction: 'in', authorId: null, authorName: null, authorAvatarUrl: null }).querySelector('[data-author-avatar]')).toBeNull();
    expect(renderBubble({ ...base, authorId: null, authorName: null, authorAvatarUrl: null }).querySelector('[data-author-avatar]')).toBeNull();
  });
});

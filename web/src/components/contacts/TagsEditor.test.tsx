// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactDto, TagDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { TagsEditor } from './TagsEditor';

const m = vi.hoisted(() => ({
  contacts: { setTags: vi.fn() },
  tags: { list: vi.fn() },
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: m,
}));

const contact: ContactDto = {
  id: 'c1', name: 'Maria', phone: '5565999991234', lid: null, email: null, landline: null,
  address: null, blocked: false, tagIds: ['t1'], fields: {}, createdAt: '2026-10-01T12:00:00.000Z', avatarUrl: null,
};
const tags: TagDto[] = [
  { id: 't1', name: 'Cliente', emoji: null, color: '#2563eb', position: 0 },
  { id: 't2', name: 'Urgente', emoji: '🔥', color: '#dc2626', position: 1 },
];

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TagsEditor contact={contact} />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.tags.list.mockResolvedValue(tags);
  m.contacts.setTags.mockImplementation(async (_id: string, tagIds: string[]) => ({ ...contact, tagIds }));
});
afterEach(cleanup);

describe('TagsEditor', () => {
  it('marks the contact tags as pressed', async () => {
    renderEditor();
    expect((await screen.findByRole('button', { name: /Cliente/ })).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Urgente/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('adds a tag with setTags and caches the returned contact', async () => {
    const qc = renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /Urgente/ }));
    await waitFor(() => expect(m.contacts.setTags).toHaveBeenCalledWith('c1', ['t1', 't2']));
    await waitFor(() => expect(qc.getQueryData<ContactDto>(qk.contact('c1'))?.tagIds).toEqual(['t1', 't2']));
  });

  it('removes a tag with setTags', async () => {
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /Cliente/ }));
    await waitFor(() => expect(m.contacts.setTags).toHaveBeenCalledWith('c1', []));
  });
});

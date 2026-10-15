// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactNoteDto } from '@talk/shared';
import { NotesList } from './NotesList';

const m = vi.hoisted(() => ({
  contacts: { notes: vi.fn(), addNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn() },
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: m,
}));

let notes: ContactNoteDto[];

function renderNotes() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NotesList contactId="c1" />
    </QueryClientProvider>,
  );
}

const textarea = () => screen.getByLabelText('Nova observação') as HTMLTextAreaElement;
const addButton = () => screen.getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  notes = [{ id: 'n1', body: 'Cliente prefere WhatsApp', pinned: false, authorName: 'Ana', createdAt: '2026-10-14T12:00:00.000Z' }];
  m.contacts.notes.mockImplementation(async () => notes);
  m.contacts.addNote.mockImplementation(async (_id: string, body: string) => {
    const note: ContactNoteDto = { id: 'n2', body, pinned: false, authorName: 'Ana', createdAt: '2026-10-14T13:00:00.000Z' };
    notes = [...notes, note];
    return note;
  });
  m.contacts.updateNote.mockImplementation(async (_id: string, noteId: string, patch: Partial<ContactNoteDto>) => {
    notes = notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n));
    return notes.find((n) => n.id === noteId);
  });
});
afterEach(cleanup);

describe('NotesList', () => {
  it('lists notes and disables Adicionar while empty', async () => {
    renderNotes();
    await screen.findByText('Cliente prefere WhatsApp');
    expect(addButton().disabled).toBe(true);
  });

  it('adds a note, clears the box and shows it', async () => {
    renderNotes();
    await screen.findByText('Cliente prefere WhatsApp');
    fireEvent.change(textarea(), { target: { value: '  Ligar amanhã  ' } });
    fireEvent.click(addButton());
    await waitFor(() => expect(m.contacts.addNote).toHaveBeenCalledWith('c1', 'Ligar amanhã'));
    await screen.findByText('Ligar amanhã');
    expect(textarea().value).toBe('');
  });

  it('pins a note with updateNote', async () => {
    renderNotes();
    fireEvent.click(await screen.findByRole('button', { name: 'Fixar observação' }));
    await waitFor(() => expect(m.contacts.updateNote).toHaveBeenCalledWith('c1', 'n1', { pinned: true }));
    await screen.findByRole('button', { name: 'Desafixar observação' });
  });
});

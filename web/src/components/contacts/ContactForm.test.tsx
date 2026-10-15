// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactDto } from '@talk/shared';
import { ContactForm } from './ContactForm';

const m = vi.hoisted(() => ({
  contacts: { create: vi.fn(), update: vi.fn(), setFields: vi.fn() },
  customFields: { list: vi.fn() },
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: m,
}));

const contact: ContactDto = {
  id: 'c1', name: 'Maria Souza', phone: '5565999991234', lid: null, email: null, landline: null,
  address: null, blocked: false, tagIds: [], fields: {}, createdAt: '2026-10-01T12:00:00.000Z',
};

function renderForm(existing?: ContactDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ContactForm contact={existing} onSaved={onSaved} onCancel={vi.fn()} />
    </QueryClientProvider>,
  );
  return { onSaved };
}

const celular = () => screen.getByLabelText(/Celular/) as HTMLInputElement;

beforeEach(() => {
  vi.resetAllMocks();
  m.customFields.list.mockResolvedValue([]);
  m.contacts.create.mockImplementation(async (input: object) => ({ ...contact, ...input }));
  m.contacts.update.mockImplementation(async (_id: string, input: object) => ({ ...contact, ...input }));
});
afterEach(cleanup);

describe('ContactForm', () => {
  it('requires the celular', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Maria' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Informe o celular.');
    expect(m.contacts.create).not.toHaveBeenCalled();
  });

  it('rejects a celular without DDD', async () => {
    renderForm();
    fireEvent.change(celular(), { target: { value: '99991234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Celular inválido: informe DDD e número.');
  });

  it('shows the stored phone formatted', () => {
    renderForm(contact);
    expect(celular().value).toBe('(65) 99999-1234');
  });

  it('masks while typing and posts 55 + digits', async () => {
    const { onSaved } = renderForm();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: ' Maria ' } });
    fireEvent.change(celular(), { target: { value: '65 99999 1234' } });
    expect(celular().value).toBe('(65) 99999-1234');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(m.contacts.create).toHaveBeenCalledWith({
      name: 'Maria', phone: '5565999991234', email: null, landline: null, address: null,
    });
    expect(m.contacts.setFields).not.toHaveBeenCalled();
  });

  it('patches an existing contact with address fields', async () => {
    const { onSaved } = renderForm(contact);
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Cuiabá' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(m.contacts.update).toHaveBeenCalledWith('c1', {
      name: 'Maria Souza', email: null, address: { city: 'Cuiabá' }, // untouched phone/landline are not sent
    });
  });

  it('editing only the name of a foreign-number contact does not rewrite its phone or landline', async () => {
    const { onSaved } = renderForm({ ...contact, phone: '14155551234', landline: '447911123456' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'John' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = m.contacts.update.mock.calls[0]![1] as object;
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('landline');
  });

  it('a contact known only by LID (no phone) can be saved without inventing one', async () => {
    const { onSaved } = renderForm({ ...contact, phone: null, lid: '123456789' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente LID' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(m.contacts.update.mock.calls[0]![1]).toMatchObject({ name: 'Cliente LID' });
    expect(m.contacts.update.mock.calls[0]![1]).not.toHaveProperty('phone');
  });

  it('a changed phone is still validated and sent', async () => {
    const { onSaved } = renderForm(contact);
    fireEvent.change(celular(), { target: { value: '65 98888 7777' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(m.contacts.update.mock.calls[0]![1]).toMatchObject({ phone: '5565988887777' });
  });
});

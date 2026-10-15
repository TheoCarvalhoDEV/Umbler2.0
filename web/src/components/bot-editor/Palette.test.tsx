// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BLOCK_CATALOG } from '@talk/shared';
import { PALETTE_DRAG_TYPE, Palette } from './Palette';

afterEach(cleanup);

it('lists every block under its category', () => {
  render(<Palette open onInsert={() => {}} />);
  for (const heading of ['Início', 'Condições', 'Ações', 'Finalização', 'Utilitários']) {
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  }
  expect(screen.getAllByRole('button')).toHaveLength(BLOCK_CATALOG.length);
});

it('filters by label or description, ignoring accents and case', () => {
  render(<Palette open onInsert={() => {}} />);
  const search = screen.getByRole('searchbox', { name: 'Buscar bloco' });
  fireEvent.change(search, { target: { value: 'CONDIC' } });
  expect(screen.getByRole('button', { name: 'Condição' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Várias condições' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enviar mensagem' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Ações' })).toBeNull();
  fireEvent.change(search, { target: { value: 'horario' } });
  expect(screen.getByRole('button', { name: 'Horário' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(screen.getByText('Nenhum bloco encontrado.')).toBeTruthy();
});

it('inserts on click and carries the block type on drag', () => {
  const onInsert = vi.fn();
  render(<Palette open onInsert={onInsert} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }));
  expect(onInsert).toHaveBeenCalledWith('send_message');
  const setData = vi.fn();
  fireEvent.dragStart(screen.getByRole('button', { name: 'Pedir para escolher' }), { dataTransfer: { setData, effectAllowed: 'none' } });
  expect(setData).toHaveBeenCalledWith(PALETTE_DRAG_TYPE, 'ask_choice');
});

it('renders nothing when closed', () => {
  const { container } = render(<Palette open={false} onInsert={() => {}} />);
  expect(container.innerHTML).toBe('');
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TAG_COLORS, tagColorHex } from '@talk/shared';
import { TagForm } from './TagForm';

afterEach(cleanup);

const nameInput = () => screen.getByLabelText('Nome') as HTMLInputElement;

describe('tag colors', () => {
  it('has the 20 Umbler colors with unique hex values', () => {
    expect(TAG_COLORS).toHaveLength(20);
    expect(new Set(TAG_COLORS.map((c) => c.hex)).size).toBe(20);
  });

  it('resolves Umbler names, keeps hex and falls back to gray', () => {
    expect(tagColorHex('Tomato')).toBe('#ef4444');
    expect(tagColorHex('tomato')).toBe('#ef4444');
    expect(tagColorHex('#ABCDEF')).toBe('#abcdef');
    expect(tagColorHex('roxo-inexistente')).toBe('#6b7280');
  });
});

describe('TagForm', () => {
  it('shows the 20-color palette with the first color selected', () => {
    render(<TagForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const swatches = screen.getAllByRole('radio');
    expect(swatches).toHaveLength(20);
    expect(swatches[0]!.getAttribute('aria-checked')).toBe('true');
    expect(swatches.filter((s) => s.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('limits the name to 30 characters and shows the counter', () => {
    render(<TagForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: 'a'.repeat(35) } });
    expect(nameInput().value).toBe('a'.repeat(30));
    expect(nameInput().maxLength).toBe(30);
    screen.getByText('30/30');
  });

  it('previews the chip and submits trimmed name, emoji and the chosen color as hex', () => {
    const onSubmit = vi.fn();
    render(<TagForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: '  Cliente VIP ' } });
    fireEvent.change(screen.getByLabelText('Emoji'), { target: { value: '⭐' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Verde' }));

    expect(screen.getByRole('radio', { name: 'Verde' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('tag-preview').textContent).toBe('⭐ Cliente VIP');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Cliente VIP', emoji: '⭐', color: '#16a34a' });
  });

  it('sends a null emoji when the emoji field is empty', () => {
    const onSubmit = vi.fn();
    render(<TagForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: 'Urgente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Urgente', emoji: null, color: TAG_COLORS[0]!.hex });
  });

  it('cannot save a blank name', () => {
    render(<TagForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('editing an imported tag selects its Umbler color', () => {
    render(
      <TagForm
        initial={{ id: 't1', name: 'Antigo', emoji: null, color: 'Tomato', position: 0 }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(nameInput().value).toBe('Antigo');
    expect(screen.getByRole('radio', { name: 'Tomate' }).getAttribute('aria-checked')).toBe('true');
  });
});

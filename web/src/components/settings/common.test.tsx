// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RowMenu, SaveBar, Switch } from './common';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Switch', () => {
  it('is a native button with role switch, so Enter and Space flip it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch label="Sons" checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Sons' });
    expect(sw.tagName).toBe('BUTTON');
    expect(sw.getAttribute('type')).toBe('button');
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Switch label="Sons" checked onChange={onChange} />);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('does nothing when disabled', () => {
    const onChange = vi.fn();
    render(<Switch label="Sons" checked={false} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sons' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('RowMenu', () => {
  it('opens, runs the chosen item and closes; Escape and a click outside close it too', () => {
    const rename = vi.fn();
    render(<RowMenu label="Opções do setor" items={[{ label: 'Renomear', onSelect: rename }, false, { label: 'Excluir', onSelect: vi.fn(), danger: true }]} />);
    const trigger = screen.getByRole('button', { name: 'Opções do setor' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Renomear' })).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Excluir' }).className).toContain('text-danger');
    fireEvent.click(screen.getByRole('button', { name: 'Renomear' }));
    expect(rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Renomear' })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Renomear' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Renomear' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('button', { name: 'Renomear' })).toBeNull();
  });
});

describe('SaveBar', () => {
  const noop = () => {};

  it('shows only with unsaved changes, with Descartar and Salvar', () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const { rerender } = render(<SaveBar dirty={false} saving={false} onSave={onSave} onDiscard={onDiscard} />);
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();

    rerender(<SaveBar dirty saving={false} onSave={onSave} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();

    rerender(<SaveBar dirty saving onSave={onSave} onDiscard={onDiscard} error={new Error('Nome já existe')} />);
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Nome já existe');
  });

  it('says "Alterações salvas." for 3 s after a save, then hides', () => {
    vi.useFakeTimers();
    const { rerender } = render(<SaveBar dirty saving onSave={noop} onDiscard={noop} />);
    rerender(<SaveBar dirty={false} saving={false} saved onSave={noop} onDiscard={noop} />);
    expect(screen.getByRole('status').textContent).toBe('Alterações salvas.');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

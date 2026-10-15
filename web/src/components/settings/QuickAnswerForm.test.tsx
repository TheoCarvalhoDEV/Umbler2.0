// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CustomFieldDto } from '@talk/shared';
import { FIXED_VARIABLES, QuickAnswerForm, insertAtCursor } from './QuickAnswerForm';

afterEach(cleanup);

const fields: CustomFieldDto[] = [
  { id: 'f1', name: 'CPF', kind: 'cpf', position: 0 },
  { id: 'f2', name: 'Número do processo', kind: 'text', position: 1 },
];

const bodyBox = () => screen.getByLabelText('Mensagem') as HTMLTextAreaElement;

describe('insertAtCursor', () => {
  it('inserts at a collapsed cursor and moves the caret after the snippet', () => {
    expect(insertAtCursor('Olá , tudo bem?', 4, 4, '{{contato.nome}}')).toEqual({
      text: 'Olá {{contato.nome}}, tudo bem?',
      caret: 20,
    });
  });

  it('replaces the selected range', () => {
    expect(insertAtCursor('Prezado XXX', 8, 11, '{{contato.nome}}')).toEqual({
      text: 'Prezado {{contato.nome}}',
      caret: 24,
    });
  });
});

describe('QuickAnswerForm', () => {
  it('offers the 7 named variables of §5.7 plus one per custom field', () => {
    render(<QuickAnswerForm isAdmin fields={fields} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(FIXED_VARIABLES.map(([v]) => v)).toEqual([
      'atendente.nome',
      'atendente.primeiro_nome',
      'atendente.email',
      'contato.nome',
      'contato.primeiro_nome',
      'contato.telefone',
      'contato.email',
    ]);
    for (const [, label] of FIXED_VARIABLES) screen.getByRole('button', { name: label });
    screen.getByRole('button', { name: 'Campo: CPF' });
    screen.getByRole('button', { name: 'Campo: Número do processo' });
  });

  it('inserts the variable at the cursor and keeps typing position for the next one', () => {
    render(<QuickAnswerForm isAdmin fields={fields} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(bodyBox(), { target: { value: 'Olá , tudo bem?' } });
    bodyBox().setSelectionRange(4, 4);

    fireEvent.click(screen.getByRole('button', { name: 'Nome do contato' }));
    expect(bodyBox().value).toBe('Olá {{contato.nome}}, tudo bem?');
    expect(bodyBox().selectionStart).toBe(20);

    fireEvent.click(screen.getByRole('button', { name: 'Primeiro nome do atendente' }));
    expect(bodyBox().value).toBe('Olá {{contato.nome}}{{atendente.primeiro_nome}}, tudo bem?');
  });

  it('replaces a selection with a custom field variable', () => {
    render(<QuickAnswerForm isAdmin fields={fields} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(bodyBox(), { target: { value: 'Seu processo: XXX' } });
    bodyBox().setSelectionRange(14, 17);
    fireEvent.click(screen.getByRole('button', { name: 'Campo: Número do processo' }));
    expect(bodyBox().value).toBe('Seu processo: {{campo.Número do processo}}');
  });

  it('agents cannot choose "Para todos" and submit with owner visibility', () => {
    const onSubmit = vi.fn();
    render(<QuickAnswerForm isAdmin={false} fields={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: 'Para todos' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: ' Boas-vindas ' } });
    fireEvent.change(bodyBox(), { target: { value: 'Olá {{contato.primeiro_nome}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Boas-vindas',
      body: 'Olá {{contato.primeiro_nome}}',
      visibility: 'owner',
      file: null,
    });
  });

  it('admins default to "Para todos" and can switch to "Apenas para mim"', () => {
    const onSubmit = vi.fn();
    render(<QuickAnswerForm isAdmin fields={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect((screen.getByRole('radio', { name: 'Para todos' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Apenas para mim' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pix' } });
    fireEvent.change(bodyBox(), { target: { value: 'Chave Pix: …' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'owner' }));
  });

  it('cannot save without name and message', () => {
    render(<QuickAnswerForm isAdmin fields={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Só nome' } });
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

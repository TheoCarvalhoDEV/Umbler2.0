// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { SectorDto } from '@talk/shared';
import { TriageOptionsEditor, type TriageOptionInput } from './TriageOptionsEditor';

const sectors: SectorDto[] = [
  { id: 's-fin', name: 'Financeiro', position: 0, isDefault: false },
  { id: 's-jur', name: 'Jurídico', position: 1, isDefault: false },
];

let last: TriageOptionInput[] = [];

function Harness({ initial }: { initial: TriageOptionInput[] }) {
  const [options, setOptions] = useState(initial);
  return (
    <TriageOptionsEditor
      options={options}
      sectors={sectors}
      onChange={(next) => {
        last = next;
        setOptions(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  last = [];
});

describe('TriageOptionsEditor', () => {
  it('starts empty and adds options numbered 1, 2, … with no sector chosen', () => {
    render(<Harness initial={[]} />);
    screen.getByText('Nenhuma opção. Clique em “Adicionar opção”.');

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));

    expect(last).toEqual([
      { key: '1', label: '', sectorId: '' },
      { key: '2', label: '', sectorId: '' },
    ]);
  });

  it('numbers a new option after the highest existing number', () => {
    render(<Harness initial={[{ key: '5', label: 'Outros', sectorId: 's-fin' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));
    expect(last.map((o) => o.key)).toEqual(['5', '6']);
  });

  it('removes only the chosen row', () => {
    render(
      <Harness
        initial={[
          { key: '1', label: 'Boletos', sectorId: 's-fin' },
          { key: '2', label: 'Processos', sectorId: 's-jur' },
          { key: '3', label: 'Outros', sectorId: 's-fin' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remover opção 2' }));

    expect(last.map((o) => o.label)).toEqual(['Boletos', 'Outros']);
    expect(screen.getAllByRole('button', { name: /^Remover opção/ })).toHaveLength(2);
  });

  it('choosing a sector fills an empty label with the sector name but keeps a typed one', () => {
    render(
      <Harness
        initial={[
          { key: '1', label: '', sectorId: '' },
          { key: '2', label: 'Andamento do processo', sectorId: '' },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Setor da opção 1'), { target: { value: 's-jur' } });
    fireEvent.change(screen.getByLabelText('Setor da opção 2'), { target: { value: 's-jur' } });

    expect(last).toEqual([
      { key: '1', label: 'Jurídico', sectorId: 's-jur' },
      { key: '2', label: 'Andamento do processo', sectorId: 's-jur' },
    ]);
  });

  it('edits number and text of a row', () => {
    render(<Harness initial={[{ key: '1', label: 'Boletos', sectorId: 's-fin' }]} />);
    fireEvent.change(screen.getByLabelText('Número da opção 1'), { target: { value: ' 9 ' } });
    fireEvent.change(screen.getByLabelText('Texto da opção 1'), { target: { value: '2ª via de boleto' } });
    expect(last).toEqual([{ key: '9', label: '2ª via de boleto', sectorId: 's-fin' }]);
  });
});

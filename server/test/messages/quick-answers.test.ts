import { describe, expect, it } from 'vitest';
import { convertUmblerVariables, renderQuickAnswer, type QuickAnswerVars } from '../../src/messages/quick-answers.js';

const vars: QuickAnswerVars = {
  atendente: { nome: 'Ana Paula Lima', primeiro_nome: 'Ana', email: 'ana@jvo.adv.br' },
  contato: { nome: 'Maria Souza', primeiro_nome: 'Maria', telefone: '5565999991111', email: '' },
  campo: { 'Número do processo': '0001234-56.2026.8.11.0041', CPF: '123.456.789-00' },
};

describe('renderQuickAnswer', () => {
  it.each([
    ['Olá {{contato.primeiro_nome}}!', 'Olá Maria!'],
    ['{{ contato.nome }} / {{contato.telefone}}', 'Maria Souza / 5565999991111'],
    ['Sou {{atendente.nome}} ({{atendente.email}}), {{atendente.primeiro_nome}}', 'Sou Ana Paula Lima (ana@jvo.adv.br), Ana'],
    ['E-mail: [{{contato.email}}]', 'E-mail: []'],
    ['Processo {{campo.Número do processo}}', 'Processo 0001234-56.2026.8.11.0041'],
    ['Processo {{campo.numero_do_processo}}', 'Processo 0001234-56.2026.8.11.0041'],
    ['CPF {{campo.cpf}} / {{ Campo.CPF }}', 'CPF 123.456.789-00 / 123.456.789-00'],
    ['Sem valor: [{{campo.Inexistente}}]', 'Sem valor: []'],
    ['{{Contato.Primeiro_Nome}}', 'Maria'],
    ['CEP: [{{contato.cep}}]', 'CEP: []'],
    ['Literal {{Contexto.x}} e {{1}}', 'Literal {{Contexto.x}} e {{1}}'],
    ['Sem variáveis', 'Sem variáveis'],
  ])('%j renders %j', (body, expected) => {
    expect(renderQuickAnswer(body, vars)).toBe(expected);
  });
});

describe('convertUmblerVariables', () => {
  it.each([
    ['Contato.PrimeiroNome', '{{contato.primeiro_nome}}'],
    ['Contato.NomeCompleto', '{{contato.nome}}'],
    ['Contato.Numero', '{{contato.telefone}}'],
    ['Contato.Email', '{{contato.email}}'],
    ['Atendente.PrimeiroNome', '{{atendente.primeiro_nome}}'],
    ['Atendente.NomeCompleto', '{{atendente.nome}}'],
    ['Atendente.Email', '{{atendente.email}}'],
    ['{{Contact.FirstName}}', '{{contato.primeiro_nome}}'],
    [' contato . primeiro nome ', '{{contato.primeiro_nome}}'],
    ['Campo Personalizado.Número do processo', '{{campo.Número do processo}}'],
  ])('%j becomes %s', (defaultValue, expected) => {
    expect(convertUmblerVariables('Olá {{1}}!', [{ defaultValue }])).toEqual({ body: `Olá ${expected}!`, unmapped: [] });
  });

  it.each([['Contato.CEP'], ['Atendente.Id'], ['Atendente.Numero'], ['Contato.constructor'], ['Texto livre']])(
    '%j has no match: written as text and reported',
    (defaultValue) => {
      expect(convertUmblerVariables('Olá {{1}}!', [{ defaultValue }])).toEqual({
        body: `Olá ${defaultValue}!`,
        unmapped: [defaultValue],
      });
    },
  );

  it('converts several placeholders, reports each unmatched value once and keeps missing ones', () => {
    const variables = [{ defaultValue: 'Contato.PrimeiroNome' }, { defaultValue: 'Contato.CEP' }, { defaultValue: '' }];
    expect(convertUmblerVariables('{{1}}, CEP {{2}} / {{2}} {{3}} {{4}}', variables)).toEqual({
      body: '{{contato.primeiro_nome}}, CEP Contato.CEP / Contato.CEP {{3}} {{4}}',
      unmapped: ['Contato.CEP', '{{3}}', '{{4}}'],
    });
  });

  it('produces bodies that renderQuickAnswer fills', () => {
    const { body } = convertUmblerVariables('Oi {{1}}, sou {{2}}. Processo {{3}}', [
      { defaultValue: 'Contato.PrimeiroNome' },
      { defaultValue: 'Atendente.PrimeiroNome' },
      { defaultValue: 'CampoPersonalizado.Número do processo' },
    ]);
    expect(renderQuickAnswer(body, vars)).toBe('Oi Maria, sou Ana. Processo 0001234-56.2026.8.11.0041');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { whatsappText } from './whatsappText';

afterEach(cleanup);

const html = (s: string) => render(<p>{whatsappText(s)}</p>).container.firstElementChild!.innerHTML;

describe('whatsappText: WhatsApp formatting as on the phone', () => {
  it('the office signature *Nome:* comes out bold, without the asterisks', () => {
    expect(html('*Atendente: Nayara.:*\nolá boa tarde')).toBe('<strong>Atendente: Nayara.:</strong>\nolá boa tarde');
  });

  it('bold, italic, strikethrough and monospace, also nested', () => {
    expect(html('*negrito* _itálico_ ~riscado~ ```mono```')).toBe(
      '<strong>negrito</strong> <em>itálico</em> <s>riscado</s> <code class="font-mono">mono</code>',
    );
    expect(html('*muito _importante_*')).toBe('<strong>muito <em>importante</em></strong>');
  });

  it('leaves the text alone when it is not formatting', () => {
    for (const s of ['2*3*4 = 24', 'arquivo_do_cliente_final.pdf', '* item solto', 'preço * 2', 'a ** b', '*sem fim', 'fim*']) {
      expect(html(s)).toBe(s);
    }
  });

  it('never crosses a line break, except monospace', () => {
    expect(html('*linha um\nlinha dois*')).toBe('*linha um\nlinha dois*');
    expect(html('```a\nb```')).toBe('<code class="font-mono">a\nb</code>');
  });

  it('text inside markers is never HTML', () => {
    expect(html('*<b>oi</b>*')).toBe('<strong>&lt;b&gt;oi&lt;/b&gt;</strong>');
  });
});

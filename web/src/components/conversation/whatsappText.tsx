import type { ReactNode } from 'react';

/**
 * WhatsApp's *bold*, _italic_, ~strikethrough~ and ```monospace```, as the phone shows them. The result is React nodes, so
 * the text is never HTML. A marker opens at the start or after a space or punctuation, hugs non-space text on the inside,
 * is not followed by a letter or digit, and never crosses a line break (``` may).
 */
const INLINE = /(^|[^\p{L}\p{N}*_~])([*_~])(?=[^\s*_~])([^\n]*?\S)\2(?![\p{L}\p{N}])/u;
const TAGS = { '*': 'strong', _: 'em', '~': 's' } as const;

function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (let rest = s, i = 0; ; i++) {
    const m = INLINE.exec(rest);
    if (!m) {
      if (rest) out.push(rest);
      return out;
    }
    const start = m.index + m[1]!.length;
    if (start > 0) out.push(rest.slice(0, start));
    const Tag = TAGS[m[2] as keyof typeof TAGS];
    out.push(<Tag key={`${key}.${i}`}>{inline(m[3]!, `${key}.${i}`)}</Tag>);
    rest = rest.slice(start + m[3]!.length + 2);
  }
}

export function whatsappText(text: string): ReactNode[] {
  return text
    .split(/```([\s\S]+?)```/)
    .flatMap((part, i): ReactNode[] => (i % 2 ? [<code key={i} className="font-mono">{part}</code>] : inline(part, String(i))));
}

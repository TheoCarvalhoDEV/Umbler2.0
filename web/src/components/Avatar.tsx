import { useState } from 'react';
import { UserIcon } from '@phosphor-icons/react';
import { initials } from '../lib/format';

interface Props {
  name: string | null;
  src: string | null;
  /** Size and text size (size-10 text-sm…). Colors come from the name. */
  className?: string;
}

// Literal class names so Tailwind generates them; tokens in index.css.
const TINTS = [
  'bg-tint-1 text-tint-1-fg',
  'bg-tint-2 text-tint-2-fg',
  'bg-tint-3 text-tint-3-fg',
  'bg-tint-4 text-tint-4-fg',
  'bg-tint-5 text-tint-5-fg',
];

function tint(name: string): string {
  let sum = 0;
  for (const ch of name) sum += ch.codePointAt(0)!;
  return TINTS[sum % TINTS.length]!;
}

/** Profile picture, or the name's initials on a tint when there is none or it fails to load; a person icon
 * when the name has no letters. Decorative: the name is shown beside it. */
export function Avatar({ name, src, className = 'size-10 text-sm' }: Props) {
  // Remembers the URL that failed, so a new URL (new ?v=) is tried again.
  const [failed, setFailed] = useState<string | null>(null);
  if (src && src !== failed) {
    return <img src={src} alt="" aria-hidden="true" onError={() => setFailed(src)} className={`${className} shrink-0 rounded-full bg-day object-cover`} />;
  }
  const text = initials(name);
  if (text === '?') {
    return (
      <span aria-hidden="true" className={`${className} grid shrink-0 place-items-center rounded-full bg-day text-fg-2`}>
        <UserIcon className="size-[45%]" weight="bold" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`${className} grid shrink-0 place-items-center rounded-full font-bold ${tint(name!)}`}>
      {text}
    </span>
  );
}

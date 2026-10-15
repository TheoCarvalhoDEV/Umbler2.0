import { useState } from 'react';
import { initials } from '../lib/format';

interface Props {
  name: string | null;
  src: string | null;
  /** Size, text size and fallback colors. */
  className?: string;
}

/** Profile picture, or the name's initials when there is none or it fails to load. Decorative: the name is shown beside it. */
export function Avatar({ name, src, className = 'size-9 text-sm bg-primary text-white' }: Props) {
  // Remembers the URL that failed, so a new URL (new ?v=) is tried again.
  const [failed, setFailed] = useState<string | null>(null);
  if (src && src !== failed) {
    return <img src={src} alt="" aria-hidden="true" onError={() => setFailed(src)} className={`${className} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span aria-hidden="true" className={`${className} grid shrink-0 place-items-center rounded-full font-semibold`}>
      {initials(name)}
    </span>
  );
}

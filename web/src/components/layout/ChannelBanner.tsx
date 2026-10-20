import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { WarningCircleIcon } from '@phosphor-icons/react';
import type { ChannelDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';

const GRACE_MS = 60_000;

/** History spec §7: down for more than 1 min (no disconnectedAt = an outage older than this field). */
export function downChannels(list: ChannelDto[], now: number): ChannelDto[] {
  return list.filter((c) => c.status === 'disconnected' && (!c.disconnectedAt || now - Date.parse(c.disconnectedAt) > GRACE_MS));
}

/** Admins only: a disconnected channel, with the way back. Disappears when channel.status says connected. */
export function ChannelBanner() {
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const { data } = useQuery({ queryKey: qk.channels, queryFn: api.channels.list, enabled: isAdmin });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000); // re-check the 1-min grace without new events
    return () => clearInterval(t);
  }, []);

  const down = isAdmin ? downChannels(data ?? [], now) : [];
  if (down.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-card bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
      {down.map((c) => (
        <p key={c.id} className="flex items-center gap-2">
          <WarningCircleIcon size={18} weight="fill" aria-hidden />
          <span>
            Canal {c.name} desconectado: leia o QR code em{' '}
            <Link to="/configuracoes/canais" className="underline underline-offset-2">
              Configurações › Canais
            </Link>
          </span>
        </p>
      ))}
    </div>
  );
}

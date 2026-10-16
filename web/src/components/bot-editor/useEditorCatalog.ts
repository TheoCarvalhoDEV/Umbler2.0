import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BotDto, ChannelDto, CustomFieldDto, SectorDto, TagDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

export interface EditorCatalog {
  sectors: SectorDto[];
  users: UserDto[];
  tags: TagDto[];
  customFields: CustomFieldDto[];
  channels: ChannelDto[];
  bots: BotDto[];
}

/** Everything the block cards pick from (selects of sectors, agents, tags, fields, channels, bots). null until all have loaded. */
export function useEditorCatalog(): EditorCatalog | null {
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const customFields = useQuery({ queryKey: qk.customFields, queryFn: api.customFields.list });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const bots = useQuery({ queryKey: qk.bots, queryFn: api.bots.list });
  return useMemo(
    () =>
      sectors.data && users.data && tags.data && customFields.data && channels.data && bots.data
        ? { sectors: sectors.data, users: users.data, tags: tags.data, customFields: customFields.data, channels: channels.data, bots: bots.data }
        : null,
    [sectors.data, users.data, tags.data, customFields.data, channels.data, bots.data],
  );
}

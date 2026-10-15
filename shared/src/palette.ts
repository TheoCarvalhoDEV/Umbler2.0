// The 20 colors of Umbler's tag palette (TagColor enum in utalk-openapi-v1.json), in Umbler's order.
// `name` is the Umbler enum value, `label` is pt-BR, `hex` is lowercase #rrggbb. tags.color stores the hex.
// This is the only runtime value in @talk/shared (no build step: tsx and Vite load this source directly).
export const TAG_COLORS = [
  { name: 'Blue', label: 'Azul', hex: '#2563eb' },
  { name: 'Skyblue', label: 'Azul-céu', hex: '#0ea5e9' },
  { name: 'Cyan', label: 'Ciano', hex: '#06b6d4' },
  { name: 'Aquamarine', label: 'Água-marinha', hex: '#14b8a6' },
  { name: 'Green', label: 'Verde', hex: '#16a34a' },
  { name: 'Kiwi', label: 'Kiwi', hex: '#65a30d' },
  { name: 'Gold', label: 'Dourado', hex: '#ca8a04' },
  { name: 'Amber', label: 'Âmbar', hex: '#d97706' },
  { name: 'Tangerine', label: 'Tangerina', hex: '#ea580c' },
  { name: 'Chocolate', label: 'Chocolate', hex: '#92400e' },
  { name: 'Salmon', label: 'Salmão', hex: '#f87171' },
  { name: 'Tomato', label: 'Tomate', hex: '#ef4444' },
  { name: 'Rose', label: 'Rosa', hex: '#e11d48' },
  { name: 'Pink', label: 'Rosa-claro', hex: '#ec4899' },
  { name: 'Magenta', label: 'Magenta', hex: '#c026d3' },
  { name: 'Violet', label: 'Violeta', hex: '#8b5cf6' },
  { name: 'Grape', label: 'Uva', hex: '#6d28d9' },
  { name: 'Gray', label: 'Cinza', hex: '#6b7280' },
  { name: 'Silver', label: 'Prata', hex: '#94a3b8' },
  { name: 'Umblerito', label: 'Azul-marinho', hex: '#1e3a8a' },
] as const;

const GRAY = '#6b7280';

/** Renders a stored tag color: a hex as-is (lowercased), an Umbler colour name via TAG_COLORS, anything else gray. */
export function tagColorHex(color: string): string {
  const byName = TAG_COLORS.find((c) => c.name.toLowerCase() === color.toLowerCase());
  if (byName) return byName.hex;
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : GRAY;
}

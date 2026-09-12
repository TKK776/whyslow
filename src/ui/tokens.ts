/**
 * Colour is data here, not decoration: the ramp encodes how much of the total
 * runtime a node consumed. Keep the palette cool so the heat reads as signal.
 */
export const C = {
  paper: '#F2F5F6',
  surface: '#FFFFFF',
  ink: '#14202A',
  inkSoft: '#4A5C68',
  inkFaint: '#8095A2',
  rule: '#D8E1E6',
  ruleSoft: '#E8EEF1',
  cold: '#8CA6B3',
  warm: '#D19A3C',
  hot: '#BC3B2F',
  flag: '#8A5A00',
  flagBg: '#FDF4E1',
  accent: '#186A63',
} as const;

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const SANS =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif";

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Cold to warm to hot, as a share of the slowest node in the plan. */
export function heat(share: number): string {
  const t = Math.max(0, Math.min(1, share));
  const stops = [C.cold, C.warm, C.hot].map(channels);
  const low = stops[t < 0.5 ? 0 : 1] as [number, number, number];
  const high = stops[t < 0.5 ? 1 : 2] as [number, number, number];
  const k = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;

  const mix = (i: 0 | 1 | 2) => Math.round(low[i] + (high[i] - low[i]) * k);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/**
 * A very pale wash of the heat colour, for tinting the row behind a node that
 * dominates the runtime. Enough to survive being shrunk to a thumbnail,
 * faint enough not to fight the text.
 */
export function tint(share: number): string {
  const t = Math.max(0, Math.min(1, share));
  return `rgba(188, 59, 47, ${0.03 + t * 0.07})`;
}

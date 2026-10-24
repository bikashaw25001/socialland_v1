export const LIVE_LENSES = [
  { id: 'none', name: 'Original' },
  { id: 'bunny', name: 'Bunny ears' },
  { id: 'neon', name: 'Neon glasses' },
  { id: 'hearts', name: 'Heart eyes' },
  { id: 'crown', name: 'Sparkle crown' },
  { id: 'dream', name: 'Dream glow' },
] as const

export type LiveLensId = typeof LIVE_LENSES[number]['id']

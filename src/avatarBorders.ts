export type AvatarBorderEffect = 'shine' | 'pulse' | 'orbit' | 'steady' | 'flame' | 'electric' | 'prism' | 'arcane' | 'void'

export type AvatarBorderPreset = {
  id: string
  name: string
  primary: string
  secondary: string
  glow: string
  effect: AvatarBorderEffect
}

// Eight hand-picked legendary frames. The IDs stay stable so existing profiles
// that already selected one of the original frames continue to resolve.
export const AVATAR_BORDERS: AvatarBorderPreset[] = [
  { id: 'arcane-sigil', name: 'Arcane Sigil', primary: '#9b6bff', secondary: '#e3caff', glow: '#9b6bff9e', effect: 'arcane' },
  { id: 'valkyrie-crest', name: 'Valkyrie Crest', primary: '#ffc857', secondary: '#fff0ad', glow: '#ffc85799', effect: 'shine' },
  { id: 'dragonfire', name: 'Dragonfire', primary: '#ff553e', secondary: '#ffc05c', glow: '#ff432eaa', effect: 'flame' },
  { id: 'frost-warden', name: 'Frost Warden', primary: '#56dcff', secondary: '#ddfbff', glow: '#56dcff99', effect: 'pulse' },
  { id: 'neon-circuit', name: 'Neon Circuit', primary: '#5dffbb', secondary: '#d0ff70', glow: '#38ffa6a8', effect: 'electric' },
  { id: 'solar-crown', name: 'Solar Crown', primary: '#ff9c42', secondary: '#fff29c', glow: '#ff8c369e', effect: 'prism' },
  { id: 'lunar-halo', name: 'Lunar Halo', primary: '#b5baff', secondary: '#fffaff', glow: '#9c9fff99', effect: 'orbit' },
  { id: 'voidwalker', name: 'Voidwalker', primary: '#ee58d7', secondary: '#9c78ff', glow: '#d64de5a8', effect: 'void' },
]

export const AVATAR_BORDER_BY_ID = new Map(AVATAR_BORDERS.map(border => [border.id, border]))

// Profiles made with older frame collections keep showing a closest frame
// until the owner picks one of the current eight styles.
export function resolveAvatarBorder(id?: string): AvatarBorderPreset | undefined {
  if (!id) return undefined
  const exact = AVATAR_BORDER_BY_ID.get(id)
  if (exact) return exact
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return AVATAR_BORDERS[hash % AVATAR_BORDERS.length]
}

const BORDER_NAMES = [
  'Arcane Sigil', 'Valkyrie Crest', 'Dragonfire', 'Frost Warden', 'Neon Circuit', 'Solar Crown', 'Lunar Halo', 'Voidwalker',
  'Stormcaller', 'Cyber Pulse', 'Royal Crest', 'Abyssal Pearl', 'Phoenix Rise', 'Emerald Titan', 'Ruby Guard', 'Sapphire Edge',
  'Golden Relic', 'Mystic Rune', 'Shadow Flame', 'Jade Spirit', 'Thunder Core', 'Prism Shard', 'Cosmic Drift', 'Inferno Crest',
  'Glacier Crown', 'Toxic Bloom', 'Celestial Ring', 'Obsidian King', 'Aurora Veil', 'Warrior Soul', 'Eclipse Hunter', 'Mecha Knight',
  'Spirit Blossom', 'Oceanic Force', 'Solar Flare', 'Starforge', 'Blood Moon', 'Quantum Loop', 'Royal Ember', 'Crystal Guard',
  'Storm Halo', 'Night Reaper', 'Radiant Dawn', 'Mystic Tide', 'Comet Trail', 'Ancient Rune', 'Phantom Guard', 'Skybreaker',
  'Wildfire', 'Frostbite', 'Nova Burst', 'Dragon Scale', 'Moonlit Jade', 'Electric Viper', 'Rogue Galaxy', 'Golden Phoenix',
  'Deep Space', 'Blazing Tiger', 'Enchanted Rose', 'Legendary Aegis', 'Celestial Lotus',
] as const

const EFFECTS = ['shine', 'pulse', 'orbit', 'steady'] as const

export type AvatarBorderEffect = typeof EFFECTS[number]
export type AvatarBorderPreset = {
  id: string
  name: string
  primary: string
  secondary: string
  glow: string
  effect: AvatarBorderEffect
}

export const AVATAR_BORDERS: AvatarBorderPreset[] = BORDER_NAMES.map((name, index) => {
  const hue = Math.round((index * 137.508 + 18) % 360)
  const nextHue = (hue + 34 + (index % 5) * 7) % 360
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return {
    id,
    name,
    primary: `hsl(${hue} 94% 66%)`,
    secondary: `hsl(${nextHue} 100% 84%)`,
    glow: `hsl(${hue} 100% 62% / 62%)`,
    effect: EFFECTS[index % EFFECTS.length],
  }
})

export const AVATAR_BORDER_BY_ID = new Map(AVATAR_BORDERS.map(border => [border.id, border]))

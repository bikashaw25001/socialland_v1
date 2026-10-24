export type CreatureId = 'fox'|'pig'|'panda'|'wolf'|'hedgehog'|'rabbit'|'lion'|'sheep'
export type ProfileCreature = { id: CreatureId; name: string; icon: string; greeting: string; touched: string; motion: 'bounce'|'wiggle'|'peek'|'hop'|'sway'|'prance'|'waddle'|'nod' }

export const PROFILE_CREATURES: ProfileCreature[] = [
  { id:'fox', name:'Fox', icon:'🦊', greeting:'Hello! Glad you stopped by!', touched:'Hehe, that tickles!', motion:'wiggle' },
  { id:'pig', name:'Piglet', icon:'🐷', greeting:'Oink! Welcome to my page!', touched:'Oink oink! Boop!', motion:'waddle' },
  { id:'panda', name:'Panda', icon:'🐼', greeting:'Hi friend! Stay a little while!', touched:'Panda boop! You found me!', motion:'sway' },
  { id:'wolf', name:'Wolf pup', icon:'🐺', greeting:'Awooo! A happy hello for you!', touched:'Tiny howl! That was fun!', motion:'nod' },
  { id:'hedgehog', name:'Hedgehog', icon:'🦔', greeting:'A shy little hello!', touched:'Eep! I’m going to hide!', motion:'peek' },
  { id:'rabbit', name:'Bunny', icon:'🐰', greeting:'Hop in! I’m happy you’re here!', touched:'Boing! Catch me!', motion:'hop' },
  { id:'lion', name:'Lion cub', icon:'🦁', greeting:'A royal welcome, just for you!', touched:'Roar! A tiny one!', motion:'prance' },
  { id:'sheep', name:'Lamb', icon:'🐑', greeting:'Baa! Sending you a soft hello!', touched:'Baa-baa! Your turn!', motion:'bounce' },
]


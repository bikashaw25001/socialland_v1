import { useEffect, useState, type CSSProperties } from 'react'

export const PROFILE_CREATURES = [
  { id: 'cloud', name: 'Cloud Puff', fur: '#d9e9ff', belly: '#fff', accent: '#8eb7ff', ears: 'cloud', mark: '✦' },
  { id: 'fox', name: 'Foxy', fur: '#ff9d55', belly: '#fff0d8', accent: '#e66d42', ears: 'point', mark: '✦' },
  { id: 'frog', name: 'Mochi Frog', fur: '#80d79a', belly: '#ddffbd', accent: '#45ae75', ears: 'round', mark: '●' },
  { id: 'panda', name: 'Panda Bean', fur: '#f6f4ed', belly: '#fff', accent: '#34323d', ears: 'round', mark: '♥' },
  { id: 'cat', name: 'Miso Cat', fur: '#d8b8ff', belly: '#fff1f8', accent: '#9b70de', ears: 'point', mark: '✦' },
  { id: 'axolotl', name: 'Axo', fur: '#ffb5cb', belly: '#fff0f5', accent: '#ee76a1', ears: 'frill', mark: '≈' },
  { id: 'dino', name: 'Tiny Dino', fur: '#a6d96c', belly: '#f2ffcf', accent: '#69a74f', ears: 'spikes', mark: '▲' },
  { id: 'alien', name: 'Cosmo', fur: '#a7e8df', belly: '#e8fffa', accent: '#56bcb4', ears: 'antenna', mark: '✧' },
  { id: 'bee', name: 'Bumble', fur: '#ffd65e', belly: '#fff3b3', accent: '#db9d31', ears: 'round', mark: '✿' },
  { id: 'penguin', name: 'Pip Penguin', fur: '#7ea3d9', belly: '#f4fbff', accent: '#f6ae54', ears: 'round', mark: '♥' },
  { id: 'owl', name: 'Hoot', fur: '#bc8d6b', belly: '#ffe8c6', accent: '#9a674c', ears: 'tuft', mark: '✦' },
  { id: 'dragon', name: 'Noodle Dragon', fur: '#9d8bf2', belly: '#e5dcff', accent: '#6f61cf', ears: 'horn', mark: '✧' },
  { id: 'ghost', name: 'Boo Ghost', fur: '#e8e5ff', belly: '#fff', accent: '#a49be4', ears: 'ghost', mark: '♡' },
  { id: 'bear', name: 'Honey Bear', fur: '#c89163', belly: '#ffe3bd', accent: '#986242', ears: 'round', mark: '♥' },
  { id: 'rabbit', name: 'Bunny Bun', fur: '#f5d7eb', belly: '#fff3fb', accent: '#e69ac9', ears: 'long', mark: '✿' },
  { id: 'slime', name: 'Jellybean', fur: '#75dfcb', belly: '#d8fff1', accent: '#41bda4', ears: 'slime', mark: '●' },
  { id: 'octopus', name: 'Inky Octo', fur: '#e58de4', belly: '#ffe2ff', accent: '#bd61c1', ears: 'tentacle', mark: '≈' },
  { id: 'robot', name: 'Beep Bot', fur: '#aeb8c9', belly: '#edf4ff', accent: '#7486a4', ears: 'antenna', mark: '⌁' },
  { id: 'mushroom', name: 'Mushie', fur: '#f08b80', belly: '#fff1de', accent: '#bd5d62', ears: 'cap', mark: '●' },
  { id: 'bat', name: 'Batty', fur: '#8e83b9', belly: '#f2e8ff', accent: '#645985', ears: 'bat', mark: '✦' },
  { id: 'unicorn', name: 'Star Pony', fur: '#ffc6dc', belly: '#fff1fb', accent: '#b282e8', ears: 'unicorn', mark: '✧' },
  { id: 'turtle', name: 'Toby Turtle', fur: '#86c89b', belly: '#e6f5bb', accent: '#548d68', ears: 'round', mark: '✿' },
  { id: 'koala', name: 'Koala Bean', fur: '#b9c6d4', belly: '#f1f5fa', accent: '#778b9f', ears: 'fluff', mark: '♥' },
  { id: 'monkey', name: 'Banana Buddy', fur: '#d59b68', belly: '#ffe2b2', accent: '#986341', ears: 'round', mark: '✦' },
] as const

const ACTS = [
  { id: 'wave', line: 'Hi there!' }, { id: 'dance', line: 'Dance break!' }, { id: 'sleep', line: 'Zzz…' },
  { id: 'angry', line: 'Grr!' }, { id: 'bounce', line: 'Wheee!' }, { id: 'stretch', line: 'Big stretch!' },
  { id: 'laugh', line: 'Hehe!' }, { id: 'peek', line: 'Peekaboo!' },
] as const

const PERSONAL_ACTS: Record<string, { id: string; line: string }[]> = {
 cloud:[{id:'float',line:'Cloud surfing!'},{id:'sparkle',line:'Make a wish!'},{id:'wave',line:'Hi from up here!'}], fox:[{id:'sneak',line:'Sly little steps…'},{id:'tail',line:'Look at my tail!'},{id:'pounce',line:'Pounce!'}], frog:[{id:'hop',line:'Ribbit!'},{id:'tongue',line:'Snack time!'},{id:'hop',line:'Boing boing!'}], panda:[{id:'roll',line:'Panda roll!'},{id:'hug',line:'Big bear hug!'},{id:'sleep',line:'Naptime…'}], cat:[{id:'paw',line:'Paw, please!'},{id:'pounce',line:'Pounce!'},{id:'sleep',line:'Do not disturb.'}], axolotl:[{id:'swim',line:'Just keep swimming!'},{id:'bubble',line:'Bubble delivery!'},{id:'wave',line:'Hello, land friend!'}],
 dino:[{id:'stomp',line:'Tiny stomp!'},{id:'roar',line:'Raaawr!'},{id:'tail',line:'Watch my tail!'}], alien:[{id:'beam',line:'Beaming in!'},{id:'float',line:'Greetings, Earthling!'},{id:'sparkle',line:'Cosmic sparkle!'}], bee:[{id:'buzz',line:'Bzzzt! On my way!'},{id:'pollen',line:'Flower delivery!'},{id:'buzz',line:'Busy bee!'}], penguin:[{id:'waddle',line:'Waddle waddle!'},{id:'slide',line:'Ice slide!'},{id:'flap',line:'Cold out here!'}], owl:[{id:'look',line:'I see you!'},{id:'flap',line:'Night flight!'},{id:'sleep',line:'Whooo needs a nap?'}], dragon:[{id:'fire',line:'A tiny puff of fire!'},{id:'wing',line:'Dragon takeoff!'},{id:'roar',line:'Fear my tiny roar!'}],
 ghost:[{id:'float',line:'Boo! Just kidding!'},{id:'fade',line:'Now you see me…'},{id:'spook',line:'A friendly boo!'}], bear:[{id:'hug',line:'Bear hug incoming!'},{id:'paw',line:'Honey, please!'},{id:'sleep',line:'Five more minutes…'}], rabbit:[{id:'hop',line:'Hop hop hooray!'},{id:'ear',line:'Did you hear that?'},{id:'carrot',line:'Carrot break!'}], slime:[{id:'squish',line:'Squoosh!'},{id:'jiggle',line:'Wibble wobble!'},{id:'bubble',line:'Bubble mode!'}], octopus:[{id:'tentacles',line:'Eight arms, one wave!'},{id:'ink',line:'Inkredible move!'},{id:'swim',line:'Octo-dance!'}], robot:[{id:'scan',line:'Friend detected!'},{id:'glitch',line:'Beep boop, oops!'},{id:'charge',line:'Recharging…'}],
 mushroom:[{id:'spore',line:'A little mushroom magic!'},{id:'grow',line:'Growing on you!'},{id:'bounce',line:'Boing!'}], bat:[{id:'hang',line:'Upside-down hello!'},{id:'flap',line:'Night zoomies!'},{id:'echolocate',line:'Echo, echo!'}], unicorn:[{id:'sparkle',line:'Sparkle sprinkle!'},{id:'prance',line:'Royal prance!'},{id:'rainbow',line:'Rainbow incoming!'}], turtle:[{id:'shell',line:'Slow and steady!'},{id:'peek',line:'Peek from my shell!'},{id:'stomp',line:'Tiny turtle march!'}], koala:[{id:'climb',line:'Tree hug!'},{id:'hug',line:'Koala cuddle!'},{id:'sleep',line:'Eucalyptus dreams…'}], monkey:[{id:'swing',line:'Monkey business!'},{id:'banana',line:'Going bananas!'},{id:'tail',line:'Catch my tail!'}]
}
type Props = { id?: string; animated?: boolean; className?: string }
export function ProfileCreature({ id, animated = true, className = '' }: Props) {
  const model = PROFILE_CREATURES.find(item => item.id === id) || PROFILE_CREATURES[0]
  const [actIndex, setActIndex] = useState(0)
  const actions = PERSONAL_ACTS[model.id] || ACTS
  useEffect(() => {
    setActIndex(0)
    if (!animated) return
    const timer = window.setInterval(() => setActIndex(index => (index + 1) % actions.length), 2900 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) % 5) * 280)
    return () => window.clearInterval(timer)
  }, [animated, model.id, actions.length])
  const act = actions[actIndex % actions.length]
  const style = { '--creature-fur': model.fur, '--creature-belly': model.belly, '--creature-accent': model.accent } as CSSProperties
  return <div className={`profile-creature creature-model-${model.id} ${animated ? 'is-animated' : 'is-static'} ${animated ? `act-${act.id}` : ''} ${className}`} style={style} role="img" aria-label={`${model.name}${animated ? `: ${act.line}` : ''}`}>
    {animated && <><span className="creature-speech" aria-hidden="true">{act.line}</span><span className={`creature-effect effect-${act.id}`} aria-hidden="true"><i/><i/><i/></span></>}
    <span className={`creature-doll ears-${model.ears}`} aria-hidden="true">
      <i className="creature-ear ear-left"/><i className="creature-ear ear-right"/>
      <i className="creature-head"><i className="creature-eye eye-left"/><i className="creature-eye eye-right"/><i className="creature-cheek cheek-left"/><i className="creature-cheek cheek-right"/><i className="creature-mouth"/><i className="creature-mark">{model.mark}</i></i>
      <i className="creature-body"><i className="creature-belly"/><i className="creature-arm arm-left"/><i className="creature-arm arm-right"/><i className="creature-foot foot-left"/><i className="creature-foot foot-right"/></i>
      <i className="creature-tail"/><i className="creature-wings"/><i className="creature-shadow"/>
    </span>
  </div>
}


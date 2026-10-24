import { useEffect, useState, type CSSProperties } from 'react'
import { PROFILE_CREATURES } from './profileCreatureDolls'


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
type Props = { id?: string; animated?: boolean; className?: string; greet?: boolean }
export function ProfileCreature({ id, animated = true, className = '', greet = false }: Props) {
  const model = PROFILE_CREATURES.find(item => item.id === id) || PROFILE_CREATURES.find(item => item.id === 'bear') || PROFILE_CREATURES[0]
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
  const interactive = animated && className.includes('profile-cover-creature')
  const react = () => setActIndex(index => (index + 1) % actions.length)
  return <div className={`profile-creature creature-model-${model.id} ${animated ? 'is-animated' : 'is-static'} ${animated ? `act-${act.id}` : ''} ${className}`} style={style} role={interactive ? 'button' : 'img'} tabIndex={interactive ? 0 : undefined} onClick={interactive ? react : undefined} onKeyDown={interactive ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); react() } } : undefined} aria-label={`${model.name}${greet ? ' says hello' : ''}${interactive ? ', tap for a reaction' : ''}${animated ? `: ${act.line}` : ''}`}>
    {animated && <><span className="creature-speech" aria-hidden="true">{act.line}</span><span className={`creature-effect effect-${act.id}`} aria-hidden="true"><i/><i/><i/></span></>}
    <span className={`creature-doll ears-${model.ears}`} aria-hidden="true">
      <i className="creature-ear ear-left"/><i className="creature-ear ear-right"/>
      <i className="creature-head"><i className="creature-eye eye-left"/><i className="creature-eye eye-right"/><i className="creature-cheek cheek-left"/><i className="creature-cheek cheek-right"/><i className="creature-mouth"/><i className="creature-mark">{model.mark}</i></i>
      <i className="creature-body"><i className="creature-belly"/><i className="creature-arm arm-left"/><i className="creature-arm arm-right"/><i className="creature-foot foot-left"/><i className="creature-foot foot-right"/></i>
      <i className="creature-tail"/><i className="creature-wings"/><i className="creature-shadow"/>
    </span>
  </div>
}


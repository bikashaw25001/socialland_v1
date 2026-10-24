import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { PROFILE_CREATURES } from './profileCreatureDolls'
import { getCreatureThoughts } from './profileCreatureThoughts'


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
type Props = { id?: string; animated?: boolean; className?: string; greet?: boolean; ownerId?: string; canDrag?: boolean; savedPosition?: Position; onPositionChange?: (position: Position) => void }
type Position = { x: number; y: number }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const MOOD_MOVES = [
  { id: 'curious' }, { id: 'sleep' }, { id: 'wave' }, { id: 'fall' }, { id: 'recover' },
  { id: 'angry' }, { id: 'laugh' }, { id: 'shy' }, { id: 'excited' }, { id: 'dizzy' },
  { id: 'stretch' }, { id: 'dance' }, { id: 'peek' }, { id: 'bounce' }, { id: 'hop' }, { id: 'hide' }, { id: 'cheer' },
]

export function ProfileCreature({ id, animated = true, className = '', greet = false, ownerId, canDrag = false, savedPosition, onPositionChange }: Props) {
  const model = PROFILE_CREATURES.find(item => item.id === id) || PROFILE_CREATURES.find(item => item.id === 'bear') || PROFILE_CREATURES[0]
  const [actIndex, setActIndex] = useState(0)
  const [thoughtIndex, setThoughtIndex] = useState(0)
  const thoughtLines = getCreatureThoughts(model.id)
  const personalMoves = PERSONAL_ACTS[model.id] || ACTS
  const actions = [...personalMoves, ...MOOD_MOVES]
  const storageKey = `social-land-creature-position:${ownerId || model.id}`
  const [position, setPosition] = useState<Position>(() => {
    if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) return { x: clamp(savedPosition.x, 4, 96), y: clamp(savedPosition.y, 0, 70) }
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: clamp(saved.x, 4, 96), y: clamp(saved.y, 0, 70) } } catch { /* use the default position */ }
    return { x: 8, y: 0 }
  })
  const positionRef = useRef(position)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragPointer = useRef<number | null>(null)
  const dragStart = useRef<{ x: number; y: number; position: Position } | null>(null)
  const didDrag = useRef(false)
  const direction = useRef(1)
  const [dragging, setDragging] = useState(false)
  const bannerBounds = () => {
    const root = rootRef.current
    const banner = root?.parentElement
    if (!root || !banner) return { minX: 4, maxX: 96, maxY: 70 }
    const bannerRect = banner.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const edgeX = Math.min(48, rootRect.width / bannerRect.width * 50)
    return { minX: edgeX, maxX: 100 - edgeX, maxY: Math.max(0, 100 - rootRect.height / bannerRect.height * 100) }
  }
  useEffect(() => {
    const root = rootRef.current
    const banner = root?.parentElement
    if (!root || !banner) return
    const fitToBanner = () => {
      const bounds = bannerBounds()
      setPosition(current => {
        const next = { x: clamp(current.x, bounds.minX, bounds.maxX), y: clamp(current.y, 0, bounds.maxY) }
        positionRef.current = next
        return next
      })
    }
    fitToBanner()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitToBanner)
    observer?.observe(banner)
    window.addEventListener('resize', fitToBanner)
    return () => { observer?.disconnect(); window.removeEventListener('resize', fitToBanner) }
  }, [ownerId])
  useEffect(() => {
    setActIndex(0)
    if (!animated) return
    const moveTimer = window.setInterval(() => setActIndex(index => (index + 1) % actions.length), 1750 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) % 5) * 190)
    const thoughtTimer = window.setInterval(() => setThoughtIndex(index => (index + 1) % thoughtLines.length), 3600 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) % 6) * 430)
    const roamTimer = window.setInterval(() => {
      if (dragPointer.current !== null) return
      const bounds = bannerBounds()
      setPosition(current => {
        const nextX = current.x + direction.current * (8 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) % 4) * 2)
        if (nextX > bounds.maxX || nextX < bounds.minX) direction.current *= -1
        const hopHeight = Math.min(bounds.maxY, 8 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) % 3) * 5)
        const next = { x: clamp(nextX, bounds.minX, bounds.maxX), y: current.y === 0 ? hopHeight : 0 }
        positionRef.current = next
        return next
      })
    }, 4800 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) % 5) * 650)
    return () => { window.clearInterval(moveTimer); window.clearInterval(thoughtTimer); window.clearInterval(roamTimer) }
  }, [animated, model.id, actions.length, thoughtLines.length])
  const act = actions[actIndex % actions.length]
  const style = { '--creature-fur': model.fur, '--creature-belly': model.belly, '--creature-accent': model.accent, '--creature-banner-left': `${position.x}%`, '--creature-banner-bottom': `${position.y}%` } as CSSProperties
  const interactive = animated && className.includes('profile-cover-creature')
  const react = () => { setActIndex(index => (index + 1) % actions.length); setThoughtIndex(index => (index + 1) % thoughtLines.length) }
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || !canDrag || (event.pointerType === 'mouse' && event.button !== 0)) return
    event.preventDefault(); event.stopPropagation()
    dragPointer.current = event.pointerId
    dragStart.current = { x: event.clientX, y: event.clientY, position: positionRef.current }
    didDrag.current = false
    event.currentTarget.setPointerCapture(event.pointerId); setDragging(true)
  }
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || dragPointer.current !== event.pointerId) return
    if (dragStart.current && Math.hypot(event.clientX - dragStart.current.x, event.clientY - dragStart.current.y) > 4) didDrag.current = true
    const banner = event.currentTarget.parentElement
    if (!banner) return
    const rect = banner.getBoundingClientRect()
    const bounds = bannerBounds()
    const grab = dragStart.current
    if (!grab) return
    const deltaX = (event.clientX - grab.x) / rect.width * 100
    const deltaY = (grab.y - event.clientY) / rect.height * 100
    const next = { x: clamp(grab.position.x + deltaX, bounds.minX, bounds.maxX), y: clamp(grab.position.y + deltaY, 0, bounds.maxY) }
    positionRef.current = next
    setPosition(next)
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPointer.current !== event.pointerId) return
    if (didDrag.current) {
      try { localStorage.setItem(storageKey, JSON.stringify(positionRef.current)) } catch { /* position remains in memory */ }
      onPositionChange?.(positionRef.current)
    }
    dragPointer.current = null; dragStart.current = null; setDragging(false)
  }
  const thought = greet && thoughtIndex === 0 ? `${model.name} says hello!` : thoughtLines[thoughtIndex % thoughtLines.length]
  return <div ref={rootRef} className={`profile-creature creature-model-${model.id} ${animated ? 'is-animated' : 'is-static'} ${animated ? `act-${act.id}` : ''} ${dragging ? 'is-dragging' : ''} ${className}`} style={style} role={interactive ? 'button' : 'img'} tabIndex={interactive ? 0 : undefined} onPointerDown={canDrag ? startDrag : undefined} onPointerMove={canDrag ? moveDrag : undefined} onPointerUp={canDrag ? endDrag : undefined} onPointerCancel={canDrag ? endDrag : undefined} onClick={interactive ? () => { if (didDrag.current) { didDrag.current = false; return } react() } : undefined} onKeyDown={interactive ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); react() } } : undefined} aria-label={`${model.name}${interactive ? canDrag ? ', drag to move or tap for a reaction' : ', tap for a reaction' : ''}${animated ? `: ${thought}` : ''}`}>
    {animated && <><span className="creature-speech" aria-hidden="true">{thought}</span><span className={`creature-effect effect-${act.id}`} aria-hidden="true"><i/><i/><i/></span></>}
    <span className={`creature-doll ears-${model.ears}`} aria-hidden="true">
      <i className="creature-ear ear-left"/><i className="creature-ear ear-right"/>
      <i className="creature-head"><i className="creature-eye eye-left"/><i className="creature-eye eye-right"/><i className="creature-cheek cheek-left"/><i className="creature-cheek cheek-right"/><i className="creature-mouth"/><i className="creature-mark">{model.mark}</i></i>
      <i className="creature-body"><i className="creature-belly"/><i className="creature-arm arm-left"/><i className="creature-arm arm-right"/><i className="creature-foot foot-left"/><i className="creature-foot foot-right"/></i>
      <i className="creature-tail"/><i className="creature-wings"/><i className="creature-shadow"/>
    </span>
  </div>
}


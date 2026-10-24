import { useEffect, useRef, useState } from 'react'
import { PROFILE_CREATURES } from './profileCreatures'

type Props = { id?: string; className?: string; greet?: boolean }

export function ProfileCreatureImage({ id, className = '', greet = false }: Props) {
  const creature = PROFILE_CREATURES.find(item => item.id === id) || PROFILE_CREATURES[0]
  const [message, setMessage] = useState(greet ? creature.greeting : '')
  const [hidden, setHidden] = useState(false)
  const [reaction, setReaction] = useState(0)
  const messageTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)
  const reactionTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (messageTimer.current) window.clearTimeout(messageTimer.current)
    setMessage(greet ? creature.greeting : '')
    if (greet) messageTimer.current = window.setTimeout(() => setMessage(''), 5200)
    return () => { if (messageTimer.current) window.clearTimeout(messageTimer.current); if (reactionTimer.current) window.clearTimeout(reactionTimer.current) }
  }, [creature.id, creature.greeting, greet])

  useEffect(() => {
    let timer = 0
    let cancelled = false
    const planHide = () => {
      timer = window.setTimeout(() => {
        if (cancelled) return
        setHidden(true)
        hideTimer.current = window.setTimeout(() => {
          if (cancelled) return
          setHidden(false)
          timer = window.setTimeout(planHide, 9000 + Math.random() * 12000)
        }, 1300 + Math.random() * 900)
      }, 14000 + Math.random() * 18000)
    }
    planHide()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [creature.id])

  const showMessage = (text: string) => {
    if (messageTimer.current) window.clearTimeout(messageTimer.current)
    setMessage(text)
    messageTimer.current = window.setTimeout(() => setMessage(''), 2600)
  }

  const onTouch = () => {
    setReaction(value => value + 1)
    setHidden(false)
    showMessage(creature.touched)
    if (creature.motion === 'peek') {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
      if (reactionTimer.current) window.clearTimeout(reactionTimer.current)
      hideTimer.current = window.setTimeout(() => setHidden(true), 450)
      reactionTimer.current = window.setTimeout(() => setHidden(false), 1900)
    }
  }

  return <div className={`profile-cover-creature ${className}`}>
    {message && !hidden && <span className="profile-creature-greeting" aria-live="polite">{message}</span>}
    <button type="button" className={`profile-creature-sprite motion-${creature.motion}${hidden ? ' is-hidden' : ''}`} onClick={onTouch} aria-label={`Say hello to ${creature.name}`} title={`Tap ${creature.name}`}>
      <img key={creature.id} src={`/models/profile-animals/${creature.id}.png`} alt={creature.name} draggable={false}/>
      <span key={reaction} className="profile-creature-tap-effect" aria-hidden="true">✦</span>
    </button>
  </div>
}


import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { PROFILE_CREATURES, type CreatureBehavior } from './profileCreatures'

const actionName = (behavior: CreatureBehavior, action: string) => {
  if (behavior === 'dragon') return action === 'walk' ? 'Walk-loop' : action === 'attack' ? 'Flying-loop' : action === 'dead' ? 'Idle-loop' : 'Idle-loop'
  return action
}

const routine = [
  { id:'walk', duration:4.8 }, { id:'stand', duration:3.1 },
  { id:'sleep', duration:5.2 }, { id:'wake', duration:1.8 },
  { id:'walk', duration:4.2 }, { id:'fall', duration:1.5 },
  { id:'recover', duration:1.7 }, { id:'angry', duration:1.8 },
  { id:'dance', duration:3.4 },
  { id:'greet', duration:2.6 },
] as const
const cycleDuration = routine.reduce((total, step) => total + step.duration, 0)
const getRoutineStep = (seconds: number) => {
  let cursor = seconds % cycleDuration
  for (const step of routine) {
    if (cursor < step.duration) return { ...step, progress: cursor / step.duration }
    cursor -= step.duration
  }
  return { ...routine[0], progress: 0 }
}

type Props = { id?: string; animated?: boolean; className?: string; greet?: boolean }
export function ProfileCreature({ id, animated = true, className = '', greet = false }: Props) {
  const model = PROFILE_CREATURES.find(item => item.id === id) || PROFILE_CREATURES[3]
  const canvasRef = useRef<HTMLCanvasElement|null>(null)
  const reactUntilRef = useRef(0)
  const bubbleTimerRef = useRef<number | undefined>(undefined)
  const [greetingVisible, setGreetingVisible] = useState(false)
  const [bubbleText, setBubbleText] = useState(model.greeting)
  const [specialEffect, setSpecialEffect] = useState('')
  const [reactionTick, setReactionTick] = useState(0)

  useEffect(() => {
    if (!greet) { setGreetingVisible(false); return }
    setBubbleText(model.greeting)
    setGreetingVisible(true)
    const timer = window.setTimeout(() => setGreetingVisible(false), 5200)
    return () => window.clearTimeout(timer)
  }, [greet, model.id, model.greeting])

  useEffect(() => () => { if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current) }, [])

  const react = useCallback(() => {
    reactUntilRef.current = performance.now() + 1750
    setReactionTick(value => value + 1)
    setBubbleText(model.reaction)
    setGreetingVisible(true)
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current)
    bubbleTimerRef.current = window.setTimeout(() => setGreetingVisible(false), 2300)
  }, [model.reaction])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let frame = 0
    let resizeObserver: ResizeObserver | undefined
    let renderer: THREE.WebGLRenderer | undefined
    let mixer: THREE.AnimationMixer | undefined
    let actions: Record<string, THREE.AnimationAction> = {}
    let currentAction: THREE.AnimationAction | undefined
    let previousFrame = 0
    let activeStep = ''
    let wasReacting = false
    let startTime = 0
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-4, 4, 2.8, -2.8, 0.1, 60)
    camera.position.set(0, 2.1, 10)
    camera.lookAt(0, .8, 0)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x696078, 2.15))
    const keyLight = new THREE.DirectionalLight(0xfff3df, 3.2)
    keyLight.position.set(-3, 7, 5)
    scene.add(keyLight)
    const rimLight = new THREE.DirectionalLight(0x9fb8ff, 1.5)
    rimLight.position.set(3, 3, -4)
    scene.add(rimLight)
    try {
      renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true, powerPreference:'low-power'})
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.setClearColor(0x000000, 0)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
    } catch {
      setSpecialEffect('fallback')
      return
    }
    const resize = () => {
      if (!renderer) return
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight)
      renderer.setSize(width, height, false)
      const aspect = width / height, vertical = 2.8
      camera.left = -vertical * aspect / 2; camera.right = vertical * aspect / 2
      camera.top = vertical / 2; camera.bottom = -vertical / 2
      camera.updateProjectionMatrix()
    }
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    resize()
    const loader = new GLTFLoader()
    void loader.loadAsync(`/models/creatures/${model.id}.glb`).then(gltf => {
      if (disposed) return
      const motionRoot = new THREE.Group()
      const creature = gltf.scene
      const bounds = new THREE.Box3().setFromObject(creature)
      const size = bounds.getSize(new THREE.Vector3())
      const scale = 1.95 / Math.max(.01, size.y)
      creature.scale.setScalar(scale)
      creature.position.y = -bounds.min.y * scale
      motionRoot.add(creature)
      scene.add(motionRoot)
      mixer = new THREE.AnimationMixer(creature)
      const clipList = gltf.animations
      const findClip = (name: string) => clipList.find(clip => clip.name.toLowerCase() === name.toLowerCase()) || clipList.find(clip => clip.name.toLowerCase().includes(name.toLowerCase()))
      actions = Object.fromEntries(['idle','walk','attack','dead','Idle-loop','Walk-loop','Flying-loop','Run-loop'].map(name => {
        const clip = findClip(name)
        return [name, clip && mixer ? mixer.clipAction(clip) : undefined]
      }).filter((item): item is [string, THREE.AnimationAction] => !!item[1]))
      startTime = performance.now()
      const play = (name: string) => {
        const action = actions[name] || actions.idle || Object.values(actions)[0]
        if (!action || currentAction === action) return
        action.reset()
        action.setLoop(name.toLowerCase().includes('dead') ? THREE.LoopOnce : THREE.LoopRepeat, name.toLowerCase().includes('dead') ? 1 : Infinity)
        action.clampWhenFinished = name.toLowerCase().includes('dead')
        action.fadeIn(.25).play()
        currentAction?.fadeOut(.22)
        currentAction = action
      }
      const playStep = (step: string) => {
        const clip = step === 'walk' ? 'walk' : step === 'sleep' || step === 'fall' ? 'dead' : step === 'stand' || step === 'wake' || step === 'recover' ? 'idle' : 'attack'
        play(actionName(model.behavior, clip))
      }
      let lastGreetingCycle = -1
      let lastStep = getRoutineStep(0)
      playStep(lastStep.id)
      const tick = (now: number) => {
        if (disposed || !renderer) return
        frame = requestAnimationFrame(tick)
        const elapsed = (now - startTime) / 1000
        const phase = elapsed + (PROFILE_CREATURES.findIndex(item => item.id === model.id) * 1.37)
        const step = getRoutineStep(phase)
        const reacting = now < reactUntilRef.current
        if (step.id !== activeStep) {
          activeStep = step.id
          lastStep = step
          if (!reacting) playStep(step.id)
          const effect = step.id === 'sleep' ? 'sleep' : step.id === 'fall' ? model.behavior === 'stomp' ? 'dust' : 'fall' : step.id === 'angry' ? 'angry' : step.id === 'dance' ? model.behavior === 'bee' ? 'sparkle' : 'dance' : model.behavior === 'dragon' && step.id === 'greet' ? 'fire' : ''
          setSpecialEffect(effect)
        }
        if (reacting && !wasReacting) playStep('greet')
        if (!reacting && wasReacting) playStep(lastStep.id)
        wasReacting = reacting
        const greetingCycle = Math.floor(phase / cycleDuration)
        if (greet && step.id === 'greet' && greetingCycle !== lastGreetingCycle) {
          lastGreetingCycle = greetingCycle
          setBubbleText(model.greeting)
          setGreetingVisible(true)
          window.setTimeout(() => { if (!disposed) setGreetingVisible(false) }, 1900)
        }
        const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
        const worldWidth = 2.8 * aspect
        const edge = Math.max(.3, worldWidth / 2 - .62)
        const travel = elapsed * .24 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) * .31)
        if (step.id === 'walk') motionRoot.position.x = Math.sin(travel) * edge
        canvas.parentElement?.style.setProperty('--creature-x', `${((motionRoot.position.x + edge) / (edge * 2)) * 100}%`)
        const velocity = Math.cos(travel)
        motionRoot.rotation.y = velocity >= 0 ? 0 : Math.PI
        const progress = step.progress
        motionRoot.rotation.z = step.id === 'sleep' ? 1.25 + Math.sin(elapsed * .75) * .025 : step.id === 'fall' ? Math.min(1.25, progress * 5) : step.id === 'recover' ? 1.25 * (1 - progress) : 0
        if (step.id === 'sleep' || step.id === 'fall') motionRoot.position.y = .015
        else if (step.id === 'recover') motionRoot.position.y = Math.sin(progress * Math.PI) * .18
        else if (model.behavior === 'hop') motionRoot.position.y = Math.max(0, Math.sin(elapsed * 5.3)) * .21
        else if (model.behavior === 'bee' || model.behavior === 'fly') motionRoot.position.y = .1 + Math.sin(elapsed * (model.behavior === 'bee' ? 8 : 2.8)) * (model.behavior === 'bee' ? .12 : .3)
        else if (step.id === 'dance') motionRoot.position.y = Math.max(0, Math.sin(elapsed * 7)) * .14
        else motionRoot.position.y = Math.sin(elapsed * 2.2) * .035
        if (reacting || step.id === 'angry') motionRoot.rotation.z += Math.sin(now * .045) * (reacting ? .09 : .055)
        if (mixer) { const delta = previousFrame ? Math.min(.05, Math.max(0, (now - previousFrame) / 1000)) : .016; mixer.update(animated ? delta : 0); previousFrame = now }
        renderer.render(scene, camera)
      }
      frame = requestAnimationFrame(tick)
    }).catch(() => { if (!disposed) setSpecialEffect('fallback') })
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mixer?.stopAllAction()
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(material => material.dispose()) }
      })
      renderer?.dispose()
    }
  }, [model.id, model.behavior, model.moves, animated, greet, model.greeting])

  return <div className={`profile-creature-3d ${className} behavior-${model.behavior}`}>
    <canvas ref={canvasRef} className="profile-creature-canvas" aria-hidden="true"/>
    <button key={reactionTick} type="button" className={`profile-creature-hitbox${reactionTick ? ' reacting' : ''}`} onClick={react} aria-label={`React to ${model.name}`} title={`Say hello to ${model.name}`}/>
    {greetingVisible && <span className="profile-creature-greeting" aria-live="polite">{bubbleText}</span>}
    {specialEffect === 'fire' && <span className="profile-creature-fire" aria-hidden="true"><i/><i/><i/></span>}
    {specialEffect === 'sleep' && <span className="profile-creature-activity" aria-hidden="true">Zzz</span>}
    {specialEffect === 'fall' && <span className="profile-creature-activity fall" aria-hidden="true">Oops!</span>}
    {specialEffect === 'angry' && <span className="profile-creature-activity angry" aria-hidden="true">Grr!</span>}
    {specialEffect === 'dance' && <span className="profile-creature-activity dance" aria-hidden="true">✦</span>}
    {specialEffect === 'dust' && <span className="profile-creature-dust" aria-hidden="true">✦</span>}
    {specialEffect === 'sparkle' && <span className="profile-creature-sparkle" aria-hidden="true">✦</span>}
    {specialEffect === 'fallback' && <span className="profile-creature-fallback" aria-hidden="true">{model.icon}</span>}
  </div>
}


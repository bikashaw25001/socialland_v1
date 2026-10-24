import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { PROFILE_CREATURES, type CreatureBehavior } from './profileCreatures'

const actionName = (behavior: CreatureBehavior, action: string) => {
  if (behavior === 'dragon') return action === 'walk' ? 'Walk-loop' : action === 'attack' ? 'Flying-loop' : 'Idle-loop'
  return action
}

type Props = { id?: string; animated?: boolean; className?: string; greet?: boolean }
export function ProfileCreature({ id, animated = true, className = '', greet = false }: Props) {
  const model = PROFILE_CREATURES.find(item => item.id === id) || PROFILE_CREATURES[3]
  const canvasRef = useRef<HTMLCanvasElement|null>(null)
  const [greetingVisible, setGreetingVisible] = useState(false)
  const [specialEffect, setSpecialEffect] = useState('')

  useEffect(() => {
    if (!greet) { setGreetingVisible(false); return }
    setGreetingVisible(true)
    const timer = window.setTimeout(() => setGreetingVisible(false), 5200)
    return () => window.clearTimeout(timer)
  }, [greet, model.id])

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
    let activeStage = -1
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
      actions = Object.fromEntries(['idle','walk','attack','Idle-loop','Walk-loop','Flying-loop','Run-loop'].map(name => {
        const clip = findClip(name)
        return [name, clip && mixer ? mixer.clipAction(clip) : undefined]
      }).filter((item): item is [string, THREE.AnimationAction] => !!item[1]))
      startTime = performance.now()
      const play = (name: string) => {
        const action = actions[name] || actions.idle || Object.values(actions)[0]
        if (!action || currentAction === action) return
        action.reset().fadeIn(.3).play()
        currentAction?.fadeOut(.25)
        currentAction = action
      }
      play(actionName(model.behavior, 'idle'))
      let lastBubble = -1
      const tick = (now: number) => {
        if (disposed || !renderer) return
        frame = requestAnimationFrame(tick)
        const elapsed = (now - startTime) / 1000
        const stage = Math.floor(elapsed / 3.7)
        if (stage !== activeStage) {
          activeStage = stage
          const planned = model.moves[stage % model.moves.length]
          const chosen = greet && elapsed < 5.2 ? actionName(model.behavior, 'attack') : actionName(model.behavior, planned)
          play(chosen)
          setSpecialEffect(model.behavior === 'dragon' && (elapsed < 4.2 || stage % 4 === 2) ? 'fire' : model.behavior === 'bee' && stage % 3 === 1 ? 'sparkle' : model.behavior === 'stomp' && stage % 3 === 1 ? 'dust' : '')
          if (greet && stage !== lastBubble && (stage === 0 || stage % 3 === 0)) { lastBubble = stage; setGreetingVisible(true); window.setTimeout(() => { if (!disposed) setGreetingVisible(false) }, stage === 0 ? 5200 : 1900) }
        }
        const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
        const worldWidth = 2.8 * aspect
        const edge = Math.max(.3, worldWidth / 2 - .62)
        const travel = elapsed * .22 + (PROFILE_CREATURES.findIndex(item => item.id === model.id) * .31)
        motionRoot.position.x = Math.sin(travel) * edge
        canvas.parentElement?.style.setProperty('--creature-x', `${((motionRoot.position.x + edge) / (edge * 2)) * 100}%`)
        const velocity = Math.cos(travel)
        motionRoot.rotation.y = greet && elapsed < 4.6 ? 0 : velocity >= 0 ? Math.PI / 2 : -Math.PI / 2
        if (model.behavior === 'hop') motionRoot.position.y = Math.max(0, Math.sin(elapsed * 5.3)) * .21
        else if (model.behavior === 'bee' || model.behavior === 'fly') motionRoot.position.y = .1 + Math.sin(elapsed * (model.behavior === 'bee' ? 8 : 2.8)) * (model.behavior === 'bee' ? .12 : .3)
        else if (model.behavior === 'stomp' && activeStage % 3 === 1) motionRoot.position.y = Math.max(0, Math.sin(elapsed * 7)) * .11
        else motionRoot.position.y = Math.sin(elapsed * 2.2) * .035
        if (mixer) { const delta = previousFrame ? Math.min(.05, Math.max(0, (now - previousFrame) / 1000)) : .016; mixer.update(delta); previousFrame = now }
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
  }, [model.id, model.behavior, model.moves, animated, greet])

  return <div className={`profile-creature-3d ${className} behavior-${model.behavior}`} role="img" aria-label={`${model.name}${greet ? ` greets you: ${model.greeting}` : ''}`}>
    <canvas ref={canvasRef} className="profile-creature-canvas" aria-hidden="true"/>
    {greetingVisible && <span className="profile-creature-greeting" aria-hidden="true">{model.greeting}</span>}
    {specialEffect === 'fire' && <span className="profile-creature-fire" aria-hidden="true"><i/><i/><i/></span>}
    {specialEffect === 'dust' && <span className="profile-creature-dust" aria-hidden="true">?</span>}
    {specialEffect === 'sparkle' && <span className="profile-creature-sparkle" aria-hidden="true">?</span>}
    {specialEffect === 'fallback' && <span className="profile-creature-fallback" aria-hidden="true">{model.icon}</span>}
  </div>
}







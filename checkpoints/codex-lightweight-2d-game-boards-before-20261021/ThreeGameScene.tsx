import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

type GameKind = 'chess' | 'ludo' | 'tic-tac-toe'
type SceneSession = { board: unknown; turn: number; playerIds: string[]; lastRoll?: number | null; lastRollBy?: string | null; status: string }

export default function ThreeGameScene({ game, session, userId, names, selected, onSelect, onMove, onPieceMove, onPlace, onRoll, onReady }: {
  game: GameKind; session: SceneSession; userId: string; names: string[]; selected: number | null
  onSelect: (square: number | null) => void; onMove: (from: number, to: number) => void; onPieceMove: (piece: number) => void
  onPlace: (index: number) => void; onRoll: () => void; onReady: () => void
}) {
  const [graphicsError, setGraphicsError] = useState(false)
  const [sceneReady, setSceneReady] = useState(false)
  const mount = useRef<HTMLDivElement>(null)
  const orbit = useRef({ game, radius: game === 'ludo' ? 22 : game === 'chess' ? 13 : 11, theta: game === 'ludo' ? 0.1 : Math.PI / 4, phi: 0.87 })
  const zoomScale = useRef(1)
  const api = useRef({ game, session, userId, names, selected, onSelect, onMove, onPieceMove, onPlace, onRoll, onReady })
  api.current = { game, session, userId, names, selected, onSelect, onMove, onPieceMove, onPlace, onRoll, onReady }

  useEffect(() => {
    const host = mount.current
    if (!host) return
    const hostElement = host
    let disposed = false
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#111522')
    scene.fog = new THREE.Fog('#111522', 19, 37)
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    if (orbit.current.game !== game) { orbit.current.game = game; orbit.current.radius = game === 'ludo' ? 22 : game === 'chess' ? 13 : 11; orbit.current.theta = game === 'ludo' ? 0.1 : Math.PI / 4; zoomScale.current = 1 }
    let { radius, theta, phi } = orbit.current
    const aim = new THREE.Vector3(0, 0, 0)
    const updateCamera = () => {
      phi = THREE.MathUtils.clamp(phi, 0.35, 1.3)
      camera.position.set(radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.cos(theta))
      camera.lookAt(aim)
      orbit.current = { game, radius, theta, phi }
    }
    updateCamera()
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: window.matchMedia('(max-width: 700px)').matches ? 'low-power' : 'high-performance' }) }
    catch { setGraphicsError(true); return }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    host.prepend(renderer.domElement)
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D game board. Drag to rotate, scroll or pinch to zoom.')

    scene.add(new THREE.HemisphereLight('#e0edff', '#252032', 2.05))
    const keyLight = new THREE.DirectionalLight('#fff0d0', 4.4)
    keyLight.position.set(-5, 12, 7); keyLight.castShadow = true
    keyLight.shadow.mapSize.set(1024, 1024)
    keyLight.shadow.camera.left = -12; keyLight.shadow.camera.right = 12; keyLight.shadow.camera.top = 12; keyLight.shadow.camera.bottom = -12
    scene.add(keyLight)
    const rim = new THREE.PointLight('#718dff', 24, 24); rim.position.set(7, 5, -5); scene.add(rim)
    const fill = new THREE.PointLight('#ffad7a', 14, 22); fill.position.set(-7, 3, 5); scene.add(fill)

    const mat = (color: string, roughness = 0.48, metalness = 0.05) => new THREE.MeshStandardMaterial({ color, roughness, metalness })
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), mat('#171a26', 0.92)); floor.rotation.x = -Math.PI / 2; floor.position.y = -1.05; floor.receiveShadow = true; scene.add(floor)
    const table = new THREE.Mesh(new THREE.CylinderGeometry(8.3, 8.7, 0.45, 96), mat('#22202c', 0.32, 0.28)); table.position.y = -0.6; table.receiveShadow = true; table.castShadow = true; scene.add(table)
    const trim = new THREE.Mesh(new THREE.CylinderGeometry(8.31, 8.31, 0.09, 96), mat('#a88753', 0.24, 0.72)); trim.position.y = -0.35; scene.add(trim)
    const boardRoot = new THREE.Group(); scene.add(boardRoot)
    const interactive: THREE.Object3D[] = []
    const squareMaterial = (color: string, roughness = 0.52) => mat(color, roughness, 0.04)
    const addBox = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number], cast = true) => {
      const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position); mesh.castShadow = cast; mesh.receiveShadow = true; parent.add(mesh); return mesh
    }
    const bevelTile = (parent: THREE.Object3D, x: number, z: number, color: string, size: number, y = 0) => {
      const tile = addBox(parent, new THREE.BoxGeometry(size, 0.18, size), squareMaterial(color), [x, y, z])
      tile.userData.square = true; interactive.push(tile); return tile
    }
    const addPiece = (parent: THREE.Object3D, x: number, z: number, isWhite: boolean, kind: string) => {
      const group = new THREE.Group(); group.position.set(x, 0.12, z); parent.add(group)
      const pieceMat = mat(isWhite ? '#f5ead4' : '#292633', isWhite ? 0.24 : 0.28, isWhite ? 0.38 : 0.24)
      const gold = mat(isWhite ? '#c3a367' : '#89778f', 0.25, 0.6)
      const cylinder = (r1: number, r2: number, h: number, y: number, material = pieceMat, segments = 32) => {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, segments), material); mesh.position.y = y; mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh)
      }
      cylinder(0.35, 0.38, 0.12, 0.07, gold); cylinder(0.24, 0.3, 0.15, 0.2); cylinder(0.3, 0.24, 0.08, 0.32, gold)
      if (kind === 'p') { cylinder(0.12, 0.17, 0.22, 0.47); const orb = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), pieceMat); orb.position.y = 0.66; orb.castShadow = true; group.add(orb) }
      else if (kind === 'r') { cylinder(0.2, 0.17, 0.38, 0.54); cylinder(0.24, 0.24, 0.12, 0.78, gold); cylinder(0.21, 0.22, 0.1, 0.88) }
      else if (kind === 'n') { const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 5), pieceMat); head.position.set(0, 0.65, -0.02); head.rotation.x = 0.28; head.castShadow = true; group.add(head); const crest = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), gold); crest.position.set(0, 0.94, -0.06); group.add(crest) }
      else if (kind === 'b') { cylinder(0.15, 0.2, 0.28, 0.48); const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.48, 32), pieceMat); cone.position.y = 0.84; cone.castShadow = true; group.add(cone); const orb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), gold); orb.position.y = 1.11; group.add(orb) }
      else if (kind === 'q' || kind === 'k') { cylinder(0.17, 0.22, 0.44, 0.58); const crown = new THREE.Mesh(new THREE.SphereGeometry(0.23, 24, 14), pieceMat); crown.scale.y = 0.58; crown.position.y = 0.9; crown.castShadow = true; group.add(crown); cylinder(0.28, 0.25, 0.1, 1.08, gold); if (kind === 'k') { const bar1 = addBox(group, new THREE.BoxGeometry(0.08, 0.42, 0.08), gold, [0, 1.38, 0]); const bar2 = addBox(group, new THREE.BoxGeometry(0.28, 0.07, 0.08), gold, [0, 1.42, 0]); bar1.castShadow = bar2.castShadow = true } else for (let i = 0; i < 5; i++) { const jewel = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), gold); const a = i * Math.PI * 2 / 5; jewel.position.set(Math.cos(a) * 0.2, 1.25, Math.sin(a) * 0.2); group.add(jewel) } }
      else { cylinder(0.14, 0.22, 0.55, 0.61); const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 12), gold); ball.position.y = 0.96; group.add(ball) }
    }

    if (api.current.game === 'chess') {
      const back = addBox(boardRoot, new THREE.BoxGeometry(8.55, 0.34, 8.55), mat('#171722', 0.24, 0.58), [0, -0.07, 0]); back.castShadow = true
      const board = String(api.current.session.board || '').split('/').flatMap(row => [...row].flatMap(char => /^[1-8]$/.test(char) ? Array(Number(char)).fill('') : char))
      const pieces = board.length === 64 ? board : [...'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR']
      const current = api.current.session
      const flipped = current.playerIds.indexOf(api.current.userId) === 1
      for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
        const square = flipped ? 63 - (row * 8 + col) : row * 8 + col, x = col - 3.5, z = row - 3.5
        const tile = bevelTile(boardRoot, x, z, (row + col) % 2 ? '#514658' : '#d8c7a7', 0.98, 0.13)
        tile.userData.index = square
        if (api.current.selected === square) { tile.material = squareMaterial('#c7a74e'); tile.material.needsUpdate = true }
        const piece = pieces[square]; if (piece) addPiece(boardRoot, x, z, piece === piece.toUpperCase(), piece.toLowerCase())
      }
      for (let i = 0; i < 4; i++) { const edge = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.08, 0.08), mat('#b99b64', 0.25, 0.65)); edge.position.set(0, 0.2, i < 2 ? -4.33 : 4.33); boardRoot.add(edge); const side = edge.clone(); side.geometry = new THREE.BoxGeometry(0.08, 0.08, 8.8); side.position.set(i === 2 ? -4.33 : 4.33, 0.2, 0); boardRoot.add(side) }
      boardRoot.userData.turn = current.turn
    } else if (api.current.game === 'tic-tac-toe') {
      addBox(boardRoot, new THREE.BoxGeometry(6.2, 0.3, 6.2), mat('#262431', 0.24, 0.28), [0, 0, 0])
      const values = Array.isArray(api.current.session.board) ? api.current.session.board as (string | null)[] : Array(9).fill(null)
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
        const index = row * 3 + col, x = (col - 1) * 2, z = (row - 1) * 2
        const tile = bevelTile(boardRoot, x, z, '#464354', 1.9, 0.23); tile.userData.index = index
        if (values[index]) {
          const markMat = mat(values[index] === 'X' ? '#f0b76d' : '#82c8ff', 0.22, 0.35)
          if (values[index] === 'O') { const torus = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.12, 16, 48), markMat); torus.rotation.x = Math.PI / 2; torus.position.set(x, 0.57, z); torus.castShadow = true; boardRoot.add(torus) }
          else { const a = addBox(boardRoot, new THREE.BoxGeometry(0.18, 0.18, 1.45), markMat, [x, 0.57, z]); a.rotation.y = Math.PI / 4; const b = a.clone(); b.rotation.y = -Math.PI / 4; boardRoot.add(b) }
        }
      }
    } else {
      addBox(boardRoot, new THREE.BoxGeometry(15.6, 0.32, 15.6), mat('#252431', 0.28, 0.2), [0, 0, 0])
      const palette = ['#dc6069', '#57b987', '#e0b94f', '#579bd1']
      const board = (api.current.session.board as number[][]) || []
      for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) {
        const x = col - 7, z = row - 7
        let color = '#e9e3d7'
        if (row < 6 && col < 6) color = '#ab4551'; else if (row < 6 && col > 8) color = '#3f9068'; else if (row > 8 && col > 8) color = '#b39232'; else if (row > 8 && col < 6) color = '#3d79a9'
        if ((row === 7 && col >= 1 && col <= 6) || (col === 7 && row >= 1 && row <= 6) || (row === 7 && col >= 8 && col <= 13) || (col === 7 && row >= 8 && row <= 13)) color = '#d5d0c6'
        if (row === 7 && col === 7) color = '#c59a55'
        const tile = bevelTile(boardRoot, x, z, color, 0.94, 0.2)
        tile.userData.row = row; tile.userData.col = col
        if (row >= 1 && row <= 4 && col >= 1 && col <= 4 || row >= 1 && row <= 4 && col >= 10 && col <= 13 || row >= 10 && row <= 13 && col >= 10 && col <= 13 || row >= 10 && row <= 13 && col >= 1 && col <= 4) {
          const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.07, 32), mat('#e9e1ce', 0.35)); yard.position.set(x, 0.36, z); yard.receiveShadow = true; boardRoot.add(yard)
        }
      }
      for (let player = 0; player < Math.min(4, api.current.session.playerIds.length); player++) for (let piece = 0; piece < 4; piece++) {
        const progress = board[player]?.[piece] || 0, pos = ludoTokenPoint(player, progress, piece)
        const token = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.45, 32), mat(palette[player], 0.23, 0.22))
        token.position.set(pos[0], 0.58, pos[1]); token.castShadow = true; token.receiveShadow = true; token.userData.piece = piece; token.userData.player = player; token.userData.progress = progress
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 12), mat(palette[player], 0.2, 0.2)); cap.scale.y = 0.48; cap.position.y = 0.23; token.add(cap)
        boardRoot.add(token); interactive.push(token)
      }
    }

    let down: { x: number; y: number; theta: number; phi: number } | null = null
    let dragged = false
    const pointers = new Map<number, { x: number; y: number }>()
    let pinchDistance = 0
    let pinchRadius = radius
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2()
    const pointerDown = (event: PointerEvent) => { pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (pointers.size > 1) { const points = [...pointers.values()]; pinchDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y); pinchRadius = radius; dragged = true; down = null } else { down = { x: event.clientX, y: event.clientY, theta, phi }; dragged = false } renderer.domElement.setPointerCapture(event.pointerId) }
    const pointerMove = (event: PointerEvent) => { if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (pointers.size > 1) { const points = [...pointers.values()]; const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y); if (pinchDistance > 0) { radius = THREE.MathUtils.clamp(pinchRadius * pinchDistance / Math.max(1, distance), 9, 42); zoomScale.current = radius / fitDistance(host.clientWidth, host.clientHeight); updateCamera() } return } if (!down) return; const dx = event.clientX - down.x, dy = event.clientY - down.y; if (Math.abs(dx) + Math.abs(dy) > 5) dragged = true; if (dragged) { theta = down.theta - dx * 0.008; phi = down.phi + dy * 0.006; updateCamera() } }
    const pointerUp = (event: PointerEvent) => {
      if (down && !dragged) {
        const rect = renderer.domElement.getBoundingClientRect(); pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1; pointer.y = -(event.clientY - rect.top) / rect.height * 2 + 1
        raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(interactive, false)[0]?.object
        if (api.current.session.status === 'started' && api.current.session.playerIds[api.current.session.turn] === api.current.userId) {
          if (hit?.userData.piece !== undefined) { if (hit.userData.player === api.current.session.playerIds.indexOf(api.current.userId) && api.current.session.lastRollBy === api.current.userId) api.current.onPieceMove(hit.userData.piece) }
          else if (hit?.userData.square && typeof hit.userData.index === 'number') {
            const index = hit.userData.index; if (api.current.game === 'chess') { const cells = expandBoard(String(api.current.session.board || '')); const piece = cells[index]; const side = api.current.session.playerIds.indexOf(api.current.userId); const own = piece && (side === 0 ? piece === piece.toUpperCase() : piece === piece.toLowerCase()); if (api.current.selected === null) { if (own) api.current.onSelect(index) } else if (own) api.current.onSelect(index); else api.current.onMove(api.current.selected, index) } else if (api.current.game === 'tic-tac-toe') api.current.onPlace(index)
          }
        }
      }
      pointers.delete(event.pointerId); if (pointers.size < 2) pinchDistance = 0; down = null
    }
    const wheel = (event: WheelEvent) => { event.preventDefault(); radius = THREE.MathUtils.clamp(radius + event.deltaY * 0.008, 9, 42); zoomScale.current = radius / fitDistance(host.clientWidth, host.clientHeight); updateCamera() }
    renderer.domElement.addEventListener('pointerdown', pointerDown); renderer.domElement.addEventListener('pointermove', pointerMove); renderer.domElement.addEventListener('pointerup', pointerUp); renderer.domElement.addEventListener('pointercancel', pointerUp); renderer.domElement.addEventListener('wheel', wheel, { passive: false })
    const resize = new ResizeObserver(() => { const element = mount.current; if (!element || !element.clientWidth || !element.clientHeight) return; camera.aspect = element.clientWidth / element.clientHeight; camera.updateProjectionMatrix(); radius = fitDistance(element.clientWidth, element.clientHeight) * zoomScale.current; updateCamera(); renderer.setSize(element.clientWidth, element.clientHeight, false) })
    resize.observe(hostElement)
    let frame = 0
    let lastRender = 0
    const animate = (time: number) => { if (disposed) return; frame = requestAnimationFrame(animate); if (time - lastRender >= 33) { renderer.render(scene, camera); lastRender = time } }
    resizeBoard()
    function fitDistance(width: number, height: number) { const half = game === 'ludo' ? 7.7 : game === 'chess' ? 4.35 : 3.2; const projectedWidth = 2 * half * (Math.abs(Math.sin(theta)) + Math.abs(Math.cos(theta))); const projectedHeight = projectedWidth * Math.cos(phi) + (game === 'chess' ? 1.5 : 0.6); const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); return Math.max(projectedHeight / (2 * tangent), projectedWidth / (2 * tangent * Math.max(0.55, width / Math.max(height, 1)))) * 1.12 }
    function resizeBoard() { const element = mount.current; if (element?.clientWidth && element.clientHeight) { camera.aspect = element.clientWidth / element.clientHeight; camera.updateProjectionMatrix(); radius = fitDistance(element.clientWidth, element.clientHeight) * zoomScale.current; updateCamera(); renderer.setSize(element.clientWidth, element.clientHeight, false) } }
    animate(0)
    void renderer.compileAsync(scene, camera).then(() => { if (!disposed) { setSceneReady(true); api.current.onReady() } }).catch(() => { if (!disposed) { setSceneReady(true); api.current.onReady() } })
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect()
      renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointermove', pointerMove); renderer.domElement.removeEventListener('pointerup', pointerUp); renderer.domElement.removeEventListener('pointercancel', pointerUp); renderer.domElement.removeEventListener('wheel', wheel)
      scene.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(material => material.dispose()) } })
      renderer.dispose(); renderer.domElement.remove()
    }
  }, [game, session.board, session.turn, session.lastRoll, session.lastRollBy, session.status, selected])

  const isMyTurn = session.status === 'started' && session.playerIds[session.turn] === userId
  if (graphicsError) return <div className="three-game-fallback"><b>3D graphics are unavailable</b><span>Update your browser or enable hardware acceleration to play this game.</span></div>
  return <div className="three-game-shell" ref={mount}>
    <div className="three-game-hud"><span><i className={isMyTurn ? 'my-turn' : ''}/><b>{isMyTurn ? 'YOUR TURN' : `${names[session.turn] || 'FRIEND'}'S TURN`}</b><small>{game === 'ludo' ? session.lastRollBy === userId ? `You rolled ${session.lastRoll}` : 'Roll the dice or watch the board' : 'Drag to rotate · pinch or scroll to zoom'}</small></span>{game === 'ludo' && <button type="button" disabled={!isMyTurn || !!session.lastRollBy} onClick={onRoll}>{session.lastRollBy === userId ? `Rolled ${session.lastRoll}` : 'Roll dice'}</button>}</div>
    <div className={'three-game-loading'+(sceneReady?' ready':'')}><span/></div>
    <div className="three-game-foot"><span>REALTIME TABLE</span><span>LOW DATA · GPU RENDERED</span></div>
  </div>
}

function ludoRoute(): [number, number][] { return [[6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0]] }
function ludoTokenPoint(player: number, progress: number, piece: number): [number, number] {
  const route = ludoRoute()
  if (progress === 0) { const home: [number, number][][] = [[[1,1],[1,4],[4,1],[4,4]],[[1,10],[1,13],[4,10],[4,13]],[[10,10],[10,13],[13,10],[13,13]],[[10,1],[10,4],[13,1],[13,4]]]; const [row,col] = home[player][piece]; return [col - 7, row - 7] }
  if (progress >= 1 && progress <= 51) { const offset = [0,13,26,39][player]; const [row,col] = route[(offset + progress - 1) % 52]; return [col - 7, row - 7] }
  const lanes: [number, number][][] = [Array.from({length:6},(_,i)=>[7,i+1]),Array.from({length:6},(_,i)=>[i+1,7]),Array.from({length:6},(_,i)=>[7,13-i]),Array.from({length:6},(_,i)=>[13-i,7])]
  if (progress >= 57) return [0, 0]
  const [row,col] = lanes[player][progress - 52]; return [col - 7, row - 7]
}
function expandBoard(fen: string): string[] { return fen.split('/').flatMap(row => [...row].flatMap(char => /^[1-8]$/.test(char) ? Array(Number(char)).fill('') : char)) }

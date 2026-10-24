import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { RotateCcw, Save, Sparkles } from 'lucide-react'

export type CharacterLook = {
  figure: 'masculine' | 'feminine'
  style: 'streetwear' | 'classic'
  skin: string
  hair: string
  top: string
  bottom: string
  accessory: 'none' | 'cap' | 'glasses'
}

export const defaultCharacterLook: CharacterLook = {
  figure: 'masculine', style: 'streetwear', skin: '#c98762', hair: '#211b20', top: '#745ee8', bottom: '#596780', accessory: 'none',
}

const palettes = {
  skin: ['#f2c7a5', '#d99d78', '#c98762', '#9e6246', '#684332'],
  hair: ['#211b20', '#4b3023', '#a86d32', '#d6b47d', '#343b49'],
  top: ['#745ee8', '#e66f81', '#318d83', '#e89a44', '#e7e2d9', '#37465f'],
  bottom: ['#596780', '#333b4a', '#95724d', '#4e796a', '#282833'],
}

type V3 = [number, number, number]
type Face = { points: V3[]; color: string; depth: number }
const hexRgb = (hex: string) => { const value = Number.parseInt(hex.slice(1), 16); return [(value >> 16) & 255, (value >> 8) & 255, value & 255] }
const shade = (hex: string, amount: number) => { const [r, g, b] = hexRgb(hex); const k = Math.max(0.2, Math.min(1.22, amount)); return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})` }

function ellipsoid(center: V3, radii: V3, color: string, segments = 12, rings = 9): Face[] {
  const out: Face[] = []
  for (let row = 0; row < rings; row++) for (let col = 0; col < segments; col++) {
    const point = (u: number, v: number): V3 => [center[0] + radii[0] * Math.sin(v) * Math.cos(u), center[1] + radii[1] * Math.cos(v), center[2] + radii[2] * Math.sin(v) * Math.sin(u)]
    const u0 = col * Math.PI * 2 / segments, u1 = (col + 1) * Math.PI * 2 / segments
    const v0 = row * Math.PI / rings, v1 = (row + 1) * Math.PI / rings
    for (const triangle of [[point(u0, v0), point(u1, v0), point(u1, v1)], [point(u0, v0), point(u1, v1), point(u0, v1)]]) {
      const a = triangle[0], b = triangle[1], c = triangle[2]
      const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const normal: V3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
      const length = Math.hypot(...normal) || 1
      const light = Math.max(0, (normal[0] * -0.4 + normal[1] * 0.75 + normal[2] * 0.8) / length)
      out.push({ points: triangle, color: shade(color, 0.55 + light * 0.55), depth: (a[2] + b[2] + c[2]) / 3 })
    }
  }
  return out
}

function cylinder(from: V3, to: V3, radius: number, color: string, segments = 10): Face[] {
  const axis: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const length = Math.hypot(...axis) || 1
  const dir: V3 = [axis[0] / length, axis[1] / length, axis[2] / length]
  const cross: V3 = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const tangent: V3 = [dir[1] * cross[2] - dir[2] * cross[1], dir[2] * cross[0] - dir[0] * cross[2], dir[0] * cross[1] - dir[1] * cross[0]]
  const tl = Math.hypot(...tangent) || 1; tangent[0] /= tl; tangent[1] /= tl; tangent[2] /= tl
  const bitangent: V3 = [dir[1] * tangent[2] - dir[2] * tangent[1], dir[2] * tangent[0] - dir[0] * tangent[2], dir[0] * tangent[1] - dir[1] * tangent[0]]
  const ring = (center: V3, angle: number): V3 => [center[0] + radius * (tangent[0] * Math.cos(angle) + bitangent[0] * Math.sin(angle)), center[1] + radius * (tangent[1] * Math.cos(angle) + bitangent[1] * Math.sin(angle)), center[2] + radius * (tangent[2] * Math.cos(angle) + bitangent[2] * Math.sin(angle))]
  const faces: Face[] = []
  for (let i = 0; i < segments; i++) {
    const a = ring(from, i * Math.PI * 2 / segments), b = ring(from, (i + 1) * Math.PI * 2 / segments), c = ring(to, (i + 1) * Math.PI * 2 / segments), d = ring(to, i * Math.PI * 2 / segments)
    const factor = 0.65 + 0.35 * Math.max(0, Math.cos((i + 0.5) * Math.PI * 2 / segments - 2.2))
    faces.push({ points: [a, b, c], color: shade(color, factor), depth: (a[2] + b[2] + c[2]) / 3 }, { points: [a, c, d], color: shade(color, factor), depth: (a[2] + c[2] + d[2]) / 3 })
  }
  return faces
}

function CharacterCanvas({ look, angle, onRotate }: { look: CharacterLook; angle: number; onRotate: (angle: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; angle: number } | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current; const ctx = canvas?.getContext('2d'); if (!canvas || !ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2); const width = canvas.clientWidth; const height = canvas.clientHeight
    canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height)
    const gradient = ctx.createLinearGradient(0, 0, width, height); gradient.addColorStop(0, '#f4f0ff'); gradient.addColorStop(1, '#dcd7f2'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#51478320'; ctx.beginPath(); ctx.ellipse(width / 2, height * .88, width * .19, height * .035, 0, 0, Math.PI * 2); ctx.fill()
    const faces: Face[] = []
    // Blender-scene-inspired stylized person: layered clothes, hair, shoes and optional accessories.
    faces.push(...cylinder([-0.23, -0.22, 0], [-0.18, -0.76, 0], .085, look.bottom), ...cylinder([0.23, -0.22, 0], [0.18, -0.76, 0], .085, look.bottom))
    faces.push(...ellipsoid([-0.19, -0.78, .01], [.13, .055, .18], '#312d3b'), ...ellipsoid([.19, -.78, .01], [.13, .055, .18], '#312d3b'))
    const feminine = look.figure === 'feminine'
    faces.push(...ellipsoid([0, -.11, 0], [feminine ? .27 : .32, .39, .2], look.top))
    faces.push(...cylinder([-.32, -.02, 0], [-.48, -.35, .05], .075, look.top), ...cylinder([.32, -.02, 0], [.48, -.35, .05], .075, look.top))
    faces.push(...ellipsoid([-.49, -.37, .07], [.085, .09, .075], look.skin), ...ellipsoid([.49, -.37, .07], [.085, .09, .075], look.skin))
    faces.push(...cylinder([-.09, .2, 0], [-.09, .34, 0], .09, look.skin), ...ellipsoid([0, .55, 0], [.23, .29, .2], look.skin, 16, 12))
    faces.push(...ellipsoid([0, .73, -.015], [.245, .17, .205], look.hair, 16, 8))
    faces.push(...ellipsoid([-.16, .58, .17], [.047, .025, .022], '#28232a', 8, 5), ...ellipsoid([.16, .58, .17], [.047, .025, .022], '#28232a', 8, 5))
    faces.push(...ellipsoid([0, .48, .18], [.07, .025, .026], '#a65f58', 8, 5))
    if (look.style === 'streetwear') {
    faces.push(...ellipsoid([0, .06, .02], [feminine ? .2 : .24, .29, .22], shade(look.top, .74), 12, 8))
      faces.push(...cylinder([-.1, .18, .1], [0, -.12, .17], .015, '#f0d780', 6), ...cylinder([.1, .18, .1], [0, -.12, .17], .015, '#f0d780', 6))
    }
    if (look.accessory === 'cap') {
      faces.push(...ellipsoid([0, .77, 0], [.25, .09, .22], look.hair), ...ellipsoid([0, .72, .18], [.26, .025, .12], look.hair))
    } else if (look.accessory === 'glasses') {
      faces.push(...cylinder([-.17, .58, .195], [-.04, .58, .195], .012, '#24232b', 6), ...cylinder([.04, .58, .195], [.17, .58, .195], .012, '#24232b', 6), ...cylinder([-.17, .58, .195], [-.17, .58, .195], .06, '#393546', 8), ...cylinder([.17, .58, .195], [.17, .58, .195], .06, '#393546', 8))
    }
    const radians = angle * Math.PI / 180; const cos = Math.cos(radians); const sin = Math.sin(radians)
    const project = (point: V3) => { const x = point[0] * cos - point[2] * sin; const z = point[0] * sin + point[2] * cos; const perspective = 1.65 / (1.65 + z * .34); return { x: width / 2 + x * width * .55 * perspective, y: height * .52 - point[1] * height * .47 * perspective, z } }
    faces.sort((a, b) => a.depth - b.depth)
    for (const face of faces) { const points = face.points.map(project); ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y); ctx.closePath(); ctx.fillStyle = face.color; ctx.fill(); ctx.strokeStyle = '#2a253212'; ctx.lineWidth = .5; ctx.stroke() }
  }, [look, angle])
  return <canvas ref={canvasRef} className="my-character-canvas" aria-label="Interactive 3D character preview" onPointerDown={event => { drag.current = { x: event.clientX, angle }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (drag.current) onRotate(drag.current.angle + (event.clientX - drag.current.x) * .8) }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
}

export function ProfileCharacter({ initial, editable, saving, onSave }: { initial?: CharacterLook; editable: boolean; saving: boolean; onSave: (look: CharacterLook) => void }) {
  const [look, setLook] = useState<CharacterLook>(() => ({ ...defaultCharacterLook, ...initial }))
  const [angle, setAngle] = useState(-9)
  useEffect(() => setLook({ ...defaultCharacterLook, ...initial }), [initial])
  const changed = JSON.stringify(look) !== JSON.stringify({ ...defaultCharacterLook, ...initial })
  const update = (key: keyof CharacterLook, value: string) => setLook(current => ({ ...current, [key]: value } as CharacterLook))
  return <section className="my-character-card" aria-label="My character">
    <header className="my-character-header"><span className="my-character-mark"><Sparkles size={17}/></span><span><small>MAKE IT YOURS</small><b>My character</b><em>Drag to turn your 3D avatar</em></span>{editable && <button type="button" className="my-character-reset" onClick={() => { setLook(defaultCharacterLook); setAngle(-9) }} aria-label="Reset character"><RotateCcw size={15}/></button>}</header>
    <div className="my-character-content"><div className="my-character-stage"><CharacterCanvas look={look} angle={angle} onRotate={setAngle}/><span className="my-character-turn-hint">↔ Drag to rotate</span></div>
      {editable ? <div className="my-character-controls"><label>Character<select value={look.figure} onChange={event => update('figure', event.target.value)}><option value="masculine">Male model</option><option value="feminine">Female model</option></select></label><label>Outfit<select value={look.style} onChange={event => update('style', event.target.value)}><option value="streetwear">Hoodie & cargo pants</option><option value="classic">Classic outfit</option></select></label>
        {(['skin','hair','top','bottom'] as const).map(key => <fieldset key={key}><legend>{{ skin: 'Skin tone', hair: 'Hair color', top: 'Top color', bottom: 'Bottom color' }[key]}</legend><div className="my-character-swatches">{palettes[key].map(color => <button key={color} type="button" className={look[key] === color ? 'selected' : ''} style={{ '--swatch': color } as CSSProperties} onClick={() => update(key, color)} aria-label={`${key} ${color}`} aria-pressed={look[key] === color}/>)}</div></fieldset>)}
        <label>Accessory<select value={look.accessory} onChange={event => update('accessory', event.target.value)}><option value="none">No accessory</option><option value="cap">Street cap</option><option value="glasses">Glasses</option></select></label>
        <button type="button" className="my-character-save" onClick={() => onSave(look)} disabled={!changed || saving}><Save size={15}/>{saving ? 'Saving…' : changed ? 'Save character' : 'Character saved'}</button>
      </div> : <p className="my-character-viewer-note">A little character that makes this profile theirs.</p>}
    </div>
  </section>
}

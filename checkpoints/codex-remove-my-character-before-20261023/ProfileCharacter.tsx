import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { RotateCcw, Save, Sparkles } from 'lucide-react'

export type CharacterLook = {
  figure: 'masculine' | 'feminine'
  shape: 'slim' | 'average' | 'athletic' | 'curvy'
  skin: string
  hair: string
  hairStyle: 'short' | 'messy' | 'long' | 'curly' | 'bun' | 'buzz'
  top: string
  topStyle: 'hoodie' | 'tshirt' | 'crop' | 'jacket' | 'shirt' | 'dress'
  bottom: string
  bottomStyle: 'cargo' | 'jeans' | 'shorts' | 'skirt' | 'trousers'
  footwear: 'sneakers' | 'boots' | 'heels' | 'sandals'
  accessories: string[]
}

export const defaultCharacterLook: CharacterLook = {
  figure: 'masculine', shape: 'average', skin: '#c98762', hair: '#211b20', hairStyle: 'messy',
  top: '#26252b', topStyle: 'hoodie', bottom: '#586149', bottomStyle: 'cargo', footwear: 'sneakers', accessories: ['chain'],
}

const palettes = {
  skin: ['#f2c7a5', '#d99d78', '#c98762', '#9e6246', '#684332'],
  hair: ['#211b20', '#4b3023', '#a86d32', '#d6b47d', '#343b49'],
  top: ['#26252b', '#745ee8', '#e66f81', '#318d83', '#e89a44', '#e7e2d9', '#37465f'],
  bottom: ['#586149', '#596780', '#333b4a', '#95724d', '#4e796a', '#282833'],
}
const faceStyles = ['short', 'messy', 'long', 'curly', 'bun', 'buzz'] as const
const topStyles = ['hoodie', 'tshirt', 'crop', 'jacket', 'shirt', 'dress'] as const
const bottomStyles = ['cargo', 'jeans', 'shorts', 'skirt', 'trousers'] as const
const accessories = ['cap', 'glasses', 'backpack', 'chain', 'watch', 'earrings']
const labels: Record<string, string> = { short: 'Short', messy: 'Messy', long: 'Long waves', curly: 'Curly', bun: 'Bun', buzz: 'Buzz cut', hoodie: 'Hoodie', tshirt: 'T-shirt', crop: 'Crop top', jacket: 'Jacket', shirt: 'Button shirt', dress: 'Dress', cargo: 'Cargo pants', jeans: 'Jeans', shorts: 'Shorts', skirt: 'Skirt', trousers: 'Trousers', sneakers: 'Sneakers', boots: 'Boots', heels: 'Heels', sandals: 'Sandals' }
function CharacterCanvas({ look }: { look: CharacterLook }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let active = true
    const draw = () => {
      if (!active) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2), width = canvas.clientWidth, height = canvas.clientHeight
      if (!width || !height) return
      canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const bg = ctx.createLinearGradient(0, 0, width, height); bg.addColorStop(0, '#282a2e'); bg.addColorStop(.55, '#34363b'); bg.addColorStop(1, '#444850'); ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height)
      const photo = new Image(); photo.onload = () => {
        if (!active) return
        const scale = Math.min(width * .92 / photo.width, height * .96 / photo.height), w = photo.width * scale, h = photo.height * scale, x = (width - w) / 2, y = (height - h) / 2
        ctx.drawImage(photo, 0, 0, photo.width, photo.height, x, y, w, h)
        const female = look.figure === 'feminine'
        const polygons = female
          ? { top: [[.13,.19],[.36,.17],[.66,.18],[.8,.3],[.79,.43],[.68,.47],[.27,.45],[.15,.39]], bottom: [[.13,.44],[.77,.44],[.84,.86],[.69,.93],[.31,.93],[.16,.84]], hair: [[.18,.05],[.48,.02],[.76,.11],[.88,.27],[.81,.44],[.68,.39],[.51,.3],[.31,.43],[.16,.3]] }
          : { top: [[.11,.13],[.4,.1],[.72,.12],[.91,.24],[.91,.43],[.78,.48],[.2,.47],[.08,.39]], bottom: [[.18,.46],[.81,.46],[.83,.92],[.58,.94],[.37,.94],[.17,.91]], hair: [[.32,.02],[.7,.02],[.83,.14],[.76,.24],[.57,.2],[.38,.23],[.24,.16]] }
        const tint = (points: number[][], color: string) => { ctx.save(); ctx.beginPath(); ctx.moveTo(x + points[0][0] * w, y + points[0][1] * h); for (const [px, py] of points.slice(1)) ctx.lineTo(x + px * w, y + py * h); ctx.closePath(); ctx.clip(); ctx.globalAlpha = .27; ctx.globalCompositeOperation = 'color'; ctx.fillStyle = color; ctx.fillRect(x, y, w, h); ctx.restore() }
        tint(polygons.top, look.top); tint(polygons.bottom, look.bottom); tint(polygons.hair, look.hair)
      }
      photo.src = look.figure === 'feminine' ? '/character-studio/female-base.png' : '/character-studio/male-base.png'
    }
    draw()
    const observer = new ResizeObserver(draw); observer.observe(canvas)
    return () => { active = false; observer.disconnect() }
  }, [look])
  return <canvas ref={canvasRef} className="my-character-canvas" aria-label={`Photorealistic ${look.figure} character preview`} />
}
function ChoiceRow({ title, values, value, onChange }: { title:string;values:string[];value:string;onChange:(value:string)=>void }) { return <fieldset className="my-character-choice"><legend>{title}</legend><div className="my-character-options">{values.map(item=><button type="button" key={item} className={value===item?'selected':''} onClick={()=>onChange(item)} aria-pressed={value===item}>{labels[item]||item}</button>)}</div></fieldset> }

export function ProfileCharacter({ initial, editable, saving, onSave }: { initial?: CharacterLook; editable:boolean; saving:boolean; onSave:(look:CharacterLook)=>void }) {
  const [look,setLook]=useState<CharacterLook>(()=>({...defaultCharacterLook,...initial}))
  useEffect(()=>setLook({...defaultCharacterLook,...initial}),[initial])
  const changed=JSON.stringify(look)!==JSON.stringify({...defaultCharacterLook,...initial})
  const update=(key:keyof CharacterLook,value:string)=>setLook(current=>({...current,[key]:value} as CharacterLook))
  const toggleAccessory=(item:string)=>setLook(current=>({...current,accessories:current.accessories.includes(item)?current.accessories.filter(value=>value!==item):[...current.accessories,item]}))
  return <section className="my-character-card" aria-label="My character">
    <header className="my-character-header"><span className="my-character-mark"><Sparkles size={17}/></span><span><small>CHARACTER STUDIO</small><b>My character</b><em>Choose a model and customize the look</em></span>{editable&&<button type="button" className="my-character-reset" onClick={()=>setLook(defaultCharacterLook)} aria-label="Reset character"><RotateCcw size={15}/></button>}</header>
    <div className="my-character-content"><div className="my-character-stage"><CharacterCanvas look={look}/><span className="my-character-turn-hint">Photo model preview</span></div>
      {editable?<div className="my-character-controls">
        <div className="my-character-control-group"><b>Body & face</b><label>Model<select value={look.figure} onChange={e=>update('figure',e.target.value)}><option value="masculine">Male</option><option value="feminine">Female</option></select></label><label>Body shape<select value={look.shape} onChange={e=>update('shape',e.target.value)}><option value="slim">Slim</option><option value="average">Average</option><option value="athletic">Athletic</option><option value="curvy">Curvy</option></select></label><ChoiceRow title="Hair style" values={[...faceStyles]} value={look.hairStyle} onChange={v=>update('hairStyle',v)}/><div className="my-character-color-row">{(['skin','hair'] as const).map(key=><fieldset key={key}><legend>{key==='skin'?'Skin tone':'Hair color'}</legend><div className="my-character-swatches">{palettes[key].map(color=><button key={color} type="button" className={look[key]===color?'selected':''} style={{'--swatch':color} as CSSProperties} onClick={()=>update(key,color)} aria-label={`${key} ${color}`} aria-pressed={look[key]===color}/>)}</div></fieldset>)}</div></div>
        <div className="my-character-control-group"><b>Clothing</b><ChoiceRow title="Tops & jackets" values={[...topStyles]} value={look.topStyle} onChange={v=>update('topStyle',v)}/><ChoiceRow title="Pants, skirts & shorts" values={[...bottomStyles]} value={look.bottomStyle} onChange={v=>update('bottomStyle',v)}/><ChoiceRow title="Footwear" values={['sneakers','boots','heels','sandals']} value={look.footwear} onChange={v=>update('footwear',v)}/><div className="my-character-color-row">{(['top','bottom'] as const).map(key=><fieldset key={key}><legend>{key==='top'?'Top color':'Bottom color'}</legend><div className="my-character-swatches">{palettes[key].map(color=><button key={color} type="button" className={look[key]===color?'selected':''} style={{'--swatch':color} as CSSProperties} onClick={()=>update(key,color)} aria-label={`${key} ${color}`} aria-pressed={look[key]===color}/>)}</div></fieldset>)}</div></div>
        <div className="my-character-control-group my-character-accessories"><b>Accessories</b><div className="my-character-options">{accessories.map(item=><button key={item} type="button" className={look.accessories.includes(item)?'selected':''} onClick={()=>toggleAccessory(item)} aria-pressed={look.accessories.includes(item)}>{labels[item]||item}</button>)}</div></div>
        <button type="button" className="my-character-save" onClick={()=>onSave(look)} disabled={!changed||saving}><Save size={15}/>{saving?'Saving…':changed?'Save character':'Character saved'}</button>
      </div>:<p className="my-character-viewer-note">A custom character made for this profile.</p>}</div>
  </section>
}

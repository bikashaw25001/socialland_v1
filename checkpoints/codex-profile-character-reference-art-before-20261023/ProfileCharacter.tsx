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
type V3 = [number, number, number]
type Face = { points: V3[]; color: string; depth: number }
const hexRgb = (hex: string) => { const value = Number.parseInt(hex.slice(1), 16); return [(value >> 16) & 255, (value >> 8) & 255, value & 255] }
const shade = (hex: string, amount: number) => { const [r, g, b] = hexRgb(hex); const k = Math.max(0.2, Math.min(1.22, amount)); return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})` }

// Build smooth lit triangle meshes in the browser so the model needs no downloaded assets.
function ellipsoid(center: V3, radii: V3, color: string, segments = 24, rings = 16): Face[] {
  const out: Face[] = []
  const point = (u: number, v: number): V3 => [center[0] + radii[0] * Math.sin(v) * Math.cos(u), center[1] + radii[1] * Math.cos(v), center[2] + radii[2] * Math.sin(v) * Math.sin(u)]
  for (let row = 0; row < rings; row++) for (let col = 0; col < segments; col++) {
    const u0 = col * Math.PI * 2 / segments, u1 = (col + 1) * Math.PI * 2 / segments, v0 = row * Math.PI / rings, v1 = (row + 1) * Math.PI / rings
    for (const triangle of [[point(u0, v0), point(u1, v0), point(u1, v1)], [point(u0, v0), point(u1, v1), point(u0, v1)]]) {
      const a = triangle[0], b = triangle[1], c = triangle[2]
      const ab: V3 = [b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac: V3 = [c[0]-a[0],c[1]-a[1],c[2]-a[2]]
      const n: V3 = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]], len = Math.hypot(...n) || 1
      const light = Math.max(0,(n[0]*-.4+n[1]*.75+n[2]*.8)/len)
      out.push({ points: triangle, color: shade(color,.52+light*.62), depth:(a[2]+b[2]+c[2])/3 })
    }
  }
  return out
}
function cylinder(from: V3, to: V3, radius: number, color: string, segments = 18): Face[] {
  const axis: V3 = [to[0]-from[0],to[1]-from[1],to[2]-from[2]], length=Math.hypot(...axis)||1, dir:V3=[axis[0]/length,axis[1]/length,axis[2]/length]
  const cross:V3=Math.abs(dir[1])>.9?[1,0,0]:[0,1,0], tangent:V3=[dir[1]*cross[2]-dir[2]*cross[1],dir[2]*cross[0]-dir[0]*cross[2],dir[0]*cross[1]-dir[1]*cross[0]],tl=Math.hypot(...tangent)||1
  tangent[0]/=tl;tangent[1]/=tl;tangent[2]/=tl
  const bitangent:V3=[dir[1]*tangent[2]-dir[2]*tangent[1],dir[2]*tangent[0]-dir[0]*tangent[2],dir[0]*tangent[1]-dir[1]*tangent[0]]
  const ring=(center:V3,angle:number):V3=>[center[0]+radius*(tangent[0]*Math.cos(angle)+bitangent[0]*Math.sin(angle)),center[1]+radius*(tangent[1]*Math.cos(angle)+bitangent[1]*Math.sin(angle)),center[2]+radius*(tangent[2]*Math.cos(angle)+bitangent[2]*Math.sin(angle))]
  const faces:Face[]=[]
  for(let i=0;i<segments;i++){const a=ring(from,i*Math.PI*2/segments),b=ring(from,(i+1)*Math.PI*2/segments),c=ring(to,(i+1)*Math.PI*2/segments),d=ring(to,i*Math.PI*2/segments),tone=.62+.38*Math.max(0,Math.cos((i+.5)*Math.PI*2/segments-2.2));faces.push({points:[a,b,c],color:shade(color,tone),depth:(a[2]+b[2]+c[2])/3},{points:[a,c,d],color:shade(color,tone),depth:(a[2]+c[2]+d[2])/3})}
  return faces
}

function CharacterCanvas({ look, angle, onRotate }: { look: CharacterLook; angle: number; onRotate: (angle: number) => void }) {
  const canvasRef=useRef<HTMLCanvasElement>(null),drag=useRef<{x:number;angle:number}|null>(null)
  useEffect(()=>{
    const canvas=canvasRef.current,ctx=canvas?.getContext('2d');if(!canvas||!ctx)return
    const dpr=Math.min(window.devicePixelRatio||1,2),width=canvas.clientWidth,height=canvas.clientHeight
    canvas.width=width*dpr;canvas.height=height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height)
    const bg=ctx.createLinearGradient(0,0,width,height);bg.addColorStop(0,'#e9e5f1');bg.addColorStop(.56,'#c8c5d0');bg.addColorStop(1,'#aaaab4');ctx.fillStyle=bg;ctx.fillRect(0,0,width,height)
    ctx.fillStyle='#30293d35';ctx.beginPath();ctx.ellipse(width/2,height*.9,width*.22,height*.035,0,0,Math.PI*2);ctx.fill()
    const f=look.figure==='feminine',shape=look.shape,legSpread=shape==='athletic'?.25:.22, hip=f?(shape==='curvy'?.27:shape==='slim'?.19:.22):(shape==='curvy'?.25:shape==='slim'?.19:.22), shoulder=(f?.28:.34)*(shape==='athletic'?1.12:shape==='slim'?.86:1)
    const faces:Face[]=[]
    const pant=look.bottomStyle!=='shorts'&&look.bottomStyle!=='skirt',dress=look.topStyle==='dress'
    if(pant){faces.push(...cylinder([-legSpread,-.18,0],[-.17,-.73,0],.085,look.bottom),...cylinder([legSpread,-.18,0],[.17,-.73,0],.085,look.bottom))}
    else if(look.bottomStyle==='skirt'){faces.push(...ellipsoid([0,-.31,0],[.34,.24,.24],look.bottom,28,12))}
    else {faces.push(...cylinder([-.18,-.19,0],[-.18,-.52,0],.105,look.bottom),...cylinder([.18,-.19,0],[.18,-.52,0],.105,look.bottom))}
    // shoes: raised heel and sole distinguish each footwear choice
    const shoeColor=look.footwear==='boots'?'#5c4437':look.footwear==='heels'?'#25232b':look.footwear==='sandals'?'#9e765b':'#ececf1'
    faces.push(...ellipsoid([-.18,-.77,.055],[.13,.065,.19],shoeColor),...ellipsoid([.18,-.77,.055],[.13,.065,.19],shoeColor))
    if(look.footwear==='boots')faces.push(...cylinder([-.18,-.73,0],[-.18,-.57,0],.09,shoeColor),...cylinder([.18,-.73,0],[.18,-.57,0],.09,shoeColor))
    if(look.footwear==='heels')faces.push(...cylinder([-.18,-.77,-.02],[-.18,-.69,-.02],.025,'#29262d'),...cylinder([.18,-.77,-.02],[.18,-.69,-.02],.025,'#29262d'))
    // waist, torso, neck, shoulders and limbs
    faces.push(...ellipsoid([0,-.23,0],[hip,.19,.19],dress?look.top:look.bottom))
    const torsoY=look.topStyle==='crop'?-.03:-.1, torsoH=look.topStyle==='crop'?.26:.36
    faces.push(...ellipsoid([0,torsoY,0],[shoulder,torsoH,.21],look.top,30,18))
    faces.push(...ellipsoid([0,-.05,0],[shoulder*.7,.17,.215],shade(look.top,.83),24,14))
    faces.push(...cylinder([-.29,-.02,0],[-.45,-.34,.02],.072,look.top),...cylinder([.29,-.02,0],[.45,-.34,.02],.072,look.top))
    faces.push(...ellipsoid([-.46,-.36,.02],[.078,.09,.07],look.skin),...ellipsoid([.46,-.36,.02],[.078,.09,.07],look.skin))
    faces.push(...cylinder([-.095,.23,0],[-.095,.37,0],.085,look.skin),...ellipsoid([0,.55,0],[.205,.265,.19],look.skin,32,24))
    // neck shadow, nose, ears, eyes, brows and mouth add facial detail
    faces.push(...ellipsoid([-.2,.54,0],[.035,.068,.04],look.skin,14,10),...ellipsoid([.2,.54,0],[.035,.068,.04],look.skin,14,10))
    faces.push(...ellipsoid([-.073,.59,.172],[.026,.019,.018],'#342821',12,8),...ellipsoid([.073,.59,.172],[.026,.019,.018],'#342821',12,8))
    faces.push(...ellipsoid([-.073,.625,.171],[.038,.009,.012],look.hair,12,6),...ellipsoid([.073,.625,.171],[.038,.009,.012],look.hair,12,6))
    faces.push(...ellipsoid([0,.535,.192],[.026,.043,.027],shade(look.skin,.8),12,8),...ellipsoid([0,.465,.18],[.046,.012,.015],'#9b554d',12,6))
    // layered hairstyles
    faces.push(...ellipsoid([0,.72,-.005],[.215,.155,.19],look.hair,28,18))
    if(look.hairStyle==='long'||look.hairStyle==='curly'||look.hairStyle==='bun')faces.push(...ellipsoid([-.175,.49,-.005],[.065,.26,.14],look.hair,18,12),...ellipsoid([.175,.49,-.005],[.065,.26,.14],look.hair,18,12))
    if(look.hairStyle==='messy'||look.hairStyle==='curly')for(let i=0;i<8;i++){const a=i*Math.PI/4;faces.push(...ellipsoid([Math.cos(a)*.13,.78+Math.sin(a)*.035,Math.sin(a)*.12],[.075,.085,.07],look.hair,12,8))}
    if(look.hairStyle==='bun')faces.push(...ellipsoid([0,.88,-.08],[.105,.1,.1],look.hair,18,12))
    if(look.hairStyle==='buzz')faces.push(...ellipsoid([0,.69,0],[.21,.08,.19],look.hair,24,12))
    if(look.hairStyle==='short'||look.hairStyle==='messy'||look.hairStyle==='curly')faces.push(...ellipsoid([0,.64,.14],[.17,.075,.07],look.hair,20,10))
    // recognizable garments layered over the base outfit
    if(look.topStyle==='hoodie')faces.push(...ellipsoid([0,.02,-.12],[.16,.17,.13],shade(look.top,.72),20,12),...cylinder([-.08,.17,.12],[0,-.1,.18],.012,'#d3c7aa',8),...cylinder([.08,.17,.12],[0,-.1,.18],.012,'#d3c7aa',8))
    if(look.topStyle==='jacket')faces.push(...ellipsoid([-.105,-.07,.17],[.095,.29,.045],shade(look.top,.78)),...ellipsoid([.105,-.07,.17],[.095,.29,.045],shade(look.top,1.08)),...cylinder([0,.16,.19],[0,-.3,.19],.009,'#ded9cd',8))
    if(look.topStyle==='shirt')faces.push(...cylinder([-.05,.15,.19],[0,.02,.2],.055,'#eee9df',10),...cylinder([.05,.15,.19],[0,.02,.2],.055,'#eee9df',10))
    if(dress)faces.push(...ellipsoid([0,-.27,.005],[.31,.28,.21],look.top,28,16))
    if(look.bottomStyle==='cargo')faces.push(...ellipsoid([-.19,-.36,.085],[.075,.09,.025],shade(look.bottom,.76)),...ellipsoid([.19,-.36,.085],[.075,.09,.025],shade(look.bottom,.76)))
    if(look.bottomStyle==='jeans')faces.push(...cylinder([-.17,-.22,.09],[-.17,-.7,.09],.009,shade(look.bottom,.73),8),...cylinder([.17,-.22,.09],[.17,-.7,.09],.009,shade(look.bottom,.73),8))
    if(look.accessories.includes('cap'))faces.push(...ellipsoid([0,.76,-.005],[.23,.08,.2],look.hair,24,12),...ellipsoid([0,.72,.17],[.25,.023,.105],look.hair,20,8))
    if(look.accessories.includes('glasses'))faces.push(...ellipsoid([-.073,.59,.188],[.054,.034,.018],'#37343c',16,10),...ellipsoid([.073,.59,.188],[.054,.034,.018],'#37343c',16,10),...cylinder([-.02,.59,.2],[.02,.59,.2],.009,'#25232b',8))
    if(look.accessories.includes('backpack'))faces.push(...ellipsoid([0,-.04,-.2],[.24,.3,.12],'#353842',22,14),...cylinder([-.23,.13,.08],[-.16,-.21,.12],.025,'#25252c',10),...cylinder([.23,.13,.08],[.16,-.21,.12],.025,'#25252c',10))
    if(look.accessories.includes('chain'))faces.push(...cylinder([-.08,.18,.2],[0,-.12,.24],.009,'#d5bd7f',8),...cylinder([.08,.18,.2],[0,-.12,.24],.009,'#d5bd7f',8))
    if(look.accessories.includes('watch'))faces.push(...ellipsoid([.46,-.3,.07],[.05,.045,.035],'#d7c18d',14,8))
    if(look.accessories.includes('earrings'))faces.push(...ellipsoid([-.21,.5,.02],[.018,.04,.018],'#d7c18d',10,8),...ellipsoid([.21,.5,.02],[.018,.04,.018],'#d7c18d',10,8))
    const rad=angle*Math.PI/180,cos=Math.cos(rad),sin=Math.sin(rad)
    const project=(p:V3)=>{const x=p[0]*cos-p[2]*sin,z=p[0]*sin+p[2]*cos,k=1.8/(1.8+z*.3);return{x:width/2+x*width*.57*k,y:height*.52-p[1]*height*.46*k,z}}
    const rendered=faces.map(face=>{const pts=face.points.map(project);return{face,pts,depth:pts.reduce((sum,p)=>sum+p.z,0)/pts.length}}).sort((a,b)=>a.depth-b.depth)
    for(const{face,pts}of rendered){ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.closePath();ctx.fillStyle=face.color;ctx.fill();ctx.strokeStyle='#28232a0b';ctx.lineWidth=.35;ctx.stroke()}
  },[look,angle])
  return <canvas ref={canvasRef} className="my-character-canvas" aria-label="Interactive 3D character preview" onPointerDown={e=>{drag.current={x:e.clientX,angle};e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(drag.current)onRotate(drag.current.angle+(e.clientX-drag.current.x)*.7)}} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}/>
}

function ChoiceRow({ title, values, value, onChange }: { title:string;values:string[];value:string;onChange:(value:string)=>void }) { return <fieldset className="my-character-choice"><legend>{title}</legend><div className="my-character-options">{values.map(item=><button type="button" key={item} className={value===item?'selected':''} onClick={()=>onChange(item)} aria-pressed={value===item}>{labels[item]||item}</button>)}</div></fieldset> }

export function ProfileCharacter({ initial, editable, saving, onSave }: { initial?: CharacterLook; editable:boolean; saving:boolean; onSave:(look:CharacterLook)=>void }) {
  const [look,setLook]=useState<CharacterLook>(()=>({...defaultCharacterLook,...initial})),[angle,setAngle]=useState(-9)
  useEffect(()=>setLook({...defaultCharacterLook,...initial}),[initial])
  const changed=JSON.stringify(look)!==JSON.stringify({...defaultCharacterLook,...initial})
  const update=(key:keyof CharacterLook,value:string)=>setLook(current=>({...current,[key]:value} as CharacterLook))
  const toggleAccessory=(item:string)=>setLook(current=>({...current,accessories:current.accessories.includes(item)?current.accessories.filter(value=>value!==item):[...current.accessories,item]}))
  return <section className="my-character-card" aria-label="My character">
    <header className="my-character-header"><span className="my-character-mark"><Sparkles size={17}/></span><span><small>CHARACTER STUDIO</small><b>My character</b><em>Turn the model to view every angle</em></span>{editable&&<button type="button" className="my-character-reset" onClick={()=>{setLook(defaultCharacterLook);setAngle(-9)}} aria-label="Reset character"><RotateCcw size={15}/></button>}</header>
    <div className="my-character-content"><div className="my-character-stage"><CharacterCanvas look={look} angle={angle} onRotate={setAngle}/><span className="my-character-turn-hint">↔ Drag to rotate</span></div>
      {editable?<div className="my-character-controls">
        <div className="my-character-control-group"><b>Body & face</b><label>Model<select value={look.figure} onChange={e=>update('figure',e.target.value)}><option value="masculine">Male</option><option value="feminine">Female</option></select></label><label>Body shape<select value={look.shape} onChange={e=>update('shape',e.target.value)}><option value="slim">Slim</option><option value="average">Average</option><option value="athletic">Athletic</option><option value="curvy">Curvy</option></select></label><ChoiceRow title="Hair style" values={[...faceStyles]} value={look.hairStyle} onChange={v=>update('hairStyle',v)}/><div className="my-character-color-row">{(['skin','hair'] as const).map(key=><fieldset key={key}><legend>{key==='skin'?'Skin tone':'Hair color'}</legend><div className="my-character-swatches">{palettes[key].map(color=><button key={color} type="button" className={look[key]===color?'selected':''} style={{'--swatch':color} as CSSProperties} onClick={()=>update(key,color)} aria-label={`${key} ${color}`} aria-pressed={look[key]===color}/>)}</div></fieldset>)}</div></div>
        <div className="my-character-control-group"><b>Clothing</b><ChoiceRow title="Tops & jackets" values={[...topStyles]} value={look.topStyle} onChange={v=>update('topStyle',v)}/><ChoiceRow title="Pants, skirts & shorts" values={[...bottomStyles]} value={look.bottomStyle} onChange={v=>update('bottomStyle',v)}/><ChoiceRow title="Footwear" values={['sneakers','boots','heels','sandals']} value={look.footwear} onChange={v=>update('footwear',v)}/><div className="my-character-color-row">{(['top','bottom'] as const).map(key=><fieldset key={key}><legend>{key==='top'?'Top color':'Bottom color'}</legend><div className="my-character-swatches">{palettes[key].map(color=><button key={color} type="button" className={look[key]===color?'selected':''} style={{'--swatch':color} as CSSProperties} onClick={()=>update(key,color)} aria-label={`${key} ${color}`} aria-pressed={look[key]===color}/>)}</div></fieldset>)}</div></div>
        <div className="my-character-control-group my-character-accessories"><b>Accessories</b><div className="my-character-options">{accessories.map(item=><button key={item} type="button" className={look.accessories.includes(item)?'selected':''} onClick={()=>toggleAccessory(item)} aria-pressed={look.accessories.includes(item)}>{labels[item]||item}</button>)}</div></div>
        <button type="button" className="my-character-save" onClick={()=>onSave(look)} disabled={!changed||saving}><Save size={15}/>{saving?'Saving…':changed?'Save character':'Character saved'}</button>
      </div>:<p className="my-character-viewer-note">A custom character made for this profile.</p>}</div>
  </section>
}

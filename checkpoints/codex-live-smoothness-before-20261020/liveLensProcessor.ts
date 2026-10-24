import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { LIVE_LENSES, type LiveLensId } from './liveLensCatalog'

type Point = { x: number; y: number }
type Face = { x: number; y: number; z?: number }

export type LiveLensSession = {
  stream: MediaStream
  setLens: (lens: LiveLensId) => void
  stop: () => void
}

const pointAt = (face: Face[], index: number, width: number, height: number): Point => ({
  x: (face[index]?.x || 0) * width,
  y: (face[index]?.y || 0) * height,
})

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  ctx.save()
  ctx.translate(x, y)
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / 5
    const r = i % 2 ? radius * 0.42 : radius
    const px = Math.cos(angle) * r
    const py = Math.sin(angle) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = radius * 1.4
  ctx.fill()
  ctx.restore()
}

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 32, size / 32)
  ctx.beginPath()
  ctx.moveTo(0, 28)
  ctx.bezierCurveTo(-5, 22, -22, 11, -22, 0)
  ctx.bezierCurveTo(-22, -15, -5, -18, 0, -7)
  ctx.bezierCurveTo(5, -18, 22, -15, 22, 0)
  ctx.bezierCurveTo(22, 11, 5, 22, 0, 28)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 9
  ctx.fill()
  ctx.restore()
}

function drawLens(ctx: CanvasRenderingContext2D, face: Face[], width: number, height: number, lens: LiveLensId, time: number) {
  if (lens === 'none' || face.length < 468) return
  const leftSide = pointAt(face, 234, width, height)
  const rightSide = pointAt(face, 454, width, height)
  const top = pointAt(face, 10, width, height)
  const chin = pointAt(face, 152, width, height)
  const faceWidth = distance(leftSide, rightSide)
  if (!faceWidth) return
  const roll = Math.atan2(rightSide.y - leftSide.y, rightSide.x - leftSide.x)
  const faceCenter = midpoint(leftSide, rightSide)
  const scale = faceWidth / 200

  ctx.save()
  ctx.translate(faceCenter.x, faceCenter.y)
  ctx.rotate(roll)
  ctx.translate(-faceCenter.x, -faceCenter.y)

  if (lens === 'neon' || lens === 'hearts') {
    const leftEye = midpoint(pointAt(face, 33, width, height), pointAt(face, 133, width, height))
    const rightEye = midpoint(pointAt(face, 362, width, height), pointAt(face, 263, width, height))
    const r = faceWidth * 0.13
    const color = lens === 'neon' ? '#77fff2' : '#ff76be'
    ctx.lineWidth = Math.max(2, faceWidth * 0.018)
    ctx.strokeStyle = color
    ctx.fillStyle = lens === 'neon' ? '#20c8ff27' : '#ff53a328'
    ctx.shadowColor = color
    ctx.shadowBlur = 12 * scale
    for (const eye of [leftEye, rightEye]) {
      if (lens === 'hearts') {
        ctx.beginPath()
        ctx.ellipse(eye.x, eye.y, r * 1.25, r * 0.98, 0, 0, Math.PI * 2)
        ctx.fillStyle = '#ff53a326'
        ctx.fill()
        ctx.lineWidth = Math.max(2, faceWidth * 0.018)
        ctx.strokeStyle = '#ff76be'
        ctx.stroke()
        drawHeart(ctx, eye.x, eye.y - r * 1.2, r * 0.36, '#ff76be')
      } else {
        ctx.beginPath()
        ctx.ellipse(eye.x, eye.y, r * 1.18, r * 0.79, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
    if (lens === 'neon') {
      ctx.beginPath()
      ctx.moveTo(leftEye.x + r * 1.05, leftEye.y)
      ctx.lineTo(rightEye.x - r * 1.05, rightEye.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(leftEye.x - r * 1.1, leftEye.y)
      ctx.lineTo(leftSide.x + faceWidth * 0.03, leftEye.y + faceWidth * 0.025)
      ctx.moveTo(rightEye.x + r * 1.1, rightEye.y)
      ctx.lineTo(rightSide.x - faceWidth * 0.03, rightEye.y + faceWidth * 0.025)
      ctx.stroke()
    }
  }

  if (lens === 'bunny') {
    const earY = top.y - faceWidth * 0.12
    for (const direction of [-1, 1]) {
      const x = faceCenter.x + direction * faceWidth * 0.17
      ctx.save()
      ctx.translate(x, earY)
      ctx.rotate(direction * -0.16)
      ctx.beginPath()
      ctx.ellipse(0, -faceWidth * 0.14, faceWidth * 0.085, faceWidth * 0.23, 0, 0, Math.PI * 2)
      const fur = ctx.createLinearGradient(0, -faceWidth * 0.37, 0, faceWidth * 0.08)
      fur.addColorStop(0, '#fff2fb')
      fur.addColorStop(1, '#ff9fcf')
      ctx.fillStyle = fur
      ctx.shadowColor = '#ff83cb'
      ctx.shadowBlur = 12 * scale
      ctx.fill()
      ctx.lineWidth = Math.max(2, faceWidth * 0.012)
      ctx.strokeStyle = '#fff'
      ctx.stroke()
      ctx.beginPath()
      ctx.ellipse(0, -faceWidth * 0.14, faceWidth * 0.035, faceWidth * 0.15, 0, 0, Math.PI * 2)
      ctx.fillStyle = '#ff6eaf'
      ctx.fill()
      ctx.restore()
    }
    const cheekY = chin.y - faceWidth * 0.28
    drawHeart(ctx, faceCenter.x - faceWidth * 0.27, cheekY, faceWidth * 0.08, '#ff82bbad')
    drawHeart(ctx, faceCenter.x + faceWidth * 0.27, cheekY, faceWidth * 0.08, '#ff82bbad')
  }

  if (lens === 'crown') {
    const crownY = top.y - faceWidth * 0.1
    const crownWidth = faceWidth * 0.54
    const crownHeight = faceWidth * 0.23
    const left = faceCenter.x - crownWidth / 2
    const right = faceCenter.x + crownWidth / 2
    const base = crownY + crownHeight
    ctx.beginPath()
    ctx.moveTo(left, base)
    ctx.lineTo(left + crownWidth * 0.08, crownY + crownHeight * 0.23)
    ctx.lineTo(left + crownWidth * 0.31, crownY + crownHeight * 0.53)
    ctx.lineTo(faceCenter.x, crownY)
    ctx.lineTo(right - crownWidth * 0.31, crownY + crownHeight * 0.53)
    ctx.lineTo(right - crownWidth * 0.08, crownY + crownHeight * 0.23)
    ctx.lineTo(right, base)
    ctx.closePath()
    const gold = ctx.createLinearGradient(left, crownY, right, base)
    gold.addColorStop(0, '#fff4a6')
    gold.addColorStop(0.5, '#ffbd45')
    gold.addColorStop(1, '#fff1a2')
    ctx.fillStyle = gold
    ctx.strokeStyle = '#fff9ce'
    ctx.lineWidth = Math.max(2, faceWidth * 0.014)
    ctx.shadowColor = '#ffd25b'
    ctx.shadowBlur = 14 * scale
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#ff5da8'
    for (const x of [left + crownWidth * 0.08, faceCenter.x, right - crownWidth * 0.08]) {
      ctx.beginPath()
      ctx.arc(x, crownY + crownHeight * 0.53, faceWidth * 0.025, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  if (lens === 'dream') {
    const gradient = ctx.createRadialGradient(faceCenter.x, faceCenter.y, faceWidth * 0.1, faceCenter.x, faceCenter.y, faceWidth * 0.68)
    gradient.addColorStop(0, '#ffd88c16')
    gradient.addColorStop(0.7, '#c092ff24')
    gradient.addColorStop(1, '#8ceaff00')
    ctx.fillStyle = gradient
    ctx.fillRect(leftSide.x - faceWidth * 0.2, top.y - faceWidth * 0.3, faceWidth * 1.4, chin.y - top.y + faceWidth * 0.45)
  }

  if (lens === 'crown' || lens === 'dream') {
    const orbit = faceWidth * 0.39
    for (let i = 0; i < 7; i++) {
      const angle = time / 850 + i * Math.PI * 2 / 7
      drawStar(ctx, faceCenter.x + Math.cos(angle) * orbit, top.y + Math.sin(angle) * faceWidth * 0.19, faceWidth * (i % 2 ? 0.018 : 0.028), i % 2 ? '#fff2ad' : '#ffb8f5')
    }
  }

  ctx.restore()
}

export async function createLiveLensSession(source: MediaStream, initialLens: LiveLensId, onStatus: (status: string) => void): Promise<LiveLensSession> {
  if (!HTMLCanvasElement.prototype.captureStream) throw new Error('Live camera lenses are not supported by this browser.')
  onStatus('Loading face lenses...')
  const baseUrl = import.meta.env.BASE_URL
  const vision = await FilesetResolver.forVisionTasks(`${baseUrl}mediapipe/wasm`)
  let landmarker: FaceLandmarker
  try {
    landmarker = await FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: `${baseUrl}models/mediapipe/face_landmarker.task`, delegate: 'GPU' }, runningMode: 'VIDEO', numFaces: 1 })
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: `${baseUrl}models/mediapipe/face_landmarker.task`, delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 1 })
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = source
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Could not start the live camera preview.'))
  })
  await video.play()
  const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not create the live lens canvas.')

  let lens = initialLens
  let frame = 0
  let lastDetection = 0
  let latestFace: Face[] = []
  let stopped = false
  let output: MediaStream
  const draw = (time: number) => {
    if (stopped) return
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      context.filter = lens === 'dream' ? 'saturate(1.22) contrast(1.04) brightness(1.06)' : 'none'
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (time - lastDetection >= 70) {
        lastDetection = time
        try {
          const result = landmarker.detectForVideo(video, time)
          latestFace = result.faceLandmarks[0] || []
          onStatus(latestFace.length ? `${LIVE_LENSES.find(option => option.id === lens)?.name || 'Original'} - face tracked` : lens === 'none' ? 'Camera ready' : 'Center your face to apply the lens')
        } catch { latestFace = [] }
      }
      if (latestFace.length) drawLens(context, latestFace, canvas.width, canvas.height, lens, time)
    }
    frame = requestAnimationFrame(draw)
  }
  draw(0)
  const videoStream = canvas.captureStream(24)
  output = new MediaStream([...videoStream.getVideoTracks(), ...source.getAudioTracks()])
  onStatus('Camera ready')

  return {
    stream: output,
    setLens(next) { lens = next; latestFace = []; onStatus(next === 'none' ? 'Camera ready' : 'Center your face to apply the lens') },
    stop() { stopped = true; cancelAnimationFrame(frame); video.pause(); video.srcObject = null; landmarker.close(); videoStream.getTracks().forEach(track => track.stop()) },
  }
}

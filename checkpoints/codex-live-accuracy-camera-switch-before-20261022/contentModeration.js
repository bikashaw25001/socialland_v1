import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline, RawImage, env } from '@huggingface/transformers'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const modelId = process.env.CONTENT_MODERATION_MODEL || 'Rekib23r/nsfw_image_detection-ONNX'
env.cacheDir = process.env.CONTENT_MODERATION_CACHE || path.join(moduleDir, 'model-cache')
env.allowRemoteModels = true

let classifierPromise
const classifier = () => {
  if (!classifierPromise) {
    classifierPromise = pipeline('image-classification', modelId, { dtype: 'q8' }).catch(error => {
      classifierPromise = null
      throw error
    })
  }
  return classifierPromise
}

const run = (command, args, timeoutMs = 75_000) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('close', code => {
    clearTimeout(timer)
    if (code === 0) resolve()
    else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`))
  })
})

const classifyImage = async filePath => {
  const image = await RawImage.read(filePath)
  const result = await (await classifier())(image, { top_k: 2 })
  const predictions = Array.isArray(result) ? result : []
  const nsfw = predictions.find(item => /nsfw|explicit|unsafe/i.test(String(item.label)))
  return { flagged: !!nsfw && Number(nsfw.score) >= Number(process.env.CONTENT_MODERATION_THRESHOLD || 0.88), label: nsfw?.label || '', score: Number(nsfw?.score || 0) }
}

const extractVideoFrames = async (filePath, ffmpegPath) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'social-land-moderation-'))
  try {
    // Reels are capped at 60 seconds. For longer post videos, inspect the first
    // minute with 12 evenly spaced samples to bound CPU and scan time.
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath, '-t', '60', '-vf', 'fps=1/5,scale=640:-2:force_original_aspect_ratio=decrease', '-frames:v', '12', path.join(directory, 'frame-%02d.jpg')])
    return (await fs.promises.readdir(directory)).filter(name => name.endsWith('.jpg')).sort().map(name => path.join(directory, name))
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function warmContentModeration() {
  await classifier()
}

export async function scanModerationFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 350_000) throw new Error('Invalid moderation frame.')
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'social-land-live-moderation-'))
  const filePath = path.join(directory, 'frame.jpg')
  try {
    await fs.promises.writeFile(filePath, buffer)
    return await classifyImage(filePath)
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
}

export async function scanUploadedMedia(files, { ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
  const temporaryDirectories = new Set()
  try {
    for (const file of files) {
      const isVideo = String(file.mimetype || '').startsWith('video/')
      let candidates = [file.path]
      if (isVideo) {
        const frames = await extractVideoFrames(file.path, ffmpegPath)
        if (frames.length) {
          candidates = frames
          temporaryDirectories.add(path.dirname(frames[0]))
        }
      }
      for (const candidate of candidates) {
        const result = await classifyImage(candidate)
        if (result.flagged) return { flagged: true, label: result.label, score: result.score }
      }
    }
    return { flagged: false }
  } finally {
    await Promise.all([...temporaryDirectories].map(directory => fs.promises.rm(directory, { recursive: true, force: true })))
  }
}

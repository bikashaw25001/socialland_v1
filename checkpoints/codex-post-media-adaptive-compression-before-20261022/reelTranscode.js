import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const av1Queue = []
let av1Running = false
const enqueueAv1 = task => {
  av1Queue.push(task)
  if (av1Running) return
  av1Running = true
  void (async () => {
    while (av1Queue.length) {
      const next = av1Queue.shift()
      try { await next() } catch (error) { console.warn('Optional AV1 Reel encode failed:', error.message) }
    }
    av1Running = false
  })()
}

const run = (command, args, { capture = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
  let stdout = '', stderr = ''
  if (capture) {
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-6000) })
  }
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`)))
})

export function createReelTranscoder({ outputRoot, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', enableAv1 = process.env.REEL_AV1 !== 'false', av1Encoder = process.env.REEL_AV1_ENCODER || 'libaom-av1' }) {
  return async (sourcePath, postId, { onAv1Ready } = {}) => {
    const stagingDir = path.join(outputRoot, `${postId}.processing-${process.pid}`)
    const finalDir = path.join(outputRoot, String(postId))
    await fs.promises.rm(stagingDir, { recursive: true, force: true })
    await fs.promises.mkdir(stagingDir, { recursive: true })
    for (const variant of ['v0', 'v1', 'v2']) await fs.promises.mkdir(path.join(stagingDir, variant), { recursive: true })

    try {
      const heights = [360, 540, 720]
      const scaleFilter = height => `scale=w='if(gte(iw,ih),min(iw,${height}*16/9),min(iw,${height}*9/16))':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`
      const filters = '[0:v:0]split=3[v0in][v1in][v2in];' + heights.map((height, index) =>
        `[v${index}in]${scaleFilter(height)},setsar=1[v${index}]`
      ).join(';')
      const videoRates = ['500k', '1100k', '2200k'], audioRates = ['64k', '96k', '128k']
      const buildHlsArgs = includeAudio => {
        const args = ['-hide_banner', '-y', '-i', sourcePath, '-filter_complex', filters]
        for (let i = 0; i < 3; i++) { args.push('-map', `[v${i}]`); if (includeAudio) args.push('-map', '0:a:0?') }
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-sc_threshold:v', '0', '-force_key_frames', 'expr:gte(t,n_forced*4)')
        for (let i = 0; i < 3; i++) args.push(`-b:v:${i}`, videoRates[i], `-maxrate:v:${i}`, videoRates[i], `-bufsize:v:${i}`, `${parseInt(videoRates[i], 10) * 2}k`, `-g:v:${i}`, '96', `-keyint_min:v:${i}`, '96')
        if (includeAudio) { args.push('-c:a', 'aac', '-ac', '2'); for (let i = 0; i < 3; i++) args.push(`-b:a:${i}`, audioRates[i]) }
        const streamMap = includeAudio ? 'v:0,a:0,name:low v:1,a:1,name:mid v:2,a:2,name:high' : 'v:0,name:low v:1,name:mid v:2,name:high'
        args.push('-var_stream_map', streamMap, '-master_pl_name', 'master.m3u8', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments', '-hls_segment_filename', path.join(stagingDir, 'v%v', 'segment_%03d.ts'), path.join(stagingDir, 'v%v', 'index.m3u8'))
        return args
      }
      try { await run(ffmpegPath, buildHlsArgs(true)) } catch {
        await fs.promises.rm(stagingDir, { recursive: true, force: true })
        await fs.promises.mkdir(stagingDir, { recursive: true })
        await run(ffmpegPath, buildHlsArgs(false))
      }

      // FFmpeg emits Windows path separators in playlists when running on Windows.
      for (const directoryEntry of await fs.promises.readdir(stagingDir, { withFileTypes: true })) {
        const playlists = directoryEntry.isDirectory()
          ? await fs.promises.readdir(path.join(stagingDir, directoryEntry.name))
          : [directoryEntry.name]
        for (const filename of playlists.filter(name => name.endsWith('.m3u8'))) {
          const playlistPath = path.join(stagingDir, directoryEntry.isDirectory() ? directoryEntry.name : '', filename)
          const playlist = await fs.promises.readFile(playlistPath, 'utf8')
          await fs.promises.writeFile(playlistPath, playlist.replaceAll('\\', '/'))
        }
      }

      const master = await fs.promises.readFile(path.join(stagingDir, 'master.m3u8'), 'utf8')
      if (!master.includes('#EXT-X-STREAM-INF')) throw new Error('Transcoder did not produce an HLS master playlist.')
      await fs.promises.rm(finalDir, { recursive: true, force: true })
      await fs.promises.rename(stagingDir, finalDir)
      const adaptive = { masterUrl: `/reel-streams/${postId}/master.m3u8`, av1Url: '', codecs: { adaptive: 'h264', av1: false } }

      if (enableAv1 && av1Encoder) {
        const av1Path = path.join(finalDir, 'av1.mp4'), tempPath = path.join(finalDir, 'av1.processing.mp4')
        const av1Args = ['-hide_banner', '-y', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `${scaleFilter(720)},setsar=1`, '-c:v', av1Encoder]
        if (av1Encoder === 'libsvtav1') av1Args.push('-preset', '8', '-crf', '34')
        else av1Args.push('-cpu-used', '8', '-crf', '34', '-b:v', '0', '-row-mt', '1')
        av1Args.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tempPath)
        enqueueAv1(async () => {
          try {
            await run(ffmpegPath, av1Args)
            await fs.promises.rename(tempPath, av1Path)
            adaptive.av1Url = `/reel-streams/${postId}/av1.mp4`
            adaptive.codecs.av1 = true
            await onAv1Ready?.(adaptive)
          } catch (error) {
            await fs.promises.rm(tempPath, { force: true }).catch(() => {})
            throw error
          }
        })
      }
      return adaptive
    } catch (error) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
}

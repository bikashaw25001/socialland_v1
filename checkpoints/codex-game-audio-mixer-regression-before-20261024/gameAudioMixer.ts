type RemoteAudioNode = {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  gain: GainNode
}

/** Keeps incoming game audio ready for streams that arrive after the user's
 * autoplay-unlock tap. Speaker and per-player mute choices stay local. */
export class GameAudioMixer {
  private context: AudioContext | null = null
  private streams = new Map<string, MediaStream>()
  private nodes = new Map<string, RemoteAudioNode>()
  private mutedUsers = new Set<string>()
  private speakerEnabled = true

  get isUnlocked() { return this.context?.state === 'running' }

  async unlock() {
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext({ latencyHint: 'interactive' })
    if (this.context.state !== 'running') await this.context.resume()
    this.sync()
  }

  setStream(userId: string, stream: MediaStream | null) {
    if (!stream) {
      this.streams.delete(userId)
      this.removeNode(userId)
      return
    }
    this.streams.set(userId, stream)
    this.sync()
  }

  setSpeakerEnabled(enabled: boolean) {
    this.speakerEnabled = enabled
    this.syncGains()
    if (enabled && !this.isUnlocked) void this.unlock().catch(() => {})
  }

  setMutedUsers(userIds: string[]) {
    this.mutedUsers = new Set(userIds)
    this.syncGains()
  }

  dispose() {
    for (const userId of this.nodes.keys()) this.removeNode(userId)
    this.streams.clear()
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }

  private sync() {
    if (!this.context || this.context.state !== 'running') return
    for (const [userId, stream] of this.streams) {
      const current = this.nodes.get(userId)
      if (current?.stream === stream) continue
      this.removeNode(userId)
      try {
        const source = this.context.createMediaStreamSource(stream)
        const gain = this.context.createGain()
        source.connect(gain)
        gain.connect(this.context.destination)
        this.nodes.set(userId, { stream, source, gain })
      } catch {
        // A stream without an audio track may arrive before its first audio frame.
        continue
      }
    }
    this.syncGains()
  }

  private syncGains() {
    for (const [userId, node] of this.nodes) node.gain.gain.value = this.speakerEnabled && !this.mutedUsers.has(userId) ? 1 : 0
  }

  private removeNode(userId: string) {
    const node = this.nodes.get(userId)
    if (!node) return
    node.source.disconnect()
    node.gain.disconnect()
    this.nodes.delete(userId)
  }
}

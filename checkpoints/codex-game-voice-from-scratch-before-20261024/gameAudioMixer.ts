type RemoteAudioNode = {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  gain: GainNode
}

/** Mixes incoming peers into one persistent output unlocked by a user gesture. */
export class GameAudioMixer {
  private context: AudioContext | null = null
  private destination: MediaStreamAudioDestinationNode | null = null
  private output: HTMLAudioElement | null = null
  private streams = new Map<string, MediaStream>()
  private nodes = new Map<string, RemoteAudioNode>()
  private mutedUsers = new Set<string>()
  private speakerEnabled = true

  get isUnlocked() { return this.context?.state === 'running' && !this.output?.paused }

  attachOutput(output: HTMLAudioElement) {
    this.output = output
    output.autoplay = true
    output.setAttribute('playsinline', '')
    output.muted = false
    output.volume = 1
    this.ensureContext()
    if (this.destination && output.srcObject !== this.destination.stream) output.srcObject = this.destination.stream
  }

  async unlock() {
    this.ensureContext()
    if (this.output && this.destination && this.output.srcObject !== this.destination.stream) this.output.srcObject = this.destination.stream
    // Start play before awaiting resume so browsers tie playback to the tap.
    const playback = this.output?.play()
    if (this.context?.state !== 'running') await this.context?.resume()
    this.sync()
    await playback
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
  }

  setMutedUsers(userIds: string[]) {
    this.mutedUsers = new Set(userIds)
    this.syncGains()
  }

  dispose() {
    for (const userId of [...this.nodes.keys()]) this.removeNode(userId)
    this.streams.clear()
    const context = this.context
    this.context = null
    this.destination = null
    if (this.output) {
      this.output.pause()
      this.output.srcObject = null
      this.output = null
    }
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }

  private ensureContext() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.destination = this.context.createMediaStreamDestination()
    }
    if (this.output && this.destination && this.output.srcObject !== this.destination.stream) this.output.srcObject = this.destination.stream
    this.sync()
  }

  private sync() {
    if (!this.context || !this.destination) return
    for (const [userId, stream] of this.streams) {
      const current = this.nodes.get(userId)
      if (current?.stream === stream) continue
      this.removeNode(userId)
      try {
        const source = this.context.createMediaStreamSource(stream)
        const gain = this.context.createGain()
        source.connect(gain)
        gain.connect(this.destination)
        this.nodes.set(userId, { stream, source, gain })
      } catch {
        // A peer can briefly report a stream before its audio track is usable.
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


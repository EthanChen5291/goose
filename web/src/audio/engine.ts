/**
 * The audio engine: one AudioContext, decoded buffers, and sample-accurate starts.
 *
 * The pygame build asks `pygame.mixer.music.play()` to start "now" and then spends
 * the rest of the song slewing the clock toward wherever the mixer actually got to.
 * Here the song is scheduled to begin at a stated AudioContext time, that same time
 * anchors the ChartClock, and the two cannot drift apart afterwards, because both
 * are the audio hardware's sample clock.
 *
 * Hitsounds go through their own gain node so the music volume and the hitsound
 * volume stay independent, as in settings.json.
 */

export class AudioEngine {
  readonly ctx: AudioContext
  readonly musicGain: GainNode
  readonly sfxGain: GainNode

  private buffers = new Map<string, AudioBuffer>()
  private source: AudioBufferSourceNode | null = null
  private startedAt = 0
  private pausedAtOffset: number | null = null

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.musicGain = this.ctx.createGain()
    this.sfxGain = this.ctx.createGain()
    this.musicGain.connect(this.ctx.destination)
    this.sfxGain.connect(this.ctx.destination)
  }

  /** Browsers hold the context suspended until a gesture; call this from a click. */
  async unlock(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  async load(url: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(url)
    if (cached) return cached
    const res = await fetch(url)
    if (!res.ok) throw new Error(`audio ${res.status}: ${url}`)
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer())
    this.buffers.set(url, buf)
    return buf
  }

  set musicVolume(v: number) { this.musicGain.gain.value = v }
  set sfxVolume(v: number) { this.sfxGain.gain.value = v }

  /**
   * Schedule the song to begin at `when` (an AudioContext time), or as soon as
   * possible if that moment has already passed.  Returns the time it will actually
   * start, which is what the ChartClock rebases on.
   */
  playMusic(url: string, when?: number, offset = 0): number {
    const buf = this.buffers.get(url)
    if (!buf) throw new Error(`not loaded: ${url}`)
    this.stopMusic()
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.musicGain)
    const at = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime)
    src.start(at, offset)
    this.source = src
    this.startedAt = at - offset
    this.pausedAtOffset = null
    return at
  }

  stopMusic(): void {
    if (this.source) {
      try { this.source.stop() } catch { /* already stopped */ }
      this.source.disconnect()
      this.source = null
    }
  }

  /** Seconds of the song that have played (its own position, not chart time). */
  get musicPosition(): number {
    if (this.pausedAtOffset !== null) return this.pausedAtOffset
    if (!this.source) return 0
    return this.ctx.currentTime - this.startedAt
  }

  pauseMusic(): void {
    if (!this.source || this.pausedAtOffset !== null) return
    this.pausedAtOffset = this.musicPosition
    this.stopMusic()
  }

  resumeMusic(url: string): number {
    const off = this.pausedAtOffset ?? 0
    const at = this.playMusic(url, this.ctx.currentTime, off)
    return at
  }

  /** Fade the music out over `ms`, then stop it — the end-of-song outro. */
  fadeOutMusic(ms: number): void {
    if (!this.source) return
    const g = this.musicGain.gain
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0.0001, now + ms / 1000)
    const src = this.source
    setTimeout(() => {
      if (this.source === src) this.stopMusic()
      g.cancelScheduledValues(this.ctx.currentTime)
      g.value = 1
    }, ms + 50)
  }

  /**
   * Play a one-shot at `when`, or now.  A hit that landed early schedules its
   * sound for the note's own time, which is how the pygame build keeps the
   * hitsound on the beat rather than on the finger.
   */
  playSfx(url: string, when?: number, volume = 1): void {
    const buf = this.buffers.get(url)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    if (volume === 1) {
      src.connect(this.sfxGain)
    } else {
      const g = this.ctx.createGain()
      g.gain.value = volume
      g.connect(this.sfxGain)
      src.connect(g)
    }
    src.start(Math.max(when ?? 0, this.ctx.currentTime))
  }
}

// GPU readbacks for everything sharing a WebGL2 context, taken together at the start of a frame
// and only once the GPU process has caught up with the frame before.
//
// Reading a pixel pack buffer back (`getBufferSubData`) is a synchronous call to the GPU process
// in Chrome, even behind a signalled fence: it waits for whatever that process still has queued.
// Right after a frame of uploads that can be tens of milliseconds. The gate fences the end of
// each frame. Readers submit their fenced readbacks; the first time any reader asks in a frame,
// before that frame has uploaded anything, every submitted readback whose own fence has
// signalled is read, back to back, provided the last frame's fence has signalled too. Reads in
// a row with nothing queued between them cost a fraction of a millisecond.
//
// The passes behind the readbacks (low-resolution redraws of the scene) are optional work the
// GPU does on top of the frame, so they take turns too: `turn` grants one a frame, to whichever
// reader asking has waited longest since its last, so however many readers share the context
// the frame carries at most one extra pass.
//
// The end of a frame is found without a hook into the loop: the first call of a frame queues a
// microtask, which runs once the animation frame callback (and the render in it) has returned.
export interface Readback {
  // Whether the reader's own fence has signalled
  ready(): boolean
  // Reads the data back (binds its buffer and calls getBufferSubData)
  read(): void
}

export default class ReadbackGate {
  private static gates = new WeakMap<WebGL2RenderingContext, ReadbackGate>()

  // The gate shared by every reader on this context
  public static for(gl: WebGL2RenderingContext): ReadbackGate {
    let gate = ReadbackGate.gates.get(gl)
    if (!gate) ReadbackGate.gates.set(gl, (gate = new ReadbackGate(gl)))
    return gate
  }

  private readonly gl: WebGL2RenderingContext
  private frameFence: WebGLSync | null = null
  private frameOpen = false
  private readThisFrame = false
  private submitted = new Map<object, Readback>()
  private done = new Set<object>()
  private reads = 0
  private deferred = 0
  private frame = 0
  private turnTaken = false
  // Each reader's last turn and last ask, by frame; one that stops asking drops out after a frame
  private turnAt = new Map<object, number>()
  private askedAt = new Map<object, number>()
  private turns = 0

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  public get stats(): { reads: number; deferred: number; waiting: number; turns: number } {
    return { reads: this.reads, deferred: this.deferred, waiting: this.submitted.size, turns: this.turns }
  }

  // Whether `reader` may render its pass this frame: one a frame, to the reader asking that has
  // waited longest since its last turn. A true answer is the frame's turn; render at once
  public turn(reader: object): boolean {
    this.openFrame()
    this.askedAt.set(reader, this.frame)
    if (this.turnTaken) return false
    const mine = this.turnAt.get(reader) ?? -1
    for (const [other, asked] of this.askedAt) {
      if (other === reader) continue
      if (asked < this.frame - 1) {
        this.askedAt.delete(other)
        this.turnAt.delete(other)
      } else if ((this.turnAt.get(other) ?? -1) < mine) {
        return false
      }
    }
    this.turnTaken = true
    this.turnAt.set(reader, this.frame)
    this.turns++
    return true
  }

  // A readback to take at the start of a coming frame, in place of any the reader had waiting
  public submit(reader: object, readback: Readback): void {
    this.openFrame()
    this.submitted.set(reader, readback)
    this.done.delete(reader)
  }

  // Whether the reader's readback has been read since it was submitted; true once
  public collected(reader: object): boolean {
    this.openFrame()
    if (!this.readThisFrame) this.readAll()
    return this.done.delete(reader)
  }

  // Forgets the reader's readback and turns, as when it is disposed
  public cancel(reader: object): void {
    this.submitted.delete(reader)
    this.done.delete(reader)
    this.askedAt.delete(reader)
    this.turnAt.delete(reader)
  }

  private readAll(): void {
    this.readThisFrame = true
    if (this.submitted.size === 0) return
    const gl = this.gl
    if (this.frameFence && gl.getSyncParameter(this.frameFence, gl.SYNC_STATUS) !== gl.SIGNALED) {
      this.deferred++
      return
    }
    for (const [reader, readback] of this.submitted) {
      if (!readback.ready()) continue
      readback.read()
      this.submitted.delete(reader)
      this.done.add(reader)
      this.reads++
    }
  }

  private openFrame(): void {
    if (this.frameOpen) return
    this.frameOpen = true
    queueMicrotask(() => this.closeFrame())
  }

  private closeFrame(): void {
    const gl = this.gl
    this.frameOpen = false
    this.readThisFrame = false
    this.turnTaken = false
    this.frame++
    if (this.frameFence) gl.deleteSync(this.frameFence)
    this.frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
  }
}

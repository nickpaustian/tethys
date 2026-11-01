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

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  public get stats(): { reads: number; deferred: number; waiting: number } {
    return { reads: this.reads, deferred: this.deferred, waiting: this.submitted.size }
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

  // Forgets the reader's readback, as when it is disposed
  public cancel(reader: object): void {
    this.submitted.delete(reader)
    this.done.delete(reader)
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
    if (this.frameFence) gl.deleteSync(this.frameFence)
    this.frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
  }
}

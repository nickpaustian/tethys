// One GPU readback a frame for everything sharing a WebGL2 context, taken only once the GPU
// process has caught up with the frame before.
//
// Reading a pixel pack buffer back (`getBufferSubData`) is a synchronous call to the GPU process
// in Chrome, even behind a signalled fence: it waits for whatever that process still has queued.
// Right after a frame of uploads that can be tens of milliseconds. The gate fences the end of
// each frame and lets a read through only when the last frame's fence has signalled, at most one
// a frame, to whichever reader asking has waited longest since its last read. A reader turned
// away keeps its data in its buffer and asks again next frame.
//
// The end of a frame is found without a hook into the loop: the first ask of a frame queues a
// microtask, which runs once the animation frame callback (and the render in it) has returned.
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
  private frame = 0
  // Each reader's last read and last ask, by frame; one that stops asking drops out after a frame
  private readAt = new Map<object, number>()
  private askedAt = new Map<object, number>()
  private granted = 0
  private refused = 0

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  public get stats(): { granted: number; refused: number } {
    return { granted: this.granted, refused: this.refused }
  }

  // Whether `reader` may read back now. A true answer is the frame's read: the caller reads at once
  public request(reader: object): boolean {
    this.openFrame()
    const gl = this.gl
    this.askedAt.set(reader, this.frame)
    let allowed = !this.readThisFrame
    if (allowed && this.frameFence) allowed = gl.getSyncParameter(this.frameFence, gl.SYNC_STATUS) === gl.SIGNALED
    if (allowed) {
      const mine = this.readAt.get(reader) ?? -1
      for (const [other, asked] of this.askedAt) {
        if (other === reader) continue
        if (asked < this.frame - 1) {
          this.askedAt.delete(other)
          this.readAt.delete(other)
        }
        else if ((this.readAt.get(other) ?? -1) < mine) allowed = false
      }
    }
    if (!allowed) {
      this.refused++
      return false
    }
    this.readThisFrame = true
    this.readAt.set(reader, this.frame)
    this.granted++
    return true
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
    this.frame++
    if (this.frameFence) gl.deleteSync(this.frameFence)
    this.frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
  }
}

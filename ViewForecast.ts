// Views a host expects the camera to reach soon, so everything streaming for it (geometry,
// textures) can fetch ahead of the camera rather than after it. A host that knows its camera's
// path (a scripted or cinematic camera, a guided tour, a timeline seek) supplies them; streamers
// read the same forecast, so geometry and textures prepare for the same views.
//
// A view is given as a three.js camera stores itself (column-major world matrix and projection),
// so a THREE.Camera placed where the camera will be is one, without Tethys depending on three.
export interface ForecastView {
  matrixWorld: { elements: ArrayLike<number> }
  projectionMatrix: { elements: ArrayLike<number> }
  // Milliseconds until the camera is expected to show this view
  aheadMs: number
  // How sure the host is of it, 0 to 1; 1 when not given
  weight?: number
}

export interface ViewForecast {
  // The views expected from `now` on, soonest first; read once a frame
  views(now: number): readonly ForecastView[]
}

// Milliseconds over which a forecast view's worth halves: what the camera needs in a second is
// worth fetching before what it needs in four
export const FORECAST_HALF_LIFE_MS = 2000

// What a forecast view's wants are worth against the current view's, which count 1: half at
// once, halving again every FORECAST_HALF_LIFE_MS, scaled by the host's weight. Below the
// current view's, so fetching ahead spends only what the view in front of the camera leaves
export const forecastScale = (view: ForecastView): number =>
  0.5 * Math.min(1, Math.max(0, view.weight ?? 1)) * 2 ** (-Math.max(0, view.aheadMs) / FORECAST_HALF_LIFE_MS)

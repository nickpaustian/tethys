import { describe, it, expect } from "vitest"
import { forecastScale, FORECAST_HALF_LIFE_MS } from "../index.js"

const view = (aheadMs: number, weight?: number) => ({ matrixWorld: { elements: [] }, projectionMatrix: { elements: [] }, aheadMs, weight })

describe("forecastScale", () => {
  it("counts a view ahead below the current one, halving every half-life and scaled by the host's weight", () => {
    expect(forecastScale(view(0))).toBe(0.5)
    expect(forecastScale(view(FORECAST_HALF_LIFE_MS))).toBeCloseTo(0.25)
    expect(forecastScale(view(2 * FORECAST_HALF_LIFE_MS, 0.5))).toBeCloseTo(0.0625)
    expect(forecastScale(view(-100, 3))).toBe(0.5)
  })
})

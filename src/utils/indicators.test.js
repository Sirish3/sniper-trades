import { describe, it, expect } from 'vitest'
import { volumeRatio, maxVolumeRatioOverWindow } from './indicators'

// 25 flat baseline days, then the last 5 days: flat, a clear spike 3 days
// ago, flat, flat, a quiet "today". Mirrors the JPM case — broke out on
// volume, now resting on a quiet digestion day.
function volumesWithRecentSpike() {
  const baseline = new Array(25).fill(1_000_000)
  const lastFive = [1_000_000, 2_400_000, 1_000_000, 1_000_000, 800_000] // 4d,3d,2d,1d ago, today
  return [...baseline, ...lastFive]
}

// Same shape, but the only volume spike sits 10 days back — well outside
// the 5-day breakout window — and every day inside the window is flat/quiet.
function volumesWithOldSpikeOnly() {
  const volumes = new Array(30).fill(1_000_000)
  volumes[19] = 5_000_000 // 10 trading days before the last index (29)
  return volumes
}

describe('maxVolumeRatioOverWindow — FIX 1', () => {
  it('picks up a volume spike 3 bars ago even though today is quiet', () => {
    const volumes = volumesWithRecentSpike()
    expect(volumeRatio(volumes, 20)).toBeLessThan(0.9) // today alone reads as quiet

    const best = maxVolumeRatioOverWindow(volumes, 20, 5)
    expect(best.daysAgo).toBe(3)
    expect(best.ratio).toBeGreaterThan(2.0)
  })

  it('does not pick up a spike outside the lookback window — anchored tight', () => {
    const volumes = volumesWithOldSpikeOnly()
    const best = maxVolumeRatioOverWindow(volumes, 20, 5)
    expect(best.ratio).toBeLessThan(1.2) // no day inside the 5-day window clears the MUST floor
  })
})

import { DifficultyUtils } from './difficulty.utils';

describe('DifficultyUtils', () => {
  it('hashRateToDifficulty rises with hashrate', () => {
    const slow = DifficultyUtils.hashRateToDifficulty(1e12, 2);
    const fast = DifficultyUtils.hashRateToDifficulty(1e15, 2);
    expect(fast).toBeGreaterThan(slow);
    expect(Number.isFinite(slow)).toBe(true);
    expect(Number.isFinite(fast)).toBe(true);
  });

  it('clampDifficultyToMaxTarget caps easy difficulties', () => {
    const maxTarget = DifficultyUtils.difficultyToTarget(1000);
    // Harder than maxTarget is allowed (smaller target).
    expect(DifficultyUtils.clampDifficultyToMaxTarget(5000, maxTarget)).toBe(5000);
    // Easier than maxTarget is clamped up to the maxTarget difficulty.
    expect(DifficultyUtils.clampDifficultyToMaxTarget(500, maxTarget)).toBeCloseTo(1000, 5);
  });

  it('meetsCompactTarget accepts genesis-style difficulty-1 nBits', () => {
    const hash = Buffer.alloc(32, 0);
    expect(DifficultyUtils.meetsCompactTarget(hash, 0x1d00ffff)).toBe(true);
  });
});

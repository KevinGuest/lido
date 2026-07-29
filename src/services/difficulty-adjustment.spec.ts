import {
  calcBitsDifference,
  calcDifficultyAdjustmentFromHeaders,
  parseBits,
} from './difficulty-adjustment';

describe('difficulty-adjustment', () => {
  it('parseBits accepts hex strings', () => {
    expect(parseBits('17033c8c')).toBe(0x17033c8c);
  });

  it('calcBitsDifference clamps to protocol bounds', () => {
    // Same exponent: mild increase
    const mild = calcBitsDifference(0x17033c8c, 0x17030000);
    expect(mild).toBeGreaterThan(-75);
    expect(mild).toBeLessThan(300);
  });

  it('calcDifficultyAdjustmentFromHeaders matches epoch math', () => {
    const epochStartHeight = 2016 * 416; // 838656
    const epochStart = { height: epochStartHeight, time: 1_700_000_000, bits: 0x17033c8c };
    const tip = {
      height: epochStartHeight + 1008,
      time: 1_700_000_000 + 1008 * 600,
      bits: 0x17033c8c,
    };
    const now = tip.time + 60;
    const adj = calcDifficultyAdjustmentFromHeaders(tip, epochStart, null, now);
    expect(adj.remainingBlocks).toBe(1008);
    expect(adj.nextRetargetHeight).toBe(epochStartHeight + 2016);
    expect(adj.progressPercent).toBeCloseTo(50, 5);
    expect(adj.timeAvgMs).toBeGreaterThan(0);
    expect(adj.expectedBlocks).toBeCloseTo(1008.1, 0);
  });
});

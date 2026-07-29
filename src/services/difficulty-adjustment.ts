/** Bitcoin mainnet difficulty epoch (same constants mempool.space uses). */
export const EPOCH_BLOCK_LENGTH = 2016;
export const BLOCK_SECONDS_TARGET = 600;

export type DifficultyAdjustment = {
    progressPercent: number;
    difficultyChange: number;
    previousRetarget: number;
    remainingBlocks: number;
    nextRetargetHeight: number;
    estimatedRetargetDate: number;
    timeAvgMs: number;
    expectedBlocks: number;
};

export type BlockHeaderBitsTime = {
    height: number;
    time: number;
    bits: number;
};

/** Parse Core `bits` hex / number into the compact nBits integer. */
export function parseBits(bits: string | number): number {
    if (typeof bits === 'number' && Number.isFinite(bits)) {
        return bits >>> 0;
    }
    const hex = String(bits || '').replace(/^0x/i, '');
    const value = Number.parseInt(hex, 16);
    if (!Number.isFinite(value)) {
        throw new Error(`Invalid bits: ${bits}`);
    }
    return value >>> 0;
}

/**
 * Difficulty % change between two adjacent-epoch `bits` values.
 * Clamped to protocol bounds (−75% … +300%).
 */
export function calcBitsDifference(oldBits: number, newBits: number): number {
    const oldExp = oldBits >>> 24;
    const newExp = newBits >>> 24;
    const oldNum = oldBits & 0x007fffff;
    const newNum = newBits & 0x007fffff;
    let result: number;
    switch (newExp - oldExp) {
        case -1:
            result = ((oldNum << 8) * 100) / newNum - 100;
            break;
        case 0:
            result = (oldNum * 100) / newNum - 100;
            break;
        case 1:
            result = (oldNum * 100) / (newNum << 8) - 100;
            break;
        default:
            return 0;
    }
    if (result > 300) return 300;
    if (result < -75) return -75;
    return result;
}

/**
 * Epoch progress / ETA from tip + last-adjustment headers (Bitcoin Core RPC).
 * Mirrors mempool's calcDifficultyAdjustment (without early-epoch 504-block window).
 */
export function calcDifficultyAdjustmentFromHeaders(
    tip: BlockHeaderBitsTime,
    epochStart: BlockHeaderBitsTime,
    previousEpochStart: BlockHeaderBitsTime | null,
    nowSeconds = Math.floor(Date.now() / 1000),
): DifficultyAdjustment {
    const blockHeight = tip.height;
    const blocksInEpoch = blockHeight % EPOCH_BLOCK_LENGTH;
    const progressPercent = (blocksInEpoch / EPOCH_BLOCK_LENGTH) * 100;
    const remainingBlocks = EPOCH_BLOCK_LENGTH - blocksInEpoch;
    const nextRetargetHeight = blockHeight + remainingBlocks;

    const DATime = epochStart.time;
    const diffSeconds = Math.max(0, nowSeconds - DATime);
    const expectedBlocks = diffSeconds / BLOCK_SECONDS_TARGET;
    const actualTimespan =
        (blocksInEpoch === EPOCH_BLOCK_LENGTH - 1 ? tip.time : nowSeconds) - DATime;

    let difficultyChange = 0;
    const timeAvgSecs = blocksInEpoch
        ? diffSeconds / blocksInEpoch
        : BLOCK_SECONDS_TARGET;
    if (blocksInEpoch > 0 && actualTimespan > 0) {
        difficultyChange =
            (BLOCK_SECONDS_TARGET / (actualTimespan / (blocksInEpoch + 1)) - 1) * 100;
    }
    if (difficultyChange > 300) difficultyChange = 300;
    if (difficultyChange < -75) difficultyChange = -75;

    let previousRetarget = 0;
    if (previousEpochStart) {
        try {
            previousRetarget = calcBitsDifference(previousEpochStart.bits, epochStart.bits);
        } catch {
            previousRetarget = 0;
        }
    }

    const timeAvgMs = Math.floor(timeAvgSecs * 1000);
    const remainingTime = remainingBlocks * timeAvgMs;
    const estimatedRetargetDate = remainingTime + nowSeconds * 1000;

    return {
        progressPercent,
        difficultyChange,
        previousRetarget,
        remainingBlocks,
        nextRetargetHeight,
        estimatedRetargetDate,
        timeAvgMs,
        expectedBlocks,
    };
}

import * as bitcoinjs from 'bitcoinjs-lib';

const TRUE_DIFF_ONE = 2.695953529101131e67;
const TRUE_DIFF_ONE_BIGINT = BigInt(
  '26959535291011309493156476344723991336010898738574164086137773096960',
);

export class DifficultyUtils {
  static calculateDifficulty(header: Buffer): {
    submissionDifficulty: number;
    submissionHash: string;
    hashBuffer: Buffer;
  } {
    const hashResult = bitcoinjs.crypto.hash256(
      Buffer.isBuffer(header) ? header : Buffer.from(header as unknown as string, 'hex'),
    );
    const target = DifficultyUtils.le256todouble(hashResult);
    const difficulty = target === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE / target;

    return {
      submissionDifficulty: difficulty,
      submissionHash: hashResult.toString('hex'),
      hashBuffer: hashResult,
    };
  }

  /** Convert a share difficulty into a 32-byte little-endian SV2 target. */
  static difficultyToTarget(difficulty: number): Buffer {
    if (!Number.isFinite(difficulty) || difficulty <= 0) {
      return Buffer.alloc(32, 0xff);
    }

    const scale = 1_000_000n;
    const diffScaled = BigInt(Math.round(difficulty * Number(scale)));
    if (diffScaled === 0n) {
      return Buffer.alloc(32, 0xff);
    }

    return DifficultyUtils.bigIntToLe256((TRUE_DIFF_ONE_BIGINT * scale) / diffScaled);
  }

  /** True when hash ≤ target (both little-endian 256-bit). */
  static meetsTarget(hashBuffer: Buffer, target: Buffer): boolean {
    if (hashBuffer.length !== 32 || target.length !== 32) {
      throw new Error('Hash and target must be 32 bytes');
    }
    return DifficultyUtils.compareLe256(hashBuffer, target) <= 0;
  }

  static clampDifficultyToMaxTarget(difficulty: number, maxTarget: Buffer): number {
    if (!maxTarget || maxTarget.length !== 32 || DifficultyUtils.isZeroTarget(maxTarget)) {
      return difficulty;
    }
    if (DifficultyUtils.compareLe256(DifficultyUtils.difficultyToTarget(difficulty), maxTarget) > 0) {
      const clamped = DifficultyUtils.targetToDifficulty(maxTarget);
      return Number.isFinite(clamped) && clamped > 0 ? clamped : difficulty;
    }
    return difficulty;
  }

  static targetToDifficulty(target: Buffer): number {
    const targetNumber = DifficultyUtils.le256todouble(target);
    return targetNumber === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE / targetNumber;
  }

  private static isZeroTarget(target: Buffer): boolean {
    return target.every(byte => byte === 0);
  }

  private static bigIntToLe256(value: bigint): Buffer {
    const buf = Buffer.alloc(32);
    let remaining = value;
    for (let i = 0; i < 32; i++) {
      buf[i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return buf;
  }

  private static compareLe256(left: Buffer, right: Buffer): number {
    for (let i = 31; i >= 0; i--) {
      const diff = left[i] - right[i];
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }

  private static le256todouble(target: Buffer): number {
    let number = 0;
    for (let i = target.length - 1; i >= 0; i--) {
      number = number * 256 + target[i];
    }
    return number;
  }
}

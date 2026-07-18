import { TOTAL_EXTRANONCE_SIZE_BYTES } from '../models/stratum.constants';

/**
 * SV1 MiningJob templates reserve TOTAL_EXTRANONCE_SIZE_BYTES (12) in the
 * coinbase script. SV2 extended channels use a larger total (typically 14);
 * bump the BIP34 script length byte so the miner-supplied extranonce fits.
 */
export function patchCoinbasePrefixVarint(
    prefix: Buffer,
    totalExtranonceSize: number,
): Buffer {
    if (totalExtranonceSize === TOTAL_EXTRANONCE_SIZE_BYTES) {
        return prefix;
    }
    if (prefix.length < 42) {
        return prefix;
    }

    const patched = Buffer.from(prefix);
    const nextLength = patched[41] + (totalExtranonceSize - TOTAL_EXTRANONCE_SIZE_BYTES);
    if (nextLength < 0 || nextLength > 0xfc) {
        return prefix;
    }

    patched[41] = nextLength;
    return patched;
}

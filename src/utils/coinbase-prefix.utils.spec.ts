import { TOTAL_EXTRANONCE_SIZE_BYTES } from '../models/stratum.constants';
import { patchCoinbasePrefixVarint } from './coinbase-prefix.utils';

describe('patchCoinbasePrefixVarint', () => {
    it('returns the same buffer when total matches the V1 slot', () => {
        const prefix = Buffer.alloc(50, 0x11);
        prefix[41] = 40;
        const result = patchCoinbasePrefixVarint(prefix, TOTAL_EXTRANONCE_SIZE_BYTES);
        expect(result).toBe(prefix);
        expect(result[41]).toBe(40);
    });

    it('bumps script length by +2 for a 14-byte total', () => {
        const prefix = Buffer.alloc(50, 0x11);
        prefix[41] = 40;
        const result = patchCoinbasePrefixVarint(prefix, 14);
        expect(result).not.toBe(prefix);
        expect(result[41]).toBe(42);
        expect(prefix[41]).toBe(40);
    });

    it('leaves short prefixes untouched', () => {
        const prefix = Buffer.alloc(20, 0x22);
        expect(patchCoinbasePrefixVarint(prefix, 14)).toBe(prefix);
    });
});

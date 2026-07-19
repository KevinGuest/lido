import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const AUTHORITY_PRIVKEY_FILENAME = 'sv2-authority.privkey';

/** Trim, strip 0x, require 64 hex chars. */
export function normalizeSv2AuthorityPrivKeyHex(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  let value = raw.trim();
  if (value.toLowerCase().startsWith('0x')) {
    value = value.slice(2);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

export function authorityPrivKeyFilePath(dbDir = path.join(process.cwd(), 'DB')): string {
  return path.join(dbDir, AUTHORITY_PRIVKEY_FILENAME);
}

/**
 * Resolve the pool authority private key:
 * 1. SV2_AUTHORITY_PRIVKEY env (if valid hex)
 * 2. Persisted file under DB/ (survives Umbrel restarts)
 * 3. Generate + persist a new key
 */
export function resolveSv2AuthorityPrivKey(
  configuredRaw: string | undefined | null,
  dbDir = path.join(process.cwd(), 'DB'),
): { privKey: Buffer; source: 'env' | 'persisted' | 'generated' } {
  const fromEnv = normalizeSv2AuthorityPrivKeyHex(configuredRaw);
  if (fromEnv) {
    return { privKey: Buffer.from(fromEnv, 'hex'), source: 'env' };
  }

  const filePath = authorityPrivKeyFilePath(dbDir);
  try {
    if (fs.existsSync(filePath)) {
      const fromFile = normalizeSv2AuthorityPrivKeyHex(fs.readFileSync(filePath, 'utf8'));
      if (fromFile) {
        return { privKey: Buffer.from(fromFile, 'hex'), source: 'persisted' };
      }
    }
  } catch (error) {
    console.warn(
      `Failed to read persisted SV2 authority key: ${(error as Error).message}`,
    );
  }

  const generated = crypto.randomBytes(32);
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(filePath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.warn(
      `Failed to persist SV2 authority key (ephemeral this run): ${(error as Error).message}`,
    );
    return { privKey: generated, source: 'generated' };
  }

  return { privKey: generated, source: 'generated' };
}

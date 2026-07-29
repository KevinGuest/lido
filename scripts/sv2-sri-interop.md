# SV2 ↔ SRI interop runbook

Use the [Stratum Reference Implementation](https://github.com/stratum-mining/stratum) libraries and [sv2-apps](https://github.com/stratum-mining/sv2-apps) roles as a conformance oracle against Lido’s TypeScript Mining Protocol pool.

Lido does **not** link SRI crates. This is a manual / maintainer smoke path (optional CI later if Docker + SRI binaries are available).

## Prerequisites

1. Lido running with `ENABLE_STRATUM_V2=true` and `STRATUM_V2_PORT` published (default `4444`).
2. Pool authority pubkey from `GET /api/info/sv2` → `authorityPublicKey`.
3. A Bitcoin node + templates flowing (so jobs / `SetNewPrevHash` appear).
4. SRI tooling from **sv2-apps** (translator and/or `mining-device` test utility) built or pulled via their docs.

## Quick preflight

```bash
node scripts/sv2-sri-interop-smoke.js
# or with a custom API base:
# LIDO_API_BASE=http://127.0.0.1:3334 node scripts/sv2-sri-interop-smoke.js
```

The smoke script only checks that SV2 is enabled and prints the authority key + reject counters. It does not speak Noise/SV2.

## Point SRI at Lido

Configure the SRI translator or mining-device upstream to:

| Setting | Value |
| --- | --- |
| Host / port | Lido host + `STRATUM_V2_PORT` (e.g. `127.0.0.1:4444`) |
| Authority public key | `authorityPublicKey` from `/api/info/sv2` |
| Protocol | Mining Protocol only (no JDP/TDP on Lido) |

Do **not** set `REQUIRES_WORK_SELECTION` — Lido rejects that flag until custom-job support exists.

## Checklist

Exercise each item and note pass/fail:

- [ ] Noise NX handshake completes (AES-GCM / ChaCha path as configured)
- [ ] `SetupConnection` → `SetupConnectionSuccess` (Mining, version 2)
- [ ] `SetupConnection` with `REQUIRES_WORK_SELECTION` → `unsupported-feature-flags` and disconnect
- [ ] Open **standard** mining channel → success + `NewMiningJob` / `SetNewPrevHash` / `SetTarget`
- [ ] Open **extended** mining channel → success + extended job path
- [ ] Valid share → `SubmitSharesSuccess`
- [ ] Invalid share (e.g. wrong job id) → `SubmitSharesError` with expected code; `/api/info/sv2` `rejectedSharesByCode` increments
- [ ] `UpdateChannel` with new hashrate → optional `SetTarget`
- [ ] `CloseChannel` / clean disconnect releases session

## Related repos

- Protocol crates: https://github.com/stratum-mining/stratum
- Pool / translator / JD apps: https://github.com/stratum-mining/sv2-apps
- Spec: https://github.com/stratum-mining/sv2-spec

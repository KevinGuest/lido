# Lido

NestJS + TypeScript solo Bitcoin stratum mining server. Fork of [Public Pool](https://github.com/benjamin-wilson/public-pool) with Stratum V1 + V2, Discord/Telegram alerts, and Umbrel packaging.

Companion dashboard: [`lido-ui`](https://github.com/KevinGuest/lido-ui) · Umbrel app: [`lido-app`](https://github.com/KevinGuest/lido-app)

## Installation

```bash
npm install
```

Copy `.env.example` to `.env` and fill in Bitcoin RPC (and optional alert) settings. Requires Node.js `>=22.12.0`.

## Running the app

```bash
# development
npm run start

# watch mode
npm run start:dev

# production build
npm run build
npm run start:prod
```

## Test

```bash
npm run test
npm run test:cov
```

## Web interface

See sibling [`lido-ui`](https://github.com/KevinGuest/lido-ui). Useful pool endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/client` | List all workers |
| `GET /api/info/sv2` | Stratum V2 authority public key |
| `GET /api/widgets/workers` | Umbrel workers widget |

## Stratum V2

Optional dual-stack Mining Protocol listener (Noise + standard/extended channels) on `STRATUM_V2_PORT` (default `4444`). Enable with `ENABLE_STRATUM_V2=true`. Stratum V1 on `STRATUM_PORT` is unchanged.

See `.env.example` for `SV2_AUTHORITY_PRIVKEY`, `SV2_START_DIFFICULTY`, and `SV2_TARGET_SHARES_PER_MINUTE`.

Miners need the pool authority public key for Noise auth. Lido exposes it at `GET /api/info/sv2` (`authorityPublicKey`) and shows it in the Connect dialog’s SV2 tab. If `SV2_AUTHORITY_PRIVKEY` is unset, a key is generated and persisted under `DB/sv2-authority.privkey` so the pubkey survives restarts.

Job Declaration / Template Distribution protocols are not included.

## Alerts

Optional Discord and Telegram notifications for blocks found, struggling miners, and pool digests. Configure via `.env` (`DISCORD_*`, `TELEGRAM_*`) or the UI Settings page when running with `lido-ui`. See `.env.example`.

## Deployment

Image: `ghcr.io/kevinguest/lido` (published by `.github/workflows/publish.yml`).

Umbrel pulls this as the `server` service together with `ghcr.io/kevinguest/lido-ui` — not upstream `benjamin-wilson/public-pool`.

### PM2

```bash
pm2 start dist/main.js
```

When running in PM2 cluster mode, start the PM2 daemon with OS-level connection scheduling. The environment variable must be present when the PM2 daemon starts, not only in the worker configuration:

```bash
NODE_CLUSTER_SCHED_POLICY=none pm2 start ecosystem.config.js
```

Cluster-mode connection dropping requires Node.js `22.12.0` or newer.

`STRATUM_MAX_CONNECTIONS_PER_LISTENER` is enforced per worker and Stratum port. Size it using the busiest port: `worker count * limit`. For example, 28 workers with the default limit of `10000` allow up to `280000` connections on one port.

## Docker

Build:

```bash
docker build -t lido .
```

Run (Stratum V1 + API; enable SV2 in `.env` and publish `4444` if needed):

```bash
docker container run --name lido --rm \
  -p 3333:3333 -p 2299:2299 \
  -v .env:/public-pool/.env \
  lido
```

Container paths still use `/public-pool` (historical WORKDIR).

### Docker Compose

```bash
docker compose build
docker compose up -d
```

Binds to `127.0.0.1` by default. To expose Stratum on the host:

```diff
    ports:
-      - "127.0.0.1:3333:3333/tcp"
+      - "3333:3333/tcp"
```

To reach Bitcoin RPC from Docker, add to `bitcoin.conf`:

```
rpcallowip=172.16.0.0/12
```

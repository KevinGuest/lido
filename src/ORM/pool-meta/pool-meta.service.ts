import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsService } from '../client-statistics/client-statistics.service';
import { PoolMetaEntity } from './pool-meta.entity';

const SINGLETON_ID = 1;
const UPTIME_FLUSH_MS = 60_000;

@Injectable()
export class PoolMetaService implements OnModuleInit, OnModuleDestroy {
    private cachedStartedAt: Date | null = null;
    private cumulativeUptimeMs = 0;
    private rolledUpAcceptedShares = 0;
    private rolledUpRejectedShares = 0;
    /** Wall clock when this process session began (or last flush baseline). */
    private sessionAnchorMs = Date.now();
    private flushTimer: NodeJS.Timeout | null = null;

    constructor(
        @InjectRepository(PoolMetaEntity)
        private readonly poolMetaRepository: Repository<PoolMetaEntity>,
        private readonly clientStatisticsService: ClientStatisticsService,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.ensureLoaded();
        this.sessionAnchorMs = Date.now();
        if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE === '0') {
            this.flushTimer = setInterval(() => {
                void this.flushUptime().catch((error) => {
                    console.warn(`Failed to flush pool uptime: ${(error as Error).message}`);
                });
            }, UPTIME_FLUSH_MS);
        }
    }

    async onModuleDestroy(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flushUptime();
    }

    /** Earliest durable pool start — created once, then reused across restarts. */
    public async getStartedAt(): Promise<Date> {
        await this.ensureLoaded();
        return this.cachedStartedAt!;
    }

    /** Combined process uptime across all Lido sessions (seconds). */
    public async getOverallUptimeSeconds(): Promise<number> {
        await this.ensureLoaded();
        const liveMs = Math.max(0, Date.now() - this.sessionAnchorMs);
        return Math.floor((this.cumulativeUptimeMs + liveMs) / 1000);
    }

    public async getRolledUpShares(): Promise<{ accepted: number; rejected: number }> {
        await this.ensureLoaded();
        return {
            accepted: this.rolledUpAcceptedShares,
            rejected: this.rolledUpRejectedShares,
        };
    }

    public async addRolledUpShares(accepted: number, rejected: number): Promise<void> {
        const addAccepted = Math.max(0, Math.floor(accepted) || 0);
        const addRejected = Math.max(0, Math.floor(rejected) || 0);
        if (addAccepted === 0 && addRejected === 0) {
            return;
        }
        await this.ensureLoaded();
        this.rolledUpAcceptedShares += addAccepted;
        this.rolledUpRejectedShares += addRejected;
        await this.persistMeta();
    }

    private async flushUptime(): Promise<void> {
        await this.ensureLoaded();
        const now = Date.now();
        const delta = Math.max(0, now - this.sessionAnchorMs);
        if (delta <= 0) {
            return;
        }
        this.cumulativeUptimeMs += delta;
        this.sessionAnchorMs = now;
        await this.persistMeta();
    }

    private async ensureLoaded(): Promise<void> {
        if (this.cachedStartedAt) {
            return;
        }

        const existing = await this.poolMetaRepository.findOne({
            where: { id: SINGLETON_ID },
        });
        if (existing?.startedAt) {
            this.applyRow(existing);
            return;
        }

        const earliestStatsMs = await this.clientStatisticsService.getEarliestTimeMs();
        const startedAtMs =
            Number.isFinite(earliestStatsMs) && earliestStatsMs > 0
                ? earliestStatsMs
                : Date.now();

        const created: PoolMetaEntity = {
            id: SINGLETON_ID,
            startedAt: startedAtMs,
            cumulativeUptimeMs: 0,
            rolledUpAcceptedShares: 0,
            rolledUpRejectedShares: 0,
        };
        await this.poolMetaRepository.save(created);
        this.applyRow(created);
    }

    private applyRow(row: PoolMetaEntity): void {
        this.cachedStartedAt = new Date(row.startedAt);
        this.cumulativeUptimeMs = Number(row.cumulativeUptimeMs) || 0;
        this.rolledUpAcceptedShares = Number(row.rolledUpAcceptedShares) || 0;
        this.rolledUpRejectedShares = Number(row.rolledUpRejectedShares) || 0;
    }

    private async persistMeta(): Promise<void> {
        if (!this.cachedStartedAt) {
            return;
        }
        await this.poolMetaRepository.save({
            id: SINGLETON_ID,
            startedAt: this.cachedStartedAt.getTime(),
            cumulativeUptimeMs: this.cumulativeUptimeMs,
            rolledUpAcceptedShares: this.rolledUpAcceptedShares,
            rolledUpRejectedShares: this.rolledUpRejectedShares,
        });
    }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsService } from '../client-statistics/client-statistics.service';
import { PoolMetaEntity } from './pool-meta.entity';

const SINGLETON_ID = 1;

@Injectable()
export class PoolMetaService {
    private cachedStartedAt: Date | null = null;

    constructor(
        @InjectRepository(PoolMetaEntity)
        private readonly poolMetaRepository: Repository<PoolMetaEntity>,
        private readonly clientStatisticsService: ClientStatisticsService,
    ) {}

    /** Earliest durable pool start — created once, then reused across restarts. */
    public async getStartedAt(): Promise<Date> {
        if (this.cachedStartedAt) {
            return this.cachedStartedAt;
        }

        const existing = await this.poolMetaRepository.findOne({
            where: { id: SINGLETON_ID },
        });
        if (existing?.startedAt) {
            this.cachedStartedAt = new Date(existing.startedAt);
            return this.cachedStartedAt;
        }

        const earliestStatsMs = await this.clientStatisticsService.getEarliestTimeMs();
        const startedAtMs =
            Number.isFinite(earliestStatsMs) && earliestStatsMs > 0
                ? earliestStatsMs
                : Date.now();

        await this.poolMetaRepository.save({
            id: SINGLETON_ID,
            startedAt: startedAtMs,
        });

        this.cachedStartedAt = new Date(startedAtMs);
        return this.cachedStartedAt;
    }
}

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { PoolMetaService } from '../ORM/pool-meta/pool-meta.service';
import { DiscordService, NotificationMessage } from './discord.service';
import {
    formatPoolDigestPeriod,
    poolDigestIntervalMs,
    PoolDigestConfig,
    NotificationSettingsService,
} from './notification-settings.service';
import { TelegramService } from './telegram.service';

@Injectable()
export class PoolDigestService implements OnModuleInit {
    constructor(
        private readonly notificationSettings: NotificationSettingsService,
        private readonly discordService: DiscordService,
        private readonly telegramService: TelegramService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly blocksService: BlocksService,
        private readonly poolMetaService: PoolMetaService,
    ) {}

    onModuleInit(): void {
        // First check shortly after boot so digests aren't stuck waiting.
        setTimeout(() => {
            void this.tick().catch((error) => {
                console.warn(`Pool digest tick failed: ${(error as Error).message}`);
            });
        }, 30_000);
    }

    @Interval(5 * 60 * 1000)
    async scheduledTick(): Promise<void> {
        await this.tick();
    }

    public async tick(): Promise<void> {
        if (process.env.NODE_APP_INSTANCE != null && process.env.NODE_APP_INSTANCE !== '0') {
            return;
        }

        const settings = this.notificationSettings.getRaw();
        if (!settings.enabled) {
            return;
        }

        const now = Date.now();
        const dueDiscord =
            settings.discord.enabled &&
            this.isDue(settings.discord.poolDigest, settings.discord.poolDigestLastSentAt, now);
        const dueTelegram =
            settings.telegram.enabled &&
            this.isDue(settings.telegram.poolDigest, settings.telegram.poolDigestLastSentAt, now);

        if (!dueDiscord && !dueTelegram) {
            return;
        }

        if (dueDiscord) {
            const message = await this.buildDigest(settings.discord.poolDigest, now);
            const result = await this.discordService.send(message);
            if (result.ok) {
                this.notificationSettings.markPoolDigestSent('discord', now);
            }
        }
        if (dueTelegram) {
            const message = await this.buildDigest(settings.telegram.poolDigest, now);
            const result = await this.telegramService.send(message);
            if (result.ok) {
                this.notificationSettings.markPoolDigestSent('telegram', now);
            }
        }
    }

    private isDue(digest: PoolDigestConfig, lastSentAt: number, now: number): boolean {
        const interval = poolDigestIntervalMs(digest);
        if (!interval) {
            return false;
        }
        if (!lastSentAt || lastSentAt <= 0) {
            return true;
        }
        return now - lastSentAt >= interval;
    }

    public async buildDigest(
        digest: PoolDigestConfig,
        now = Date.now(),
    ): Promise<NotificationMessage> {
        const period = formatPoolDigestPeriod(digest);
        const intervalMs = poolDigestIntervalMs(digest);
        const sinceMs = intervalMs > 0 ? now - intervalMs : 0;

        const [userAgents, workers, shareTotals, rolledUp, highScores, blocksAll, blocksPeriod, uptimeSeconds] =
            await Promise.all([
                this.clientService.getUserAgents(),
                this.clientService.getAllActive(),
                intervalMs > 0
                    ? this.clientStatisticsService.getShareTotalsSince(sinceMs)
                    : this.clientStatisticsService.getShareTotals(),
                this.poolMetaService.getRolledUpShares(),
                this.addressSettingsService.getHighScores(),
                this.blocksService.getFoundBlocks(),
                intervalMs > 0
                    ? this.blocksService.countFoundBlocksSince(sinceMs)
                    : Promise.resolve(-1),
                this.poolMetaService.getOverallUptimeSeconds(),
            ]);

        const totalHashRate = (userAgents ?? []).reduce(
            (acc, row) => acc + parseFloat(String(row.totalHashRate)),
            0,
        );
        const totalWorkers = (userAgents ?? []).reduce(
            (acc, row) => acc + parseInt(String(row.count), 10),
            0,
        );
        const workerBest = (workers ?? []).reduce(
            (max, worker) => Math.max(max, Number(worker.bestDifficulty) || 0),
            0,
        );
        const highScoreBest = (highScores ?? []).reduce(
            (max, row) => Math.max(max, Number(row.bestDifficulty) || 0),
            0,
        );

        // Period digests use live stats only (retention window). All-time adds rolled-up.
        const accepted =
            intervalMs > 0 ? shareTotals.accepted : rolledUp.accepted + shareTotals.accepted;
        const rejected =
            intervalMs > 0 ? shareTotals.rejected : rolledUp.rejected + shareTotals.rejected;
        const blocksFound =
            blocksPeriod >= 0
                ? blocksPeriod
                : Array.isArray(blocksAll)
                  ? blocksAll.length
                  : 0;

        return {
            event: 'poolDigest',
            title: period.title,
            action: period.action,
            fields: [
                { name: 'Period', value: period.periodLabel, inline: true },
                { name: 'Hashrate', value: formatHashrate(totalHashRate), inline: true },
                { name: 'Workers', value: String(totalWorkers), inline: true },
                {
                    name: 'Best difficulty',
                    value: formatCompact(Math.max(workerBest, highScoreBest)),
                    inline: true,
                },
                { name: 'Shares accepted', value: accepted.toLocaleString(), inline: true },
                { name: 'Shares rejected', value: rejected.toLocaleString(), inline: true },
                {
                    name: intervalMs > 0 ? 'Blocks this period' : 'Blocks found',
                    value: String(blocksFound),
                    inline: true,
                },
                { name: 'Overall uptime', value: formatUptime(uptimeSeconds), inline: true },
            ],
        };
    }
}

function formatHashrate(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 H/s';
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let v = value;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i += 1;
    }
    return `${v.toFixed(v >= 100 ? 0 : 2)} ${units[i]}`;
}

function formatCompact(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0';
    const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
    const power = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
    const scaled = value / Math.pow(1000, Math.max(0, power));
    return `${scaled.toFixed(2)}${units[Math.max(0, power)]}`;
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return `${d}d ${h}h`;
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

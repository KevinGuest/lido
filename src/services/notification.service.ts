import { Block } from 'bitcoinjs-lib';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DiscordService, NotificationMessage } from './discord.service';
import { NotificationEventKey, NotificationSettingsService } from './notification-settings.service';
import { TelegramService } from './telegram.service';
import { isShuttingDown } from '../shutdown';

const STRUGGLING_COOLDOWN_MS = 15 * 60 * 1000;

@Injectable()
export class NotificationService implements OnModuleInit {
    private readonly strugglingLastSent = new Map<string, number>();
    /** Dedupe block-found alerts (same height) within this process. */
    private readonly notifiedBlockHeights = new Set<number>();

    constructor(
        private readonly telegramService: TelegramService,
        private readonly discordService: DiscordService,
        private readonly notificationSettings: NotificationSettingsService,
        private readonly configService: ConfigService,
    ) {}

    async onModuleInit(): Promise<void> {
        // Avoid spamming Discord on every restart; users can use Test instead.
    }

    public async notifySubscribersBlockFound(
        address: string,
        height: number,
        block: Block,
        message: string,
        worker?: string,
        device?: string,
        protocol?: string,
    ) {
        if (!Number.isFinite(height) || height <= 0) {
            return;
        }
        if (this.notifiedBlockHeights.has(height)) {
            return;
        }
        this.notifiedBlockHeights.add(height);

        let blockHash = '';
        try {
            blockHash = block.getId();
        } catch {
            blockHash = '';
        }
        const url = blockHash
            ? mempoolBlockUrl(blockHash, this.configService.get<string>('NETWORK'))
            : mempoolBlockHeightUrl(height, this.configService.get<string>('NETWORK'));

        const payload: NotificationMessage = {
            event: 'blockFound',
            worker: worker || undefined,
            device: device || undefined,
            address,
            protocol,
            url,
            action: `Candidate block submitted. Result: ${message}`,
            fields: [
                { name: 'Height', value: String(height), inline: true },
                ...(blockHash
                    ? [{ name: 'Block hash', value: blockHash, inline: false }]
                    : []),
            ],
        };

        if (this.notificationSettings.isChannelEventEnabled('discord', 'blockFound')) {
            await this.discordService.send(payload);
        }
        if (this.notificationSettings.isChannelEventEnabled('telegram', 'blockFound')) {
            await this.telegramService.notifySubscribersBlockFound(address, height, block, message);
            await this.telegramService.send(payload);
        }
    }

    public async notifyMinerConnected(
        worker: string,
        address: string,
        protocol: string,
        device?: string,
    ) {
        await this.emit({
            event: 'minerConnect',
            worker,
            address,
            device,
            protocol,
            action: `${worker} opened a mining session.`,
        });
    }

    public async notifyMinerDisconnected(
        worker: string,
        address: string,
        device?: string,
        protocol?: string,
    ) {
        if (isShuttingDown()) {
            return;
        }
        await this.emit({
            event: 'minerDisconnect',
            worker,
            address,
            device,
            protocol,
            action: `${worker} went offline.`,
        });
    }

    public async notifyBestDifficulty(
        worker: string,
        address: string,
        difficulty: number,
        device?: string,
        protocol?: string,
    ) {
        await this.emit({
            event: 'bestDifficulty',
            worker,
            address,
            device,
            protocol,
            action: `${worker} set a new best difficulty.`,
            fields: [
                {
                    name: 'Difficulty',
                    value: formatCompactNumber(difficulty),
                    inline: true,
                },
            ],
        });
    }

    /**
     * Fired when vardiff lowers difficulty because the miner isn't submitting
     * enough shares (difficulty likely too high for the device).
     */
    public async notifyMinerStruggling(
        worker: string,
        address: string,
        fromDifficulty: number,
        toDifficulty: number,
        device?: string,
        protocol?: string,
    ) {
        const key = `${address}\0${worker}\0${protocol || ''}`;
        const last = this.strugglingLastSent.get(key) || 0;
        if (Date.now() - last < STRUGGLING_COOLDOWN_MS) {
            return;
        }
        this.strugglingLastSent.set(key, Date.now());

        await this.emit({
            event: 'minerStruggling',
            worker,
            address,
            device,
            protocol,
            action: `${worker} isn't submitting enough shares — lowering stratum difficulty.`,
            fields: [
                {
                    name: 'From',
                    value: formatCompactNumber(fromDifficulty),
                    inline: true,
                },
                {
                    name: 'To',
                    value: formatCompactNumber(toDifficulty),
                    inline: true,
                },
            ],
        });
    }

    private async emit(message: NotificationMessage & { event: NotificationEventKey }) {
        if (this.notificationSettings.isChannelEventEnabled('discord', message.event)) {
            await this.discordService.send(message);
        }
        if (this.notificationSettings.isChannelEventEnabled('telegram', message.event)) {
            await this.telegramService.send(message);
        }
    }
}

export function mempoolBaseUrl(network?: string): string {
    const n = (network || 'mainnet').toLowerCase();
    if (n === 'testnet' || n === 'testnet3') {
        return 'https://mempool.space/testnet';
    }
    if (n === 'testnet4') {
        return 'https://mempool.space/testnet4';
    }
    if (n === 'signet') {
        return 'https://mempool.space/signet';
    }
    return 'https://mempool.space';
}

export function mempoolBlockUrl(hash: string, network?: string): string {
    return `${mempoolBaseUrl(network)}/block/${hash}`;
}

export function mempoolBlockHeightUrl(height: number, network?: string): string {
    return `${mempoolBaseUrl(network)}/block-height/${height}`;
}

/** Match dashboard numberSuffix (e.g. 100233.211 → 100.23K, 4.2e12 → 4.20T). */
function formatCompactNumber(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0';
    const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
    const power = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
    const scaled = value / Math.pow(1000, Math.max(0, power));
    return `${scaled.toFixed(2)}${units[Math.max(0, power)]}`;
}

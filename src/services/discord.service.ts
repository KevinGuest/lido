import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import {
    NotificationEventKey,
    NotificationSettingsService,
    assertDiscordWebhookUrl,
} from './notification-settings.service';

export type NotificationAvatarTheme = 'dark' | 'light';

export type NotificationMessage = {
    event: NotificationEventKey | 'test' | 'poolDigest';
    /** Optional title override (e.g. Hourly / Weekly digest). */
    title?: string;
    /** Worker / device name only — never use as the sole identity. */
    worker?: string;
    /** Payout / stratum address when known. */
    address?: string;
    /** Miner user-agent / hardware string when known. */
    device?: string;
    protocol?: 'sv1' | 'sv2' | string;
    /** Short human action line. */
    action: string;
    /** Explorer / deep link — attached to Height (not the embed title). */
    url?: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
};

const EVENT_META: Record<
    NotificationEventKey | 'test' | 'poolDigest',
    { title: string; color: number; emoji: string }
> = {
    minerConnect: { title: 'Miner connected', color: 0x22c55e, emoji: '🟢' },
    minerDisconnect: { title: 'Miner disconnected', color: 0xf59e0b, emoji: '🟠' },
    bestDifficulty: { title: 'New best difficulty', color: 0x3b82f6, emoji: '📈' },
    blockFound: { title: 'Block found', color: 0xeab308, emoji: '🏆' },
    minerStruggling: { title: 'Miner struggling', color: 0xef4444, emoji: '⚠️' },
    poolDigest: { title: 'Pool digest', color: 0x8b5cf6, emoji: '📊' },
    test: { title: 'Connection test', color: 0x14b8a6, emoji: '🧪' },
};

const DEFAULT_AVATAR_DARK =
    'https://raw.githubusercontent.com/KevinGuest/lido-ui/main/public/logo.png';
const DEFAULT_AVATAR_LIGHT =
    'https://raw.githubusercontent.com/KevinGuest/lido-ui/main/public/logo-light.png';

@Injectable()
export class DiscordService {
    constructor(
        private readonly configService: ConfigService,
        private readonly notificationSettings: NotificationSettingsService,
    ) {}

    public async notifyRestarted() {
        await this.send({
            event: 'test',
            action: 'Lido pool process started.',
            fields: [{ name: 'Status', value: 'Online', inline: true }],
        });
    }

    public async send(
        message: NotificationMessage,
        options?: {
            webhookUrl?: string;
            avatarTheme?: NotificationAvatarTheme;
        },
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        return this.sendMany([message], options);
    }

    public async sendMany(
        messages: NotificationMessage[],
        options?: {
            webhookUrl?: string;
            avatarTheme?: NotificationAvatarTheme;
        },
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        if (process.env.NODE_APP_INSTANCE != null && process.env.NODE_APP_INSTANCE !== '0') {
            return { ok: false, error: 'Notifications only run on the primary instance' };
        }

        const url = (options?.webhookUrl?.trim() || this.webhookUrl()).trim();
        if (!url) {
            return { ok: false, error: 'Discord webhook URL is missing' };
        }
        try {
            assertDiscordWebhookUrl(url);
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Discord webhook URL is invalid',
            };
        }
        if (!messages.length) {
            return { ok: false, error: 'No messages to send' };
        }

        const embeds = messages.slice(0, 10).map((message) => this.toEmbed(message));
        const body = {
            username: 'Lido',
            avatar_url: this.avatarUrl(options?.avatarTheme || 'dark'),
            embeds,
        };

        try {
            await axios.post(url, body, {
                timeout: 15000,
                headers: { 'Content-Type': 'application/json' },
                validateStatus: (status) => status >= 200 && status < 300,
            });
            return { ok: true };
        } catch (error) {
            const err = error as {
                response?: { status?: number; data?: unknown };
                message?: string;
            };
            const detail = formatDiscordWebhookError(
                err.response?.data ?? err.message,
                err.response?.status,
            );
            console.error(`Discord webhook failed: ${detail}`);
            return { ok: false, error: detail };
        }
    }

    private toEmbed(message: NotificationMessage) {
        const meta = EVENT_META[message.event] || EVENT_META.test;
        const fields = [
            ...(message.worker
                ? [{ name: 'Worker', value: message.worker, inline: true }]
                : []),
            ...(message.device
                ? [{ name: 'Device', value: message.device, inline: true }]
                : []),
            ...(message.address
                ? [{ name: 'Address', value: message.address, inline: false }]
                : []),
            ...(message.protocol
                ? [
                      {
                          name: 'Protocol',
                          value: String(message.protocol).toUpperCase(),
                          inline: true,
                      },
                  ]
                : []),
            ...(message.fields || []),
        ]
            .map((field) => {
                if (
                    message.url &&
                    field.name.toLowerCase() === 'height' &&
                    !field.value.includes('](')
                ) {
                    return {
                        ...field,
                        value: `[${field.value}](${message.url})`,
                    };
                }
                return field;
            })
            .slice(0, 25);

        return {
            title: formatEventTitle(message.event, message.title || meta.title).slice(0, 256),
            description: message.action.slice(0, 4000),
            color: meta.color,
            fields,
            timestamp: new Date().toISOString(),
        };
    }

    private webhookUrl(): string {
        const fromSettings = this.notificationSettings.getRaw().discord.webhookUrl?.trim() || '';
        if (fromSettings) {
            return fromSettings;
        }
        return (
            this.configService.get<string>('DISCORD_WEBHOOK_URL') ||
            this.configService.get<string>('DISCORD_BOT_WEBHOOK_URL') ||
            ''
        ).trim();
    }

    private avatarUrl(theme: NotificationAvatarTheme): string {
        const custom =
            this.configService.get<string>('DISCORD_AVATAR_URL') ||
            this.configService.get<string>('LIDO_DISCORD_AVATAR_URL') ||
            '';
        if (custom.trim()) {
            return custom.trim();
        }
        if (theme === 'light') {
            return (
                this.configService.get<string>('DISCORD_AVATAR_URL_LIGHT') ||
                DEFAULT_AVATAR_LIGHT
            );
        }
        return (
            this.configService.get<string>('DISCORD_AVATAR_URL_DARK') || DEFAULT_AVATAR_DARK
        );
    }
}

/** Turn Discord API JSON / status into short UI copy. */
export function formatDiscordWebhookError(raw: unknown, status?: number): string {
    let message = '';
    let code: number | undefined;

    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw) as { message?: unknown; code?: unknown };
            if (typeof parsed.message === 'string') {
                message = parsed.message;
            }
            if (typeof parsed.code === 'number') {
                code = parsed.code;
            } else if (!message) {
                message = raw.trim();
            }
        } catch {
            message = raw.trim();
        }
    } else if (raw && typeof raw === 'object') {
        const obj = raw as { message?: unknown; code?: unknown };
        if (typeof obj.message === 'string') {
            message = obj.message;
        }
        if (typeof obj.code === 'number') {
            code = obj.code;
        }
    }

    if (code === 10015 || /unknown webhook/i.test(message)) {
        return 'That Discord webhook was deleted or is invalid. Create a new one and paste it here.';
    }
    if (code === 50027 || /invalid webhook token/i.test(message)) {
        return 'That Discord webhook token is invalid. Create a new webhook and paste the full URL.';
    }
    if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(message)) {
        return 'Discord rejected this webhook. Check the URL or create a new one.';
    }
    if (status === 404) {
        return 'Discord webhook not found. It may have been deleted — create a new one.';
    }
    if (message && !message.trim().startsWith('{')) {
        return message.length > 160 ? `${message.slice(0, 157)}…` : message;
    }
    return status
        ? `Discord webhook test failed (${status})`
        : 'Discord webhook test failed';
}

export function formatEventTitle(
    event: NotificationMessage['event'] | string,
    title: string,
): string {
    const meta = EVENT_META[event as keyof typeof EVENT_META];
    const emoji = meta?.emoji || '🔔';
    const trimmed = title.trim();
    if (!trimmed) {
        return `${emoji} ${meta?.title || 'Lido'}`;
    }
    if (trimmed.startsWith(emoji)) {
        return trimmed;
    }
    // Already has some emoji prefix — leave as-is.
    if (/^\p{Extended_Pictographic}/u.test(trimmed)) {
        return trimmed;
    }
    return `${emoji} ${trimmed}`;
}

import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export type NotificationEventKey =
    | 'minerConnect'
    | 'minerDisconnect'
    | 'bestDifficulty'
    | 'blockFound'
    | 'minerStruggling';

export type PoolDigestUnit = 'off' | 'hours' | 'weeks' | 'months';

export type PoolDigestConfig = {
    unit: PoolDigestUnit;
    /** Interval count for the selected unit (ignored when unit is off). */
    every: number;
};

export type NotificationEvents = Record<NotificationEventKey, boolean>;

export interface NotificationSettingsFile {
    enabled: boolean;
    discord: {
        enabled: boolean;
        webhookUrl: string;
        events: NotificationEvents;
        poolDigest: PoolDigestConfig;
        poolDigestLastSentAt: number;
    };
    telegram: {
        enabled: boolean;
        botToken: string;
        chatId: string;
        events: NotificationEvents;
        poolDigest: PoolDigestConfig;
        poolDigestLastSentAt: number;
    };
}

/** Wire format — secrets are never echoed back (only configured flags). */
export interface NotificationSettingsPublic {
    enabled: boolean;
    locked: boolean;
    discord: {
        enabled: boolean;
        configured: boolean;
        /** Empty on read. Send a new URL to replace; omit/empty/masked to keep. */
        webhookUrl: string;
        events: NotificationEvents;
        poolDigest: PoolDigestConfig;
    };
    telegram: {
        enabled: boolean;
        configured: boolean;
        botToken: string;
        chatId: string;
        events: NotificationEvents;
        poolDigest: PoolDigestConfig;
    };
}

const SETTINGS_FILENAME = 'notification-settings.json';

const DIGEST_UNITS: PoolDigestUnit[] = ['off', 'hours', 'weeks', 'months'];

const UNIT_MS: Record<Exclude<PoolDigestUnit, 'off'>, number> = {
    hours: 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
};

const DISCORD_WEBHOOK_HOSTS = new Set([
    'discord.com',
    'discordapp.com',
    'canary.discord.com',
    'ptb.discord.com',
]);

export function poolDigestIntervalMs(digest: PoolDigestConfig): number {
    if (!digest || digest.unit === 'off') {
        return 0;
    }
    const every = Math.max(1, Math.floor(Number(digest.every) || 1));
    return every * UNIT_MS[digest.unit];
}

export function defaultPoolDigest(): PoolDigestConfig {
    return { unit: 'off', every: 1 };
}

/** Human labels for digest embeds based on the selected schedule. */
export function formatPoolDigestPeriod(digest: PoolDigestConfig): {
    title: string;
    action: string;
    periodLabel: string;
} {
    if (!digest || digest.unit === 'off') {
        return {
            title: 'Pool digest',
            action: 'Lido pool summary.',
            periodLabel: 'All time',
        };
    }
    const n = Math.max(1, Math.floor(Number(digest.every) || 1));
    if (digest.unit === 'hours') {
        return {
            title: n === 1 ? 'Hourly pool digest' : `Pool digest (every ${n} hours)`,
            action:
                n === 1
                    ? 'Summary for the last hour.'
                    : `Summary for the last ${n} hours.`,
            periodLabel: n === 1 ? 'Last hour' : `Last ${n} hours`,
        };
    }
    if (digest.unit === 'weeks') {
        return {
            title: n === 1 ? 'Weekly pool digest' : `Pool digest (every ${n} weeks)`,
            action:
                n === 1
                    ? 'Summary for the last week.'
                    : `Summary for the last ${n} weeks.`,
            periodLabel: n === 1 ? 'Last week' : `Last ${n} weeks`,
        };
    }
    return {
        title: n === 1 ? 'Monthly pool digest' : `Pool digest (every ${n} months)`,
        action:
            n === 1
                ? 'Summary for the last month.'
                : `Summary for the last ${n} months.`,
        periodLabel: n === 1 ? 'Last month' : `Last ${n} months`,
    };
}

function defaultEvents(): NotificationEvents {
    return {
        minerConnect: true,
        minerDisconnect: true,
        bestDifficulty: true,
        blockFound: true,
        minerStruggling: true,
    };
}

function normalizeEvents(raw: unknown, fallback: NotificationEvents): NotificationEvents {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationEvents>;
    return {
        minerConnect:
            typeof src.minerConnect === 'boolean' ? src.minerConnect : fallback.minerConnect,
        minerDisconnect:
            typeof src.minerDisconnect === 'boolean'
                ? src.minerDisconnect
                : fallback.minerDisconnect,
        bestDifficulty:
            typeof src.bestDifficulty === 'boolean'
                ? src.bestDifficulty
                : fallback.bestDifficulty,
        blockFound: typeof src.blockFound === 'boolean' ? src.blockFound : fallback.blockFound,
        minerStruggling:
            typeof src.minerStruggling === 'boolean'
                ? src.minerStruggling
                : fallback.minerStruggling,
    };
}

function normalizeDigest(raw: unknown, fallback: PoolDigestConfig = defaultPoolDigest()): PoolDigestConfig {
    if (typeof raw === 'string') {
        switch (raw) {
            case 'off':
                return { unit: 'off', every: 1 };
            case 'hourly':
                return { unit: 'hours', every: 1 };
            case 'daily':
                return { unit: 'hours', every: 24 };
            case 'every3days':
                return { unit: 'hours', every: 72 };
            case 'weekly':
                return { unit: 'weeks', every: 1 };
            case 'monthly':
                return { unit: 'months', every: 1 };
            default:
                return { ...fallback };
        }
    }

    if (raw && typeof raw === 'object') {
        const obj = raw as { unit?: unknown; every?: unknown };
        const unit = DIGEST_UNITS.includes(obj.unit as PoolDigestUnit)
            ? (obj.unit as PoolDigestUnit)
            : fallback.unit;
        const every = Math.max(1, Math.floor(Number(obj.every) || fallback.every || 1));
        return { unit, every: unit === 'off' ? 1 : every };
    }

    return { ...fallback };
}

function looksMasked(value: string): boolean {
    return !value || /^[•.]+/.test(value) || value.includes('••••');
}

/** Must be a real Discord incoming-webhook URL. */
export function assertDiscordWebhookUrl(url: string): string {
    const trimmed = url.trim();
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new BadRequestException('Discord webhook URL is invalid');
    }
    if (parsed.protocol !== 'https:') {
        throw new BadRequestException('Discord webhook must use https');
    }
    if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) {
        throw new BadRequestException('Discord webhook must be a discord.com URL');
    }
    if (!parsed.pathname.startsWith('/api/webhooks/')) {
        throw new BadRequestException('Discord webhook path looks wrong');
    }
    return trimmed;
}

/** BotFather tokens look like 123456:AA… — blocks URL injection into api.telegram.org. */
export function assertTelegramBotToken(token: string): string {
    const trimmed = token.trim();
    if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
        throw new BadRequestException('Telegram bot token format is invalid');
    }
    return trimmed;
}

export function assertTelegramChatId(chatId: string): string {
    const trimmed = chatId.trim();
    // Numeric chats / groups, or @channel usernames.
    if (!/^(-?\d{5,}|@[A-Za-z0-9_]{4,})$/.test(trimmed)) {
        throw new BadRequestException('Telegram chat ID format is invalid');
    }
    return trimmed;
}

@Injectable()
export class NotificationSettingsService implements OnModuleInit {
    private settings: NotificationSettingsFile;
    private readonly filePath: string;

    constructor(private readonly configService: ConfigService) {
        this.filePath = path.join(process.cwd(), 'DB', SETTINGS_FILENAME);
        this.settings = this.defaultFromEnv();
    }

    onModuleInit(): void {
        this.settings = this.load();
    }

    public getPublic(): NotificationSettingsPublic {
        const s = this.settings;
        return {
            enabled: s.enabled,
            locked: false,
            discord: {
                enabled: s.discord.enabled,
                configured: Boolean(s.discord.webhookUrl),
                webhookUrl: '',
                events: { ...s.discord.events },
                poolDigest: s.discord.poolDigest,
            },
            telegram: {
                enabled: s.telegram.enabled,
                configured: Boolean(s.telegram.botToken && s.telegram.chatId),
                botToken: '',
                chatId: '',
                events: { ...s.telegram.events },
                poolDigest: s.telegram.poolDigest,
            },
        };
    }

    public getRaw(): NotificationSettingsFile {
        return this.settings;
    }

    public isChannelEventEnabled(
        channel: 'discord' | 'telegram',
        event: NotificationEventKey,
    ): boolean {
        if (!this.settings.enabled) {
            return false;
        }
        const config = this.settings[channel];
        return Boolean(config.enabled && config.events[event]);
    }

    public markPoolDigestSent(channel: 'discord' | 'telegram', atMs = Date.now()): void {
        this.settings[channel].poolDigestLastSentAt = atMs;
        this.persist();
    }

    public update(input: NotificationSettingsPublic): NotificationSettingsPublic {
        const nextDiscordUrl = this.resolveDiscordWebhook(input.discord?.webhookUrl);
        const nextTelegramToken = this.resolveTelegramToken(input.telegram?.botToken);
        const nextTelegramChat = this.resolveTelegramChatId(input.telegram?.chatId);

        if (input.discord?.enabled && !nextDiscordUrl) {
            throw new BadRequestException('Discord webhook URL is required when Discord is enabled');
        }
        if (input.telegram?.enabled && (!nextTelegramToken || !nextTelegramChat)) {
            throw new BadRequestException(
                'Telegram bot token and chat ID are required when Telegram is enabled',
            );
        }

        const next: NotificationSettingsFile = {
            enabled: Boolean(input.enabled),
            discord: {
                enabled: Boolean(input.discord?.enabled),
                webhookUrl: nextDiscordUrl,
                events: normalizeEvents(input.discord?.events, this.settings.discord.events),
                poolDigest: normalizeDigest(
                    input.discord?.poolDigest,
                    this.settings.discord.poolDigest,
                ),
                poolDigestLastSentAt: this.settings.discord.poolDigestLastSentAt,
            },
            telegram: {
                enabled: Boolean(input.telegram?.enabled),
                botToken: nextTelegramToken,
                chatId: nextTelegramChat,
                events: normalizeEvents(input.telegram?.events, this.settings.telegram.events),
                poolDigest: normalizeDigest(
                    input.telegram?.poolDigest,
                    this.settings.telegram.poolDigest,
                ),
                poolDigestLastSentAt: this.settings.telegram.poolDigestLastSentAt,
            },
        };
        this.settings = next;
        this.persist();
        return this.getPublic();
    }

    private resolveDiscordWebhook(incomingRaw: string | undefined): string {
        const incoming = String(incomingRaw || '').trim();
        if (!incoming || looksMasked(incoming)) {
            return this.settings.discord.webhookUrl;
        }
        return assertDiscordWebhookUrl(incoming);
    }

    private resolveTelegramToken(incomingRaw: string | undefined): string {
        const incoming = String(incomingRaw || '').trim();
        if (!incoming || looksMasked(incoming)) {
            return this.settings.telegram.botToken;
        }
        return assertTelegramBotToken(incoming);
    }

    private resolveTelegramChatId(incomingRaw: string | undefined): string {
        const incoming = String(incomingRaw || '').trim();
        if (!incoming || looksMasked(incoming)) {
            return this.settings.telegram.chatId;
        }
        return assertTelegramChatId(incoming);
    }

    private defaultFromEnv(): NotificationSettingsFile {
        const webhookUrl =
            this.configService.get<string>('DISCORD_WEBHOOK_URL') ||
            this.configService.get<string>('DISCORD_BOT_WEBHOOK_URL') ||
            '';
        const telegramToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
        return {
            enabled: Boolean(webhookUrl || telegramToken),
            discord: {
                enabled: Boolean(webhookUrl),
                webhookUrl,
                events: defaultEvents(),
                poolDigest: defaultPoolDigest(),
                poolDigestLastSentAt: 0,
            },
            telegram: {
                enabled: Boolean(telegramToken),
                botToken: telegramToken,
                chatId: this.configService.get<string>('TELEGRAM_CHAT_ID') || '',
                events: defaultEvents(),
                poolDigest: defaultPoolDigest(),
                poolDigestLastSentAt: 0,
            },
        };
    }

    private normalizeStored(parsed: Record<string, unknown>): NotificationSettingsFile {
        const defaults = this.defaultFromEnv();
        const discordRaw = (parsed.discord || {}) as Record<string, unknown>;
        const telegramRaw = (parsed.telegram || {}) as Record<string, unknown>;
        const legacyEvents = normalizeEvents(parsed.events, defaultEvents());

        const webhookUrl = String(
            discordRaw.webhookUrl ||
                discordRaw.webhook ||
                defaults.discord.webhookUrl ||
                '',
        ).trim();

        return {
            enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
            discord: {
                enabled:
                    typeof discordRaw.enabled === 'boolean'
                        ? discordRaw.enabled
                        : Boolean(webhookUrl),
                webhookUrl,
                events: normalizeEvents(discordRaw.events ?? legacyEvents, defaults.discord.events),
                poolDigest: normalizeDigest(discordRaw.poolDigest, defaults.discord.poolDigest),
                poolDigestLastSentAt:
                    Number(discordRaw.poolDigestLastSentAt) ||
                    defaults.discord.poolDigestLastSentAt,
            },
            telegram: {
                enabled:
                    typeof telegramRaw.enabled === 'boolean'
                        ? telegramRaw.enabled
                        : defaults.telegram.enabled,
                botToken: String(telegramRaw.botToken || defaults.telegram.botToken || '').trim(),
                chatId: String(telegramRaw.chatId || defaults.telegram.chatId || '').trim(),
                events: normalizeEvents(
                    telegramRaw.events ?? legacyEvents,
                    defaults.telegram.events,
                ),
                poolDigest: normalizeDigest(telegramRaw.poolDigest, defaults.telegram.poolDigest),
                poolDigestLastSentAt:
                    Number(telegramRaw.poolDigestLastSentAt) ||
                    defaults.telegram.poolDigestLastSentAt,
            },
        };
    }

    private load(): NotificationSettingsFile {
        try {
            if (fs.existsSync(this.filePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<
                    string,
                    unknown
                >;
                return this.normalizeStored(parsed);
            }
        } catch (error) {
            console.warn(`Failed to load notification settings: ${(error as Error).message}`);
        }
        const defaults = this.defaultFromEnv();
        this.settings = defaults;
        this.persist();
        return defaults;
    }

    private persist(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), {
                encoding: 'utf8',
                mode: 0o600,
            });
        } catch (error) {
            console.warn(`Failed to persist notification settings: ${(error as Error).message}`);
        }
    }
}

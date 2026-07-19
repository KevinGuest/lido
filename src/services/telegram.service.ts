import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';

import { NotificationMessage, formatEventTitle } from './discord.service';
import { NotificationSettingsService } from './notification-settings.service';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';

@Injectable()
export class TelegramService implements OnModuleInit {
    private bot: AxiosInstance;
    private updateOffset = 0;
    private pollingTimer: NodeJS.Timeout;

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
        private readonly notificationSettings: NotificationSettingsService,
    ) {
        const token: string | null = this.configService.get('TELEGRAM_BOT_TOKEN');
        if (token == null || token.length < 1) {
            return;
        }
        this.bot = axios.create({
            baseURL: `https://api.telegram.org/bot${token}/`,
            timeout: 10000,
        });
        console.log('Telegram bot init');
    }

    async onModuleInit(): Promise<void> {
        if (this.bot == null) {
            return;
        }

        await this.pollUpdates();
        this.pollingTimer = setInterval(async () => {
            await this.pollUpdates();
        }, 2000);
    }

    public async notifySubscribersBlockFound(
        address: string,
        height: number,
        block: Block,
        message: string,
    ) {
        let blockHash = '';
        try {
            blockHash = block.getId();
        } catch {
            blockHash = '';
        }
        const network = this.configService.get<string>('NETWORK');
        const url = blockHash
            ? `${mempoolBaseFromNetwork(network)}/block/${blockHash}`
            : `${mempoolBaseFromNetwork(network)}/block-height/${height}`;

        const text = this.formatMessage({
            event: 'blockFound',
            address,
            url,
            action: `Candidate submitted. Result: ${message}`,
            fields: [
                { name: 'Height', value: String(height) },
                ...(blockHash ? [{ name: 'Block hash', value: blockHash }] : []),
            ],
        });
        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        await Promise.all(
            subscribers.map((subscriber) =>
                this.sendRaw(subscriber.telegramChatId, text).catch(() => undefined),
            ),
        );
    }

    public async send(
        message: NotificationMessage,
        options?: { botToken?: string; chatId?: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const settings = this.notificationSettings.getRaw().telegram;
        const token = (
            options?.botToken ||
            settings.botToken ||
            this.configService.get<string>('TELEGRAM_BOT_TOKEN') ||
            ''
        ).trim();
        const target = (
            options?.chatId ||
            settings.chatId ||
            process.env.TELEGRAM_CHAT_ID ||
            ''
        ).trim();
        if (!token) {
            return { ok: false, error: 'Telegram bot token is missing' };
        }
        if (!target) {
            return { ok: false, error: 'Telegram chat ID is missing' };
        }

        try {
            await this.sendRaw(target, this.formatMessage(message), token);
            return { ok: true };
        } catch (error) {
            const detail = (error as Error).message || 'Telegram send failed';
            console.error(`Telegram notify failed: ${detail}`);
            return { ok: false, error: detail.slice(0, 240) };
        }
    }

    /** @deprecated Prefer send() with a NotificationMessage. */
    public async notifyText(text: string, chatId?: string) {
        await this.send(
            { event: 'test', action: text },
            { chatId },
        );
    }

    private formatMessage(message: NotificationMessage): string {
        const titles: Record<string, string> = {
            minerConnect: 'Miner connected',
            minerDisconnect: 'Miner disconnected',
            bestDifficulty: 'New best difficulty',
            blockFound: 'Block found',
            minerStruggling: 'Miner struggling',
            poolDigest: 'Pool digest',
            test: 'Connection test',
        };
        const heading = formatEventTitle(
            message.event,
            message.title || titles[message.event] || 'Lido',
        );
        let action = message.action;
        if (message.event === 'minerStruggling') {
            // Keep the consequence on its own line in Telegram.
            action = action.replace(/\s*—\s*/, '\n');
        }
        const lines = [`<b>${escapeHtml(heading)}</b>`, escapeHtml(action), ''];
        if (message.worker) {
            lines.push(`Worker: <code>${escapeHtml(message.worker)}</code>`);
        }
        if (message.device) {
            lines.push(`Device: ${escapeHtml(message.device)}`);
        }
        if (message.address) {
            lines.push(`Address: <code>${escapeHtml(message.address)}</code>`);
        }
        if (message.protocol) {
            lines.push(`Protocol: ${escapeHtml(String(message.protocol).toUpperCase())}`);
        }
        for (const field of message.fields || []) {
            if (
                message.url &&
                field.name.toLowerCase() === 'height'
            ) {
                lines.push(
                    `Height: <a href="${escapeHtml(message.url)}">${escapeHtml(field.value)}</a>`,
                );
                continue;
            }
            lines.push(`${escapeHtml(field.name)}: ${escapeHtml(field.value)}`);
        }
        lines.push('— Lido');
        return lines.join('\n');
    }

    private async pollUpdates() {
        try {
            const response = await this.bot.get('getUpdates', {
                params: {
                    offset: this.updateOffset,
                    timeout: 0,
                },
            });

            for (const update of response.data.result ?? []) {
                this.updateOffset = update.update_id + 1;
                await this.handleMessage(update.message);
            }
        } catch (e) {
            console.error('Telegram polling failed', e.message);
        }
    }

    private async handleMessage(msg: any) {
        if (msg?.text == null) {
            return;
        }

        if (msg.text.startsWith('/subscribe')) {
            const address = msg.text.split('/subscribe ')[1];
            if (validate(address) == false) {
                await this.sendRaw(msg.chat.id, 'Invalid address.');
                return;
            }
            await this.telegramSubscriptionsService.saveSubscription(msg.chat.id, address);
            await this.sendRaw(msg.chat.id, 'Subscribed!');
            return;
        }

        if (msg.text.startsWith('/start')) {
            await this.sendRaw(
                msg.chat.id,
                'Welcome to the Lido bot. /subscribe &lt;address&gt; to get notified.',
            );
            return;
        }

        console.log(msg);
    }

    private async sendRaw(chatId: number | string, text: string, token?: string) {
        const resolvedToken = (
            token ||
            this.notificationSettings.getRaw().telegram.botToken ||
            this.configService.get<string>('TELEGRAM_BOT_TOKEN') ||
            ''
        ).trim();
        if (!resolvedToken) {
            throw new Error('Telegram client is not configured');
        }

        const client = axios.create({
            baseURL: `https://api.telegram.org/bot${resolvedToken}/`,
            timeout: 10000,
        });

        await client.post('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        });
    }
}

function mempoolBaseFromNetwork(network?: string): string {
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

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

import { BadRequestException, Body, Controller, Get, Post, Put, Query, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';

import { DiscordService, NotificationAvatarTheme } from '../services/discord.service';
import { notificationConnectionTest } from '../services/notification-samples';
import {
    NotificationSettingsPublic,
    NotificationSettingsService,
} from '../services/notification-settings.service';
import { PoolLogService } from '../services/pool-log.service';
import { TelegramService } from '../services/telegram.service';

type TestBody = {
    channel?: 'discord' | 'telegram';
    avatarTheme?: NotificationAvatarTheme;
    discord?: { webhookUrl?: string };
    telegram?: { botToken?: string; chatId?: string };
};

@Controller('notifications')
export class NotificationsController {
    constructor(
        private readonly notificationSettings: NotificationSettingsService,
        private readonly discordService: DiscordService,
        private readonly telegramService: TelegramService,
    ) {}

    @Get('settings')
    getSettings() {
        return this.notificationSettings.getPublic();
    }

    @Put('settings')
    putSettings(@Body() body: NotificationSettingsPublic) {
        return this.notificationSettings.update(body);
    }

    /**
     * Send a single connection-ok alert using request credentials (or saved settings).
     */
    @Post('test')
    async testChannel(@Body() body: TestBody) {
        const channel = body?.channel;
        if (channel !== 'discord' && channel !== 'telegram') {
            throw new BadRequestException('channel must be discord or telegram');
        }

        const sample = notificationConnectionTest();

        if (channel === 'discord') {
            const result = await this.discordService.send(sample, {
                webhookUrl: body.discord?.webhookUrl,
                avatarTheme: body.avatarTheme === 'light' ? 'light' : 'dark',
            });
            if (result.ok === false) {
                throw new BadRequestException(result.error);
            }
            return { ok: true, channel };
        }

        const result = await this.telegramService.send(sample, {
            botToken: body.telegram?.botToken,
            chatId: body.telegram?.chatId,
        });
        if (result.ok === false) {
            throw new BadRequestException(result.error);
        }
        return { ok: true, channel };
    }
}

@Controller('logs')
export class LogsController {
    constructor(private readonly poolLogService: PoolLogService) {}

    @Get()
    recent(@Query('limit') limitRaw?: string) {
        const limit = Number.parseInt(limitRaw || '200', 10);
        return { lines: this.poolLogService.recent(Number.isFinite(limit) ? limit : 200) };
    }

    /**
     * SSE over Fastify — use the Node raw response, not Express `Response`.
     */
    @Get('stream')
    stream(@Res() reply: FastifyReply): void {
        const res = reply.raw;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`: connected\n\n`);

        const sub = this.poolLogService.stream$().subscribe((line) => {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
        });

        const ping = setInterval(() => {
            res.write(`: ping\n\n`);
        }, 15000);

        res.on('close', () => {
            clearInterval(ping);
            sub.unsubscribe();
        });
    }
}

import { NotificationMessage } from './discord.service';

/** Single connection check used by Test Discord / Test Telegram. */
export function notificationConnectionTest(): NotificationMessage {
    return {
        event: 'test',
        action: 'Connection is good — Lido can reach this channel.',
        fields: [{ name: 'Status', value: 'OK', inline: true }],
    };
}

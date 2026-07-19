import { Injectable, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import * as util from 'util';

export type PoolLogLevel = 'log' | 'warn' | 'error' | 'info';

export interface PoolLogLine {
    id: string;
    ts: number;
    level: PoolLogLevel;
    message: string;
}

@Injectable()
export class PoolLogService implements OnModuleInit {
    private readonly maxLines = 2000;
    private readonly lines: PoolLogLine[] = [];
    private seq = 0;
    private readonly subject = new Subject<PoolLogLine>();
    private patched = false;

    onModuleInit(): void {
        this.patchConsole();
        this.append('info', 'Pool log buffer ready');
    }

    public recent(limit = 200): PoolLogLine[] {
        const take = Math.max(1, Math.min(limit, this.maxLines));
        return this.lines.slice(-take);
    }

    public stream$() {
        return this.subject.asObservable();
    }

    public append(level: PoolLogLevel, message: string): void {
        const line: PoolLogLine = {
            id: `${Date.now()}-${++this.seq}`,
            ts: Date.now(),
            level,
            message: String(message).slice(0, 4000),
        };
        this.lines.push(line);
        if (this.lines.length > this.maxLines) {
            this.lines.splice(0, this.lines.length - this.maxLines);
        }
        this.subject.next(line);
    }

    private patchConsole(): void {
        if (this.patched) {
            return;
        }
        this.patched = true;
        const levels: Array<'log' | 'warn' | 'error'> = ['log', 'warn', 'error'];
        for (const level of levels) {
            const original = console[level].bind(console);
            console[level] = (...args: unknown[]) => {
                original(...args);
                try {
                    const message = args
                        .map((arg) => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 2, breakLength: 120 })))
                        .join(' ');
                    this.append(level, message);
                } catch {
                    // never break logging
                }
            };
        }
    }
}

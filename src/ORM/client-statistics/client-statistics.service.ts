import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';


@Injectable()
export class ClientStatisticsService {

    constructor(


        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    public async update(clientStatistic: Partial<ClientStatisticsEntity>) {

        await this.clientStatisticsRepository.update({
            address: clientStatistic.address,
            clientName: clientStatistic.clientName,
            sessionId: clientStatistic.sessionId,
            time: clientStatistic.time
        },
            {
                shares: clientStatistic.shares,
                acceptedCount: clientStatistic.acceptedCount,
                rejectedCount: clientStatistic.rejectedCount ?? 0,
                updatedAt: new Date()
            });

    }
    public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
        // If no rows were updated, insert a new record
        await this.clientStatisticsRepository.insert(clientStatistic);
    }

    public async deleteOldStatistics() {
        // Keep a week (+ buffer) so 7d charts have history.
        const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('time < :time', { time: cutoff.getTime() })
            .execute();
    }

    public async getAcceptedShareCounts(): Promise<
        Map<string, number>
    > {
        const rows: Array<{
            address: string;
            clientName: string;
            sessionId: string;
            shares: string | number;
        }> = await this.clientStatisticsRepository.query(`
            SELECT
                address,
                clientName,
                sessionId,
                SUM(acceptedCount) AS shares
            FROM client_statistics_entity
            GROUP BY address, clientName, sessionId
        `);

        const map = new Map<string, number>();
        for (const row of rows) {
            const key = `${row.address}\0${row.clientName}\0${row.sessionId}`;
            map.set(key, Number(row.shares) || 0);
        }
        return map;
    }

    public async getRejectedShareCounts(): Promise<Map<string, number>> {
        const rows: Array<{
            address: string;
            clientName: string;
            sessionId: string;
            rejected: string | number;
        }> = await this.clientStatisticsRepository.query(`
            SELECT
                address,
                clientName,
                sessionId,
                SUM(COALESCE(rejectedCount, 0)) AS rejected
            FROM client_statistics_entity
            GROUP BY address, clientName, sessionId
        `);

        const map = new Map<string, number>();
        for (const row of rows) {
            const key = `${row.address}\0${row.clientName}\0${row.sessionId}`;
            map.set(key, Number(row.rejected) || 0);
        }
        return map;
    }

    public async getEarliestTimeMs(): Promise<number | null> {
        const rows: Array<{ earliest: string | number | null }> =
            await this.clientStatisticsRepository.query(`
                SELECT MIN(time) AS earliest
                FROM client_statistics_entity
            `);
        const value = Number(rows?.[0]?.earliest);
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    public async getChartDataForSite(fromMs?: number, toMs?: number) {
        const to = toMs ?? Date.now();
        const from = fromMs ?? to - 24 * 60 * 60 * 1000;
        // Align with 10-minute share slots so Live (24h) always has dense points.
        const bucketMs = 10 * 60 * 1000;

        const query = `
            SELECT
                (CAST(time / ${bucketMs} AS INTEGER) * ${bucketMs}) AS label,
                ROUND(((SUM(shares) * 4294967296) / ${bucketMs / 1000})) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time >= ${from} AND entry.time <= ${to}
            GROUP BY
                (CAST(time / ${bucketMs} AS INTEGER) * ${bucketMs})
            ORDER BY
                label
        `;

        const result: any[] = await this.clientStatisticsRepository.query(query);

        return result.map((res) => {
            res.label = new Date(Number(res.label)).toISOString();
            res.data = Number(res.data) || 0;
            return res;
        });
    }


    // public async getHashRateForAddress(address: string) {

    //     const oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

    //     const query = `
    //         SELECT
    //         SUM(entry.shares) AS difficultySum
    //         FROM
    //             client_statistics_entity AS entry
    //         WHERE
    //             entry.address = ? AND entry.time > ${oneHour}
    //     `;

    //     const result = await this.clientStatisticsRepository.query(query, [address]);

    //     const difficultySum = result[0].difficultySum;

    //     return (difficultySum * 4294967296) / (600);

    // }

    public async getChartDataForAddress(address: string) {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
                SELECT
                    time label,
                    (SUM(shares) * 4294967296) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.address = ? AND entry.time > ${yesterday.getTime()}
                GROUP BY
                    time
                ORDER BY
                    time
                LIMIT 144;

        `;

        const result = await this.clientStatisticsRepository.query(query, [address]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForGroup(address: string, clientName: string) {

        var oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

        const query = `
            SELECT
            SUM(entry.shares) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${oneHour.getTime()}
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);


        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (600);

    }

    public async getChartDataForActiveMiners(fromMs?: number, toMs?: number) {
        const to = toMs ?? Date.now();
        const from = fromMs ?? to - 24 * 60 * 60 * 1000;
        const bucketMs = 10 * 60 * 1000;

        const query = `
            SELECT
                entry.clientName AS name,
                (CAST(entry.time / ${bucketMs} AS INTEGER) * ${bucketMs}) AS label,
                ROUND(((SUM(entry.shares) * 4294967296) / ${bucketMs / 1000})) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time >= ${from} AND entry.time <= ${to}
            GROUP BY
                entry.clientName,
                (CAST(entry.time / ${bucketMs} AS INTEGER) * ${bucketMs})
            ORDER BY
                name,
                label
        `;

        const result: Array<{ name: string; label: number | string; data: number | string }> =
            await this.clientStatisticsRepository.query(query);

        const byName = new Map<string, Array<{ label: string; data: number }>>();
        for (const row of result) {
            const name = String(row.name || "").trim();
            if (!name) continue;
            const series = byName.get(name) ?? [];
            series.push({
                label: new Date(Number(row.label)).toISOString(),
                data: Number(row.data) || 0,
            });
            byName.set(name, series);
        }

        return Array.from(byName.entries()).map(([name, chart]) => ({
            id: name,
            name,
            chart,
        }));
    }

    public async getChartDataForGroup(address: string, clientName: string, hours = 24) {
        const lookbackHours = Math.min(Math.max(hours, 1), 168);
        const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
        const bucketMs =
            lookbackHours <= 24
                ? 10 * 60 * 1000
                : lookbackHours <= 72
                  ? 30 * 60 * 1000
                  : 60 * 60 * 1000;
        const limit = Math.ceil((lookbackHours * 60 * 60 * 1000) / bucketMs) + 2;

        const query = `
            SELECT
                (CAST(time / ${bucketMs} AS INTEGER) * ${bucketMs}) AS label,
                ROUND(((SUM(shares) * 4294967296) / ${bucketMs / 1000})) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${since.getTime()}
            GROUP BY
                (CAST(time / ${bucketMs} AS INTEGER) * ${bucketMs})
            ORDER BY
                label
            LIMIT ${limit};
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);

        return result
            .map((res) => {
                res.label = new Date(Number(res.label)).toISOString();
                res.data = Number(res.data) || 0;
                return res;
            })
            .slice(0, Math.max(0, result.length - 1));
    }


    public async getHashRateForSession(address: string, clientName: string, sessionId: string) {

        const query = `
            SELECT
                createdAt,
                updatedAt,
                shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ?
            ORDER BY time DESC
            LIMIT 2;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        if (result.length < 1) {
            return 0;
        }

        const latestStat = result[0];

        if (result.length < 2) {
            const time = new Date(latestStat.updatedAt).getTime() - new Date(latestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return (latestStat.shares * 4294967296) / (time / 1000);
        } else {
            const secondLatestStat = result[1];
            const time = new Date(latestStat.updatedAt).getTime() - new Date(secondLatestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return ((latestStat.shares + secondLatestStat.shares) * 4294967296) / (time / 1000);
        }

    }

    public async getChartDataForSession(address: string, clientName: string, sessionId: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);

    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.clear()
    }
}

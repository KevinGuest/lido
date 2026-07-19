import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';


@Controller('client')
export class ClientController {

    constructor(
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService
    ) { }


    @Get()
    async getAllClients() {
        const workers = await this.clientService.getAllActive();
        const shareCounts = await this.clientStatisticsService.getAcceptedShareCounts();
        const rejectedCounts = await this.clientStatisticsService.getRejectedShareCounts();

        return {
            workersCount: workers.length,
            workers: workers.map((worker) => ({
                address: worker.address,
                sessionId: worker.sessionId,
                name: worker.clientName,
                userAgent: worker.userAgent,
                protocol: worker.protocol === 'sv2' ? 'sv2' : 'sv1',
                bestDifficulty: Number(worker.bestDifficulty),
                hashRate: worker.hashRate,
                startTime: worker.startTime,
                lastSeen: worker.updatedAt,
                shares: sumSharesForWorker(shareCounts, worker.address, worker.clientName),
                rejectedShares: sumSharesForWorker(
                    rejectedCounts,
                    worker.address,
                    worker.clientName,
                ),
            })),
        };
    }

    @Get(':address')
    async getClientInfo(@Param('address') address: string) {

        const workers = await this.clientService.getByAddress(address);

        const addressSettings = await this.addressSettingsService.getSettings(address, false);

        return {
            bestDifficulty: addressSettings?.bestDifficulty,
            workersCount: workers.length,
            workers: await Promise.all(
                workers.map(async (worker) => {
                    return {
                        sessionId: worker.sessionId,
                        name: worker.clientName,
                        bestDifficulty: worker.bestDifficulty.toFixed(2),
                        hashRate: worker.hashRate,
                        startTime: worker.startTime,
                        lastSeen: worker.updatedAt
                    };
                })
            )
        }
    }

    @Get(':address/chart')
    async getClientInfoChart(@Param('address') address: string) {
        const chartData = await this.clientStatisticsService.getChartDataForAddress(address);
        return chartData;
    }

    @Get(':address/:workerName/chart')
    async getWorkerGroupChart(
        @Param('address') address: string,
        @Param('workerName') workerName: string,
        @Query('hours') hoursRaw?: string,
    ) {
        const hours = Number(hoursRaw);
        const lookbackHours = Number.isFinite(hours) && hours > 0 ? hours : 168;
        return this.clientStatisticsService.getChartDataForGroup(
            address,
            workerName,
            lookbackHours,
        );
    }

    @Get(':address/:workerName')
    async getWorkerGroupInfo(@Param('address') address: string, @Param('workerName') workerName: string) {

        const workers = await this.clientService.getByName(address, workerName);

        const bestDifficulty = workers.reduce((pre, cur, idx, arr) => {
            if (cur.bestDifficulty > pre) {
                return cur.bestDifficulty;
            }
            return pre;
        }, 0);

        const chartData = await this.clientStatisticsService.getChartDataForGroup(address, workerName);
        return {

            name: workerName,
            bestDifficulty: Math.floor(bestDifficulty),
            chartData: chartData,

        }
    }

    @Get(':address/:workerName/:sessionId')
    async getWorkerInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Param('sessionId') sessionId: string) {

        if (sessionId === 'chart') {
            throw new NotFoundException();
        }

        const worker = await this.clientService.getBySessionId(address, workerName, sessionId);
        if (worker == null) {
            throw new NotFoundException();
        }
        const chartData = await this.clientStatisticsService.getChartDataForSession(worker.address, worker.clientName, worker.sessionId);

        return {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            chartData: chartData,
            startTime: worker.startTime
        }
    }
}

function sumSharesForWorker(
    shareCounts: Map<string, number>,
    address: string,
    clientName: string,
): number {
    let total = 0;
    for (const [key, count] of shareCounts) {
        const [rowAddress, rowName] = key.split('\0');
        if (rowAddress === address && rowName === clientName) {
            total += count;
        }
    }
    return total;
}

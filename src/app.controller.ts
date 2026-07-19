import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { PoolMetaService } from './ORM/pool-meta/pool-meta.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { StratumV2Service } from './services/stratum-v2.service';

@Controller()
export class AppController {

  /** Process boot time — Uptime card resets on restart. */
  private readonly bootAt = new Date();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly poolMetaService: PoolMetaService,
    private readonly stratumV2Service: StratumV2Service,
  ) { }

  /** Live SV2 authority pubkey for miner connect UI. Not cached — key is process-local. */
  @Get('info/sv2')
  public async sv2Info() {
    const authority = await this.stratumV2Service.getPoolAuthorityPublicKey();
    return {
      enabled: authority.enabled,
      authorityPublicKey: authority.publicKey,
      configured: authority.configured,
    };
  }

  @Get('info')
  public async info() {


    const CACHE_KEY = 'SITE_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const blockData = await this.blocksService.getFoundBlocks();
    const userAgents = await this.clientService.getUserAgents();
    const highScores = await this.addressSettingsService.getHighScores();
    const startedAt = await this.poolMetaService.getStartedAt();

    const data = {
      blockData,
      userAgents,
      highScores,
      uptime: this.bootAt,
      startedAt,
    };

    // Near-live dashboard
    await this.cacheManager.set(CACHE_KEY, data, 15 * 1000);

    return data;

  }

  @Get('pool')
  public async pool() {

    const CACHE_KEY = 'POOL_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const userAgents = await this.clientService.getUserAgents();
    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + Number(userAgent.totalHashRate), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + Number(userAgent.count), 0);
    const blockHeight = (await firstValueFrom(this.bitcoinRpcService.newBlock$)).blocks;
    const blocksFound = await this.blocksService.getFoundBlocks();

    const data = {
      totalHashRate,
      blockHeight,
      totalMiners,
      blocksFound,
      fee: 0
    }

    await this.cacheManager.set(CACHE_KEY, data, 15 * 1000);

    return data;
  }

  @Get('network')
  public async network() {
    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
    return miningInfo;
  }

  /** Umbrel home-screen widget: Hashrate, Workers, Best Difficulty, Total Shares */
  @Get('widgets/workers')
  public async widgetWorkers() {
    const empty = {
      type: 'four-stats',
      refresh: '5s',
      items: [
        { title: 'Hashrate', text: '-' },
        { title: 'Workers', text: '-' },
        { title: 'Best Difficulty', text: '-' },
        { title: 'Total Shares', text: '-' },
      ],
    };

    try {
      const CACHE_KEY = 'WIDGET_WORKERS';
      const cached = await this.cacheManager.get(CACHE_KEY);
      if (cached != null) return cached;

      const [userAgents, workers, shareCounts, highScores] = await Promise.all([
        this.clientService.getUserAgents(),
        this.clientService.getAllActive(),
        this.clientStatisticsService.getAcceptedShareCounts(),
        this.addressSettingsService.getHighScores(),
      ]);

      const totalHashRate = userAgents.reduce(
        (acc, row) => acc + parseFloat(String(row.totalHashRate)),
        0,
      );
      const totalWorkers = userAgents.reduce(
        (acc, row) => acc + parseInt(String(row.count), 10),
        0,
      );
      const workerBest = workers.reduce(
        (max, worker) => Math.max(max, Number(worker.bestDifficulty) || 0),
        0,
      );
      const highScoreBest = (highScores ?? []).reduce(
        (max, row) => Math.max(max, Number(row.bestDifficulty) || 0),
        0,
      );
      const bestDifficulty = Math.max(workerBest, highScoreBest);
      let totalShares = 0;
      for (const count of shareCounts.values()) {
        totalShares += count;
      }

      const rate = formatHashrateParts(totalHashRate);
      const data = {
        type: 'four-stats',
        refresh: '5s',
        items: [
          { title: 'Hashrate', text: rate.text, subtext: rate.subtext },
          { title: 'Workers', text: String(totalWorkers) },
          { title: 'Best Difficulty', text: formatCompact(bestDifficulty) },
          { title: 'Total Shares', text: formatCompact(totalShares) },
        ],
      };

      await this.cacheManager.set(CACHE_KEY, data, 5 * 1000);
      return data;
    } catch (error) {
      console.error('widgetWorkers error', error);
      return empty;
    }
  }

  @Get('info/chart/miners')
  public async infoChartMiners(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const toMs = parseChartBound(toRaw, Date.now());
    const startedAt = await this.poolMetaService.getStartedAt();
    const fromMs = parseChartBound(fromRaw, startedAt.getTime());
    const CACHE_KEY = `SITE_MINER_HASHRATE_GRAPH_${fromMs}_${toMs}`;
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData =
      await this.clientStatisticsService.getChartDataForActiveMiners(fromMs, toMs);

    await this.cacheManager.set(CACHE_KEY, chartData, 15 * 1000);

    return chartData;
  }

  @Get('info/chart')
  public async infoChart(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const toMs = parseChartBound(toRaw, Date.now());
    const startedAt = await this.poolMetaService.getStartedAt();
    const fromMs = parseChartBound(fromRaw, startedAt.getTime());
    const CACHE_KEY = `SITE_HASHRATE_GRAPH_${fromMs}_${toMs}`;
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite(fromMs, toMs);

    await this.cacheManager.set(CACHE_KEY, chartData, 15 * 1000);

    return chartData;
  }

}

function parseChartBound(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function formatHashrateParts(hashrate: number): { text: string; subtext: string } {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
  let rate = Number.isFinite(hashrate) ? hashrate : 0;
  let unitIndex = 0;
  while (rate >= 1000 && unitIndex < units.length - 1) {
    rate /= 1000;
    unitIndex += 1;
  }
  return { text: rate.toFixed(2), subtext: units[unitIndex] };
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
  const power = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
  const scaled = value / Math.pow(1000, Math.max(0, power));
  const digits = scaled >= 100 ? 0 : 2;
  return `${scaled.toFixed(digits)}${units[Math.max(0, power)]}`;
}

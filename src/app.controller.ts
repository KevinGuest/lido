import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';

@Controller()
export class AppController {

  private uptime = new Date();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
  ) { }

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

    const data = {
      blockData,
      userAgents,
      highScores,
      uptime: this.uptime
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
    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + parseFloat(userAgent.totalHashRate), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + parseInt(userAgent.count), 0);
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

  @Get('info/chart/miners')
  public async infoChartMiners(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const toMs = parseChartBound(toRaw, Date.now());
    const fromMs = parseChartBound(fromRaw, this.uptime.getTime());
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
    const fromMs = parseChartBound(fromRaw, this.uptime.getTime());
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

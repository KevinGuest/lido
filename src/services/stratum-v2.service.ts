import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Server, Socket } from 'net';
import { Subscription } from 'rxjs';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { StratumV2Client } from '../models/StratumV2Client';
import { encodeSv2AuthorityPublicKey } from '../models/sv2/sv2-authority-key';
import {
    resolveSv2ProcessNamespace,
    Sv2ExtranonceManager,
} from '../models/sv2/sv2-extranonce-manager';
import {
    EXTRANONCE1_SIZE_BYTES,
    SV2_EXTENDED_TOTAL_EXTRANONCE_SIZE_BYTES,
} from '../models/stratum.constants';
import {
    createSignatureNoiseMessage,
    generateServerKeypair,
    Sv2NoiseConfig,
    Sv2ServerKeypair,
    xOnlyPubKeyFromPriv,
} from '../models/sv2/sv2-noise';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { IJobTemplate, StratumV1JobsService } from './stratum-v1-jobs.service';

const DEFAULT_SOCKET_TIMEOUT_MS = 1000 * 60 * 60;
const DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY_MS = 1000 * 60;

/**
 * Dual-stack Stratum V2 listener (Mining Protocol, standard + extended channels).
 * Enabled when ENABLE_STRATUM_V2=true. Listens on STRATUM_V2_PORT (default 4444).
 * Reuses StratumV1JobsService templates; V1 on STRATUM_PORT is unchanged.
 */
@Injectable()
export class StratumV2Service implements OnModuleInit, OnModuleDestroy {
    private readonly servers: Server[] = [];
    private readonly clients = new Set<StratumV2Client>();
    private authorityPrivKey: Buffer;
    private authorityPublicKeyXOnly: Buffer;
    private authorityKeyConfigured = false;
    private serverKeypair: Sv2ServerKeypair;
    private noiseConfig: Sv2NoiseConfig;
    private channelIdCounter = 1;
    private extranonceManager: Sv2ExtranonceManager = null;
    private enabled = false;
    private latestCanonicalJob: IJobTemplate = null;
    private canonicalJobSubscription: Subscription = null;

    constructor(
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly addressSettingsService: AddressSettingsService,
    ) {}

    public async onModuleInit(): Promise<void> {
        if (process.env.API_ONLY === 'true' || process.env.MASTER === 'true') {
            return;
        }

        this.enabled = this.isEnabled();
        if (!this.enabled) {
            console.log('Stratum V2 disabled (set ENABLE_STRATUM_V2=true to enable)');
            return;
        }

        this.getExtranonceManager();
        await this.ensureInitialized();
        this.startCanonicalJobBroadcaster();

        const ports = this.getPorts();
        for (const port of ports) {
            this.startSocketServer(port);
        }
    }

    public async onModuleDestroy(): Promise<void> {
        this.canonicalJobSubscription?.unsubscribe();
        this.canonicalJobSubscription = null;

        const clients = Array.from(this.clients);
        this.clients.clear();
        await Promise.allSettled(clients.map(client => client.destroy()));

        for (const server of this.servers) {
            if (server.listening) {
                server.close();
            }
        }
    }

    public async ensureInitialized(): Promise<void> {
        if (this.noiseConfig != null) {
            return;
        }
        await this.initializeNoiseConfig();
    }

    public createClient(socket: Socket, firstChunk: Buffer): StratumV2Client {
        if (this.noiseConfig == null) {
            throw new Error('Stratum V2 service is not initialized');
        }

        const client = new StratumV2Client(
            socket,
            firstChunk,
            this,
            this.stratumV1JobsService,
            this.bitcoinRpcService,
            this.clientService,
            this.clientStatisticsService,
            this.notificationService,
            this.blocksService,
            this.configService,
            this.addressSettingsService,
        );
        this.registerClient(client);
        return client;
    }

    public registerClient(client: StratumV2Client): void {
        this.clients.add(client);
    }

    public unregisterClient(client: StratumV2Client): void {
        this.clients.delete(client);
    }

    public getLatestCanonicalJob(): IJobTemplate | null {
        return this.latestCanonicalJob;
    }

    public getNoiseConfig(): Sv2NoiseConfig {
        return this.noiseConfig;
    }

    public async getPoolAuthorityPublicKey(): Promise<{ publicKey: string; configured: boolean }> {
        await this.ensureInitialized();
        return {
            publicKey: encodeSv2AuthorityPublicKey(this.authorityPublicKeyXOnly),
            configured: this.authorityKeyConfigured,
        };
    }

    public getNextChannelId(): number {
        if (this.channelIdCounter > 0xffffffff) {
            throw new Error('SV2 channel ID space exhausted');
        }
        return this.channelIdCounter++;
    }

    public generateExtranoncePrefix(channelId: number): Buffer {
        return this.getExtranonceManager().allocate(channelId);
    }

    public releaseExtranoncePrefix(channelId: number): void {
        this.extranonceManager?.release(channelId);
    }

    public getExtendedMinerExtranonceSize(): number {
        return this.getExtranonceManager().minerExtranonceSize;
    }

    public getExtendedTotalExtranonceSize(): number {
        return this.getExtranonceManager().totalSize;
    }

    private startCanonicalJobBroadcaster(): void {
        if (this.canonicalJobSubscription != null) {
            return;
        }
        this.canonicalJobSubscription = this.stratumV1JobsService.newMiningJob$.subscribe({
            next: jobTemplate => {
                this.latestCanonicalJob = jobTemplate;
                for (const client of this.clients) {
                    void client.enqueueCanonicalJob(jobTemplate).catch(error => {
                        console.error(`SV2 canonical job enqueue failed: ${error.message}`);
                        this.unregisterClient(client);
                        void client.destroy();
                    });
                }
            },
            error: error => console.error(`SV2 canonical job subscription failed: ${error.message}`),
        });
    }

    private isEnabled(): boolean {
        const flag = this.configService.get<string>('ENABLE_STRATUM_V2');
        return flag === 'true' || flag === '1';
    }

    private getPorts(): number[] {
        const raw = this.configService.get<string>('STRATUM_V2_PORTS')
            ?? this.configService.get<string>('STRATUM_V2_PORT')
            ?? '4444';
        return raw
            .split(',')
            .map(part => Number.parseInt(part.trim(), 10))
            .filter(port => Number.isFinite(port) && port > 0);
    }

    private getExtranonceManager(): Sv2ExtranonceManager {
        if (this.extranonceManager == null) {
            const clusterWorkerId = (require('cluster') as { worker?: { id?: number } }).worker?.id;
            const clusterWorkerIndex = clusterWorkerId == null ? undefined : clusterWorkerId - 1;
            const processNamespace = resolveSv2ProcessNamespace(process.env, clusterWorkerIndex);
            this.extranonceManager = new Sv2ExtranonceManager(
                EXTRANONCE1_SIZE_BYTES,
                SV2_EXTENDED_TOTAL_EXTRANONCE_SIZE_BYTES,
                processNamespace,
            );
            console.log(`SV2 extranonce namespace ${processNamespace} initialized`);
        }
        return this.extranonceManager;
    }

    private async initializeNoiseConfig(): Promise<void> {
        const configuredAuthorityKey = this.configService.get<string>('SV2_AUTHORITY_PRIVKEY');
        this.authorityKeyConfigured = configuredAuthorityKey?.length === 64;
        this.authorityPrivKey = configuredAuthorityKey?.length === 64
            ? Buffer.from(configuredAuthorityKey, 'hex')
            : crypto.randomBytes(32);
        this.authorityPublicKeyXOnly = xOnlyPubKeyFromPriv(this.authorityPrivKey);

        if (!this.authorityKeyConfigured) {
            console.warn('SV2_AUTHORITY_PRIVKEY is not set; generated an ephemeral SV2 authority key');
        }

        this.serverKeypair = await generateServerKeypair();
        const now = Math.floor(Date.now() / 1000);
        this.noiseConfig = {
            staticKeypair: this.serverKeypair,
            certificateMessage: createSignatureNoiseMessage(
                this.authorityPrivKey,
                xOnlyPubKeyFromPriv(this.serverKeypair.privateKey),
                now - 3600,
                now + 86400,
            ),
        };

        const encoded = encodeSv2AuthorityPublicKey(this.authorityPublicKeyXOnly);
        console.log(`SV2 authority public key: ${encoded}`);
    }

    private startSocketServer(port: number): void {
        const server = new Server((socket: Socket) => {
            socket.setTimeout(this.getSocketTimeoutMs());
            socket.setKeepAlive(true, this.getTcpKeepAliveInitialDelayMs());
            socket.setNoDelay(true);

            let client: StratumV2Client = null;

            const closeSocket = () => {
                if (client != null) {
                    void client.destroy();
                }
                if (!socket.destroyed) {
                    socket.destroy();
                }
            };

            socket.once('data', (firstChunk: Buffer) => {
                try {
                    client = this.createClient(socket, firstChunk);
                } catch (error) {
                    console.error(`SV2 client create failed: ${(error as Error).message}`);
                    closeSocket();
                }
            });

            socket.on('error', () => closeSocket());
            socket.on('timeout', () => closeSocket());
            socket.on('close', () => {
                if (client != null) {
                    void client.destroy();
                }
            });
        });

        server.on('error', error => {
            console.error(`SV2 listener error on ${port}: ${error.message}`);
        });

        server.listen(port, () => {
            console.log(`Stratum V2 listening on ${port}`);
        });

        this.servers.push(server);
    }

    private getSocketTimeoutMs(): number {
        const raw = Number(this.configService.get<string>('SV2_SOCKET_TIMEOUT_MS'));
        return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SOCKET_TIMEOUT_MS;
    }

    private getTcpKeepAliveInitialDelayMs(): number {
        const raw = Number(this.configService.get<string>('SV2_TCP_KEEPALIVE_INITIAL_DELAY_MS'));
        return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY_MS;
    }
}

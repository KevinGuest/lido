import { ConfigService } from '@nestjs/config';
import { getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { Socket } from 'net';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { StratumV2Service } from '../services/stratum-v2.service';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { patchCoinbasePrefixVarint } from '../utils/coinbase-prefix.utils';
import { MiningJob } from './MiningJob';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { BufferReader } from './sv2/sv2-binary-codec';
import {
    SV2_CHANNEL_MSG_FLAG,
    SV2_NOISE_ACT1_SIZE,
    Sv2MiningSetupFlags,
    Sv2MiningSetupSuccessFlags,
    Sv2MsgType,
    Sv2Protocol,
} from './sv2/sv2-constants';
import {
    deserializeOpenExtendedMiningChannel,
    deserializeSubmitSharesExtended,
    serializeNewExtendedMiningJob,
    serializeOpenExtendedMiningChannelSuccess,
} from './sv2/sv2-extended-messages';
import { Sv2FrameReader, Sv2FrameWriter } from './sv2/sv2-frame';
import {
    deserializeOpenStandardMiningChannel,
    deserializeRequestExtensions,
    deserializeSetupConnection,
    deserializeSubmitSharesStandard,
    deserializeCloseChannel,
    deserializeUpdateChannel,
    serializeNewMiningJob,
    serializeOpenMiningChannelError,
    serializeOpenStandardMiningChannelSuccess,
    serializeRequestExtensionsSuccess,
    serializeSetNewPrevHash,
    serializeSetTarget,
    serializeSetupConnectionError,
    serializeSetupConnectionSuccess,
    serializeSubmitSharesError,
    serializeSubmitSharesSuccess,
    serializeUpdateChannelError,
} from './sv2/sv2-messages';
import { Sv2NoiseSession } from './sv2/sv2-noise';

const FIXED_STANDARD_EXTRANONCE2 = '0000000000000000';
const DEFAULT_START_DIFFICULTY = 100000;
const DEFAULT_MIN_DIFFICULTY = 0.001;
const DEFAULT_TARGET_SHARES_PER_MINUTE = 2;
const DEFAULT_MAX_SOCKET_BUFFER_BYTES = 256 * 1024;
const DEFAULT_SOCKET_WRITE_TIMEOUT_MS = 2_000;
const BIP320_CONSENSUS_VERSION_MASK = 0xe0001fff;

interface ChannelJobState {
    miningJob: MiningJob;
    jobTemplate: IJobTemplate;
    tipKey: string;
    nBits: number;
    prevHash: Buffer;
    /** Precomputed merkle root for standard channels. */
    merkleRoot?: Buffer;
    /** Patched coinbase split for extended channels. */
    coinbasePrefix?: Buffer;
    coinbaseSuffix?: Buffer;
    merklePath?: Buffer[];
}

interface ChannelState {
    channelId: number;
    channelType: 'standard' | 'extended';
    extranoncePrefix: Buffer;
    /** Miner-controlled extranonce bytes (8 standard / negotiated extended). */
    extranonceSize: number;
    sessionDifficulty: number;
    maxTarget: Buffer;
    readyForJobs: boolean;
    activeTipKey: string | null;
    jobs: Map<number, ChannelJobState>;
}

/**
 * SV2 Mining Protocol client: Noise + SetupConnection + standard/extended channels,
 * UpdateChannel/CloseChannel, and share/job handling on the shared V1 template stream.
 * Skips JDP / Redis.
 */
export class StratumV2Client {
    private readonly sessionId = crypto.randomBytes(4).toString('hex');
    private readonly noiseSession: Sv2NoiseSession;
    private readonly frameReader = new Sv2FrameReader(null);
    private readonly frameWriter = new Sv2FrameWriter(null);
    private readonly statistics: StratumV1ClientStatistics;
    private readonly network: bitcoinjs.networks.Network;

    private handshakeBuffer = Buffer.alloc(0);
    private handshakeComplete = false;
    private processingHandshake = false;
    private destroyed = false;
    private pendingSocketWriteBytes = 0;
    private userAgent = 'unknown/sv2';
    private versionRollingEnabled = false;
    private address: string = null;
    private workerName = 'default';
    private entity: ClientEntity = null;
    private creatingEntity: Promise<void> = null;
    private nextJobId = 1;
    private readonly channels = new Map<number, ChannelState>();
    private submissionHashes = new Set<string>();
    private readonly backgroundWork: NodeJS.Timeout[] = [];
    private lastSentMiningJobTimestamp: number | null = null;
    private readonly targetSharesPerMinute: number;

    constructor(
        private readonly socket: Socket,
        firstChunk: Buffer,
        private readonly stratumV2Service: StratumV2Service,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
    ) {
        this.noiseSession = new Sv2NoiseSession(this.stratumV2Service.getNoiseConfig());
        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
        this.network = this.resolveNetwork();
        this.targetSharesPerMinute = this.getTargetSharesPerMinute();

        this.socket.on('data', (data: Buffer) => {
            void this.handleSocketData(data);
        });

        this.backgroundWork.push(
            setInterval(() => {
                void this.checkDifficulty();
            }, 60 * 1000),
        );

        void this.handleSocketData(firstChunk);
    }

    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        for (const work of this.backgroundWork) {
            clearInterval(work);
        }
        this.backgroundWork.length = 0;
        for (const channel of this.channels.values()) {
            this.stratumV2Service.releaseExtranoncePrefix(channel.channelId);
        }
        this.channels.clear();
        this.stratumV2Service.unregisterClient(this);
        if (this.entity?.sessionId != null) {
            await this.clientService.delete(this.entity.sessionId);
        }
    }

    public async enqueueCanonicalJob(jobTemplate: IJobTemplate): Promise<void> {
        for (const channel of this.channels.values()) {
            if (!channel.readyForJobs) {
                continue;
            }
            await this.sendJobsForChannel(channel, jobTemplate);
        }
    }

    private async handleSocketData(data: Buffer): Promise<void> {
        if (this.destroyed) {
            return;
        }

        try {
            if (!this.handshakeComplete) {
                await this.handleHandshakeData(data);
            } else {
                await this.handleEncryptedData(data);
            }
        } catch (error) {
            console.error(`[SV2 ${this.sessionId}] ${(error as Error).message}`);
            this.closeSocket();
        }
    }

    private async handleHandshakeData(data: Buffer): Promise<void> {
        this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, data]);
        if (this.processingHandshake || this.handshakeBuffer.length < SV2_NOISE_ACT1_SIZE) {
            return;
        }

        this.processingHandshake = true;
        const act1 = this.handshakeBuffer.subarray(0, SV2_NOISE_ACT1_SIZE);
        const remainder = Buffer.from(this.handshakeBuffer.subarray(SV2_NOISE_ACT1_SIZE));
        this.handshakeBuffer = Buffer.alloc(0);

        const act2 = await this.noiseSession.processAct1(Buffer.from(act1));
        await this.writeRaw(act2);

        this.frameReader.setDecryptFn(ciphertext => this.noiseSession.decrypt(ciphertext));
        this.frameWriter.setEncryptFn(plaintext => this.noiseSession.encrypt(plaintext));
        this.handshakeComplete = true;
        this.processingHandshake = false;

        console.log(`[SV2 ${this.sessionId}] Noise handshake complete`);

        if (remainder.length > 0) {
            await this.handleEncryptedData(remainder);
        }
    }

    private async handleEncryptedData(data: Buffer): Promise<void> {
        const frames = this.frameReader.feed(data);
        for (const frame of frames) {
            await this.handleFrame(frame.header.msgType, frame.header.extensionType, frame.payload);
        }
    }

    private async handleFrame(msgType: number, extensionType: number, payload: Buffer): Promise<void> {
        if ((extensionType & ~SV2_CHANNEL_MSG_FLAG) === 0x0001 && msgType === 0x00) {
            const request = deserializeRequestExtensions(new BufferReader(payload));
            await this.sendFrame(
                0x01,
                serializeRequestExtensionsSuccess({
                    requestId: request.requestId,
                    supportedExtensions: [],
                }),
                0x0001,
            );
            return;
        }

        switch (msgType) {
            case Sv2MsgType.SETUP_CONNECTION:
                await this.handleSetupConnection(payload);
                break;
            case Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL:
                await this.handleOpenStandardMiningChannel(payload);
                break;
            case Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL:
                await this.handleOpenExtendedMiningChannel(payload);
                break;
            case Sv2MsgType.SUBMIT_SHARES_STANDARD:
                await this.handleSubmitSharesStandard(payload);
                break;
            case Sv2MsgType.SUBMIT_SHARES_EXTENDED:
                await this.handleSubmitSharesExtended(payload);
                break;
            case Sv2MsgType.UPDATE_CHANNEL:
                await this.handleUpdateChannel(payload);
                break;
            case Sv2MsgType.CLOSE_CHANNEL:
                this.handleCloseChannel(payload);
                break;
            default:
                console.warn(
                    `[SV2 ${this.sessionId}] Ignoring message type 0x${msgType.toString(16)}`,
                );
                break;
        }
    }

    private async handleSetupConnection(payload: Buffer): Promise<void> {
        const message = deserializeSetupConnection(new BufferReader(payload));
        this.userAgent = `${message.vendor || 'unknown'}/sv2`;

        if (message.protocol !== Sv2Protocol.MINING) {
            await this.sendFrame(
                Sv2MsgType.SETUP_CONNECTION_ERROR,
                serializeSetupConnectionError({ flags: 0, errorCode: 'unsupported-protocol' }),
            );
            this.closeSocket();
            return;
        }

        if (message.minVersion > 2 || message.maxVersion < 2) {
            await this.sendFrame(
                Sv2MsgType.SETUP_CONNECTION_ERROR,
                serializeSetupConnectionError({ flags: 0, errorCode: 'protocol-version-mismatch' }),
            );
            this.closeSocket();
            return;
        }

        const supportedFlags = Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS
            | Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION
            | Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING;
        const unsupportedFlags = message.flags & ~supportedFlags;
        if (unsupportedFlags !== 0) {
            await this.sendFrame(
                Sv2MsgType.SETUP_CONNECTION_ERROR,
                serializeSetupConnectionError({
                    flags: unsupportedFlags,
                    errorCode: 'unsupported-feature-flags',
                }),
            );
            this.closeSocket();
            return;
        }

        this.versionRollingEnabled =
            (message.flags & Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING) !== 0;
        const successFlags = this.versionRollingEnabled
            ? 0
            : Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION;

        await this.sendFrame(
            Sv2MsgType.SETUP_CONNECTION_SUCCESS,
            serializeSetupConnectionSuccess({ usedVersion: 2, flags: successFlags }),
        );
    }

    private async handleOpenStandardMiningChannel(payload: Buffer): Promise<void> {
        const message = deserializeOpenStandardMiningChannel(new BufferReader(payload));
        const { address, workerName } = this.parseUserIdentity(message.user_identity);

        if (!this.isValidAddress(address)) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            this.closeSocket();
            return;
        }

        if (this.address != null && this.address !== address) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            return;
        }

        if (message.maxTarget.length !== 32 || message.maxTarget.every(byte => byte === 0)) {
            await this.sendOpenChannelError(message.requestId, 'max-target-out-of-range');
            return;
        }

        this.address = address;
        this.workerName = workerName;

        const sessionDifficulty = this.resolveChannelDifficulty(
            message.nominalHashRate,
            message.maxTarget,
        );

        const channelId = this.stratumV2Service.getNextChannelId();
        const extranoncePrefix = this.stratumV2Service.generateExtranoncePrefix(channelId);
        const channel: ChannelState = {
            channelId,
            channelType: 'standard',
            extranoncePrefix,
            extranonceSize: Buffer.byteLength(FIXED_STANDARD_EXTRANONCE2, 'hex'),
            sessionDifficulty,
            maxTarget: Buffer.from(message.maxTarget),
            readyForJobs: false,
            activeTipKey: null,
            jobs: new Map(),
        };
        this.channels.set(channelId, channel);

        await this.sendFrame(
            Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_SUCCESS,
            serializeOpenStandardMiningChannelSuccess({
                requestId: message.requestId,
                channelId,
                target: DifficultyUtils.difficultyToTarget(sessionDifficulty),
                extranonce_prefix: extranoncePrefix,
                groupChannelId: 0,
            }),
        );

        channel.readyForJobs = true;

        const jobTemplate = this.stratumV2Service.getLatestCanonicalJob();
        if (jobTemplate != null) {
            await this.sendJobsForChannel(channel, jobTemplate);
        }

        console.log(
            `[SV2 ${this.sessionId}] Standard channel ${channelId} open `
            + `for ${address}.${workerName} diff=${sessionDifficulty}`,
        );
    }

    private async handleOpenExtendedMiningChannel(payload: Buffer): Promise<void> {
        const message = deserializeOpenExtendedMiningChannel(new BufferReader(payload));
        const { address, workerName } = this.parseUserIdentity(message.userIdentity);

        if (!this.isValidAddress(address)) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            this.closeSocket();
            return;
        }

        if (this.address != null && this.address !== address) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            return;
        }

        if (message.maxTarget.length !== 32 || message.maxTarget.every(byte => byte === 0)) {
            await this.sendOpenChannelError(message.requestId, 'max-target-out-of-range');
            return;
        }

        this.address = address;
        this.workerName = workerName;

        const channelId = this.stratumV2Service.getNextChannelId();
        const extranoncePrefix = this.stratumV2Service.generateExtranoncePrefix(channelId);
        const maxMinerExtranonceSize = Math.max(
            0,
            this.stratumV2Service.getExtendedTotalExtranonceSize() - extranoncePrefix.length,
        );
        const defaultMinerExtranonceSize = Math.min(
            this.stratumV2Service.getExtendedMinerExtranonceSize(),
            maxMinerExtranonceSize,
        );
        const requestedMinerExtranonceSize = Math.max(0, message.minExtranonceSize);
        const extranonceSize = Math.max(defaultMinerExtranonceSize, requestedMinerExtranonceSize);
        if (extranonceSize > maxMinerExtranonceSize) {
            this.stratumV2Service.releaseExtranoncePrefix(channelId);
            await this.sendOpenChannelError(message.requestId, 'min-extranonce-size-too-large');
            return;
        }

        const sessionDifficulty = this.resolveChannelDifficulty(
            message.nominalHashRate,
            message.maxTarget,
        );

        const channel: ChannelState = {
            channelId,
            channelType: 'extended',
            extranoncePrefix,
            extranonceSize,
            sessionDifficulty,
            maxTarget: Buffer.from(message.maxTarget),
            readyForJobs: false,
            activeTipKey: null,
            jobs: new Map(),
        };
        this.channels.set(channelId, channel);

        await this.sendFrame(
            Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS,
            serializeOpenExtendedMiningChannelSuccess({
                requestId: message.requestId,
                channelId,
                target: DifficultyUtils.difficultyToTarget(sessionDifficulty),
                extranonceSize,
                extranoncePrefix,
                groupChannelId: 0,
            }),
        );

        channel.readyForJobs = true;

        const jobTemplate = this.stratumV2Service.getLatestCanonicalJob();
        if (jobTemplate != null) {
            await this.sendJobsForChannel(channel, jobTemplate);
        }

        console.log(
            `[SV2 ${this.sessionId}] Extended channel ${channelId} open `
            + `for ${address}.${workerName} diff=${sessionDifficulty} en2=${extranonceSize}`,
        );
    }

    private async handleSubmitSharesStandard(payload: Buffer): Promise<void> {
        const submission = deserializeSubmitSharesStandard(new BufferReader(payload));
        const channel = this.channels.get(submission.channelId);
        if (channel == null || channel.channelType !== 'standard') {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-channel-id');
            return;
        }

        const jobState = channel.jobs.get(submission.jobId);
        if (jobState == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
            await this.recordRejectedShare();
            return;
        }

        const submissionKey = [
            submission.channelId,
            submission.jobId,
            submission.nonce,
            submission.ntime,
            submission.version,
        ].join(':');
        if (this.submissionHashes.has(submissionKey)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'duplicate-share');
            await this.recordRejectedShare();
            return;
        }
        this.submissionHashes.add(submissionKey);

        const versionMask = this.versionRollingEnabled
            ? ((submission.version ^ jobState.jobTemplate.block.version) & ~BIP320_CONSENSUS_VERSION_MASK)
            : 0;

        const header = jobState.miningJob.buildHeaderBuffer(
            jobState.jobTemplate,
            versionMask,
            submission.nonce >>> 0,
            channel.extranoncePrefix.toString('hex'),
            FIXED_STANDARD_EXTRANONCE2,
            submission.ntime >>> 0,
        );
        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);
        const target = DifficultyUtils.difficultyToTarget(channel.sessionDifficulty);
        const meetsJobTarget = DifficultyUtils.meetsTarget(hashBuffer, target);
        const isBlockCandidate = DifficultyUtils.meetsCompactTarget(hashBuffer, jobState.nBits)
            || submissionDifficulty >= jobState.jobTemplate.blockData.networkDifficulty;

        if (!meetsJobTarget && !isBlockCandidate) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
            await this.recordRejectedShare();
            return;
        }

        if (isBlockCandidate) {
            console.log('!!! BLOCK FOUND (SV2) !!!');
            const updatedJobBlock = jobState.miningJob.copyAndUpdateBlock(
                jobState.jobTemplate,
                versionMask,
                submission.nonce >>> 0,
                channel.extranoncePrefix.toString('hex'),
                FIXED_STANDARD_EXTRANONCE2,
                submission.ntime >>> 0,
            );
            const blockHex = updatedJobBlock.toHex(false);
            const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
            await this.blocksService.save({
                height: jobState.jobTemplate.blockData.height,
                minerAddress: this.address,
                worker: this.workerName,
                sessionId: this.sessionId,
                blockData: blockHex,
            });
            await this.notificationService.notifySubscribersBlockFound(
                this.address,
                jobState.jobTemplate.blockData.height,
                updatedJobBlock,
                result,
            );
            if (result == null) {
                await this.addressSettingsService.resetBestDifficultyAndShares();
            }
        }

        await this.ensureClientEntity(channel);
        try {
            await this.statistics.addShares(this.entity, channel.sessionDifficulty);
            const now = new Date();
            if (this.entity.updatedAt == null || now.getTime() - this.entity.updatedAt.getTime() > 60_000) {
                await this.clientService.heartbeat(
                    this.entity.address,
                    this.entity.clientName,
                    this.entity.sessionId,
                    this.statistics.hashRate,
                    now,
                );
                this.entity.updatedAt = now;
            }
            if (submissionDifficulty > this.entity.bestDifficulty) {
                await this.clientService.updateBestDifficultyIfHigher(this.sessionId, submissionDifficulty);
                this.entity.bestDifficulty = submissionDifficulty;
                await this.addressSettingsService.updateBestDifficultyIfHigher(
                    this.address,
                    submissionDifficulty,
                    this.userAgent,
                );
            }
        } catch (error) {
            console.log(error);
        }

        await this.sendFrame(
            Sv2MsgType.SUBMIT_SHARES_SUCCESS,
            serializeSubmitSharesSuccess({
                channelId: submission.channelId,
                lastSequenceNumber: submission.sequenceNumber,
                newSubmitsAcceptedCount: 1,
                newSharesSum: BigInt(Math.max(1, Math.floor(channel.sessionDifficulty))),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );
    }

    private async handleSubmitSharesExtended(payload: Buffer): Promise<void> {
        const submission = deserializeSubmitSharesExtended(new BufferReader(payload));
        const channel = this.channels.get(submission.channelId);
        if (channel == null || channel.channelType !== 'extended') {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-channel-id');
            return;
        }

        const jobState = channel.jobs.get(submission.jobId);
        if (jobState == null
            || jobState.coinbasePrefix == null
            || jobState.coinbaseSuffix == null
            || jobState.merklePath == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
            await this.recordRejectedShare();
            return;
        }

        if (submission.extranonce.length !== channel.extranonceSize) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-extranonce-size');
            await this.recordRejectedShare();
            return;
        }

        const submissionKey = [
            submission.channelId,
            submission.jobId,
            submission.nonce,
            submission.ntime,
            submission.version,
            submission.extranonce.toString('hex'),
        ].join(':');
        if (this.submissionHashes.has(submissionKey)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'duplicate-share');
            await this.recordRejectedShare();
            return;
        }
        this.submissionHashes.add(submissionKey);

        const coinbaseTxBytes = Buffer.concat([
            jobState.coinbasePrefix,
            channel.extranoncePrefix,
            submission.extranonce,
            jobState.coinbaseSuffix,
        ]);
        const coinbaseHash = bitcoinjs.crypto.hash256(coinbaseTxBytes);
        const merkleRoot = jobState.miningJob.buildMerkleRootFromCoinbaseHash(
            coinbaseHash,
            jobState.merklePath,
        );

        const version = this.versionRollingEnabled
            ? (submission.version >>> 0)
            : (jobState.jobTemplate.block.version >>> 0);

        const header = Buffer.alloc(80);
        header.writeUInt32LE(version, 0);
        jobState.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(submission.ntime >>> 0, 68);
        header.writeUInt32LE(jobState.nBits >>> 0, 72);
        header.writeUInt32LE(submission.nonce >>> 0, 76);

        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);
        const target = DifficultyUtils.difficultyToTarget(channel.sessionDifficulty);
        const meetsJobTarget = DifficultyUtils.meetsTarget(hashBuffer, target);
        const isBlockCandidate = DifficultyUtils.meetsCompactTarget(hashBuffer, jobState.nBits)
            || submissionDifficulty >= jobState.jobTemplate.blockData.networkDifficulty;

        if (!meetsJobTarget && !isBlockCandidate) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
            await this.recordRejectedShare();
            return;
        }

        if (isBlockCandidate) {
            console.log('!!! BLOCK FOUND (SV2 extended) !!!');
            const updatedJobBlock = this.reconstructExtendedBlock(
                jobState,
                submission,
                merkleRoot,
                channel.extranoncePrefix,
                version,
            );
            const blockHex = updatedJobBlock.toHex(false);
            const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
            await this.blocksService.save({
                height: jobState.jobTemplate.blockData.height,
                minerAddress: this.address,
                worker: this.workerName,
                sessionId: this.sessionId,
                blockData: blockHex,
            });
            await this.notificationService.notifySubscribersBlockFound(
                this.address,
                jobState.jobTemplate.blockData.height,
                updatedJobBlock,
                result,
            );
            if (result == null) {
                await this.addressSettingsService.resetBestDifficultyAndShares();
            }
        }

        await this.ensureClientEntity(channel);
        try {
            await this.statistics.addShares(this.entity, channel.sessionDifficulty);
            const now = new Date();
            if (this.entity.updatedAt == null || now.getTime() - this.entity.updatedAt.getTime() > 60_000) {
                await this.clientService.heartbeat(
                    this.entity.address,
                    this.entity.clientName,
                    this.entity.sessionId,
                    this.statistics.hashRate,
                    now,
                );
                this.entity.updatedAt = now;
            }
            if (submissionDifficulty > this.entity.bestDifficulty) {
                await this.clientService.updateBestDifficultyIfHigher(this.sessionId, submissionDifficulty);
                this.entity.bestDifficulty = submissionDifficulty;
                await this.addressSettingsService.updateBestDifficultyIfHigher(
                    this.address,
                    submissionDifficulty,
                    this.userAgent,
                );
            }
        } catch (error) {
            console.log(error);
        }

        await this.sendFrame(
            Sv2MsgType.SUBMIT_SHARES_SUCCESS,
            serializeSubmitSharesSuccess({
                channelId: submission.channelId,
                lastSequenceNumber: submission.sequenceNumber,
                newSubmitsAcceptedCount: 1,
                newSharesSum: BigInt(Math.max(1, Math.floor(channel.sessionDifficulty))),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );
    }

    private async handleUpdateChannel(payload: Buffer): Promise<void> {
        const message = deserializeUpdateChannel(new BufferReader(payload));
        const channel = this.channels.get(message.channelId);
        if (channel == null) {
            await this.sendFrame(
                Sv2MsgType.UPDATE_CHANNEL_ERROR,
                serializeUpdateChannelError({
                    channelId: message.channelId,
                    errorCode: 'invalid-channel-id',
                }),
            );
            return;
        }

        if (message.maximumTarget.length !== 32 || message.maximumTarget.every(byte => byte === 0)) {
            await this.sendFrame(
                Sv2MsgType.UPDATE_CHANNEL_ERROR,
                serializeUpdateChannelError({
                    channelId: message.channelId,
                    errorCode: 'max-target-out-of-range',
                }),
            );
            return;
        }

        channel.maxTarget = Buffer.from(message.maximumTarget);

        if (!Number.isFinite(message.nominalHashRate) || message.nominalHashRate <= 0) {
            return;
        }

        const nextDifficulty = this.resolveChannelDifficulty(
            message.nominalHashRate,
            channel.maxTarget,
        );
        if (nextDifficulty === channel.sessionDifficulty) {
            return;
        }

        console.log(
            `[SV2 ${this.sessionId}] Channel ${channel.channelId} update `
            + `${channel.sessionDifficulty} → ${nextDifficulty}`,
        );
        channel.sessionDifficulty = nextDifficulty;

        await this.sendFrame(
            Sv2MsgType.SET_TARGET,
            serializeSetTarget({
                channelId: channel.channelId,
                maxTarget: DifficultyUtils.difficultyToTarget(channel.sessionDifficulty),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );
    }

    private handleCloseChannel(payload: Buffer): void {
        const message = deserializeCloseChannel(new BufferReader(payload));
        const channel = this.channels.get(message.channelId);
        if (channel == null) {
            return;
        }

        this.stratumV2Service.releaseExtranoncePrefix(message.channelId);
        this.channels.delete(message.channelId);
        console.log(
            `[SV2 ${this.sessionId}] Channel ${message.channelId} closed `
            + `(${message.reasonCode || 'no-reason'})`,
        );

        if (this.channels.size === 0) {
            this.closeSocket();
        }
    }

    private reconstructExtendedBlock(
        jobState: ChannelJobState,
        submission: { nonce: number; ntime: number; extranonce: Buffer },
        merkleRoot: Buffer,
        extranoncePrefix: Buffer,
        version: number,
    ): bitcoinjs.Block {
        const jobTemplate = jobState.jobTemplate;
        const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
        testBlock.transactions = jobTemplate.block.transactions.map(tx =>
            Object.assign(new bitcoinjs.Transaction(), tx),
        );

        const coinbaseTx = bitcoinjs.Transaction.fromBuffer(Buffer.concat([
            jobState.coinbasePrefix,
            extranoncePrefix,
            submission.extranonce,
            jobState.coinbaseSuffix,
        ]));
        coinbaseTx.ins[0].witness = [Buffer.alloc(32)];
        testBlock.transactions[0] = coinbaseTx;
        testBlock.version = version | 0;
        testBlock.nonce = submission.nonce >>> 0;
        testBlock.timestamp = submission.ntime >>> 0;
        testBlock.merkleRoot = merkleRoot;
        testBlock.prevHash = Buffer.from(jobState.prevHash);
        testBlock.bits = jobState.nBits;
        return testBlock;
    }

    private async sendJobsForChannel(
        channel: ChannelState,
        jobTemplate: IJobTemplate,
    ): Promise<void> {
        if (channel.channelType === 'extended') {
            await this.sendExtendedJobsForChannel(channel, jobTemplate);
            return;
        }
        await this.sendStandardJobsForChannel(channel, jobTemplate);
    }

    private async sendStandardJobsForChannel(
        channel: ChannelState,
        jobTemplate: IJobTemplate,
    ): Promise<void> {
        const tipKey = `${jobTemplate.blockData.height}:${jobTemplate.block.prevHash.toString('hex')}`;
        const sendPrevHash = channel.activeTipKey !== tipKey || jobTemplate.blockData.clearJobs;

        const payoutInformation = this.getPayoutInformation();
        const miningJob = new MiningJob(
            this.configService,
            this.network,
            this.stratumV1JobsService.getNextId(),
            payoutInformation,
            jobTemplate,
        );
        this.stratumV1JobsService.addJob(miningJob);

        const merkleRoot = miningJob.buildCoinbaseMerkleRoot(
            channel.extranoncePrefix.toString('hex'),
            FIXED_STANDARD_EXTRANONCE2,
        );
        const jobId = this.allocateJobId();

        if (sendPrevHash || jobTemplate.blockData.clearJobs) {
            channel.jobs.clear();
        }

        channel.jobs.set(jobId, {
            miningJob,
            jobTemplate,
            merkleRoot,
            tipKey,
            nBits: jobTemplate.block.bits >>> 0,
            prevHash: Buffer.from(jobTemplate.block.prevHash),
        });

        await this.sendFrame(
            Sv2MsgType.NEW_MINING_JOB,
            serializeNewMiningJob({
                channelId: channel.channelId,
                jobId,
                minNtime: sendPrevHash ? null : jobTemplate.block.timestamp,
                version: jobTemplate.block.version >>> 0,
                merkleRoot,
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        if (sendPrevHash) {
            await this.sendFrame(
                Sv2MsgType.SET_NEW_PREV_HASH,
                serializeSetNewPrevHash({
                    channelId: channel.channelId,
                    jobId,
                    prevHash: Buffer.from(jobTemplate.block.prevHash),
                    minNtime: jobTemplate.block.timestamp >>> 0,
                    nBits: jobTemplate.block.bits >>> 0,
                }),
                SV2_CHANNEL_MSG_FLAG,
            );
            channel.activeTipKey = tipKey;
        }

        await this.sendFrame(
            Sv2MsgType.SET_TARGET,
            serializeSetTarget({
                channelId: channel.channelId,
                maxTarget: DifficultyUtils.difficultyToTarget(channel.sessionDifficulty),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        this.lastSentMiningJobTimestamp = jobTemplate.block.timestamp;
    }

    private async sendExtendedJobsForChannel(
        channel: ChannelState,
        jobTemplate: IJobTemplate,
    ): Promise<void> {
        const tipKey = `${jobTemplate.blockData.height}:${jobTemplate.block.prevHash.toString('hex')}`;
        const sendPrevHash = channel.activeTipKey !== tipKey || jobTemplate.blockData.clearJobs;

        const payoutInformation = this.getPayoutInformation();
        const miningJob = new MiningJob(
            this.configService,
            this.network,
            this.stratumV1JobsService.getNextId(),
            payoutInformation,
            jobTemplate,
        );
        this.stratumV1JobsService.addJob(miningJob);

        const totalExtranonceSize = channel.extranoncePrefix.length + channel.extranonceSize;
        const coinbasePrefix = patchCoinbasePrefixVarint(
            miningJob.getCoinbasePrefixBuffer(),
            totalExtranonceSize,
        );
        const coinbaseSuffix = miningJob.getCoinbaseSuffixBuffer();
        const merklePath = miningJob.getMerkleBranchBuffers();
        const jobId = this.allocateJobId();

        if (sendPrevHash || jobTemplate.blockData.clearJobs) {
            channel.jobs.clear();
        }

        channel.jobs.set(jobId, {
            miningJob,
            jobTemplate,
            tipKey,
            nBits: jobTemplate.block.bits >>> 0,
            prevHash: Buffer.from(jobTemplate.block.prevHash),
            coinbasePrefix,
            coinbaseSuffix,
            merklePath,
        });

        await this.sendFrame(
            Sv2MsgType.NEW_EXTENDED_MINING_JOB,
            serializeNewExtendedMiningJob({
                channelId: channel.channelId,
                jobId,
                minNtime: sendPrevHash ? null : jobTemplate.block.timestamp,
                version: jobTemplate.block.version >>> 0,
                versionRollingAllowed: this.versionRollingEnabled,
                merklePath,
                coinbasePrefix,
                coinbaseSuffix,
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        if (sendPrevHash) {
            await this.sendFrame(
                Sv2MsgType.SET_NEW_PREV_HASH,
                serializeSetNewPrevHash({
                    channelId: channel.channelId,
                    jobId,
                    prevHash: Buffer.from(jobTemplate.block.prevHash),
                    minNtime: jobTemplate.block.timestamp >>> 0,
                    nBits: jobTemplate.block.bits >>> 0,
                }),
                SV2_CHANNEL_MSG_FLAG,
            );
            channel.activeTipKey = tipKey;
        }

        await this.sendFrame(
            Sv2MsgType.SET_TARGET,
            serializeSetTarget({
                channelId: channel.channelId,
                maxTarget: DifficultyUtils.difficultyToTarget(channel.sessionDifficulty),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        this.lastSentMiningJobTimestamp = jobTemplate.block.timestamp;
    }

    private allocateJobId(): number {
        const jobId = this.nextJobId++;
        if (this.nextJobId > 0xffffffff) {
            this.nextJobId = 1;
        }
        return jobId;
    }

    private async checkDifficulty(): Promise<void> {
        if (this.destroyed || this.channels.size === 0) {
            return;
        }

        for (const channel of this.channels.values()) {
            if (!channel.readyForJobs) {
                continue;
            }

            const suggested = this.statistics.getSuggestedDifficulty(channel.sessionDifficulty);
            if (suggested == null) {
                continue;
            }

            const targetDiff = DifficultyUtils.clampDifficultyToMaxTarget(
                suggested,
                channel.maxTarget,
            );
            if (targetDiff === channel.sessionDifficulty) {
                continue;
            }

            console.log(
                `[SV2 ${this.sessionId}] Channel ${channel.channelId} difficulty `
                + `${channel.sessionDifficulty} → ${targetDiff}`,
            );
            channel.sessionDifficulty = targetDiff;

            await this.sendFrame(
                Sv2MsgType.SET_TARGET,
                serializeSetTarget({
                    channelId: channel.channelId,
                    maxTarget: DifficultyUtils.difficultyToTarget(channel.sessionDifficulty),
                }),
                SV2_CHANNEL_MSG_FLAG,
            );

            const jobTemplate = this.stratumV2Service.getLatestCanonicalJob();
            if (jobTemplate == null) {
                continue;
            }

            const nextTimestamp = Math.max(
                jobTemplate.block.timestamp,
                Math.floor(Date.now() / 1000),
                (this.lastSentMiningJobTimestamp ?? 0) + 1,
            );
            const refreshedJobTemplate: IJobTemplate = {
                ...jobTemplate,
                block: Object.assign(new bitcoinjs.Block(), jobTemplate.block, {
                    timestamp: nextTimestamp,
                }),
                blockData: { ...jobTemplate.blockData, clearJobs: true },
            };
            await this.sendJobsForChannel(channel, refreshedJobTemplate);
        }
    }

    private getPayoutInformation(): { address: string; percent: number }[] {
        const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
        const hashRate = this.statistics.hashRate;
        const noFee = hashRate != 0 && hashRate < 50_000_000_000_000;
        if (noFee || !devFeeAddress) {
            return [{ address: this.address, percent: 100 }];
        }
        return [
            { address: devFeeAddress, percent: 1.5 },
            { address: this.address, percent: 98.5 },
        ];
    }

    private async ensureClientEntity(channel: ChannelState): Promise<void> {
        if (this.entity != null) {
            return;
        }
        if (this.creatingEntity == null) {
            this.creatingEntity = (async () => {
                this.entity = await this.clientService.insert({
                    sessionId: this.sessionId,
                    address: this.address,
                    clientName: this.workerName,
                    userAgent: this.userAgent,
                    startTime: new Date(),
                    bestDifficulty: 0,
                });
                await this.clientService.softDeleteOtherSessions(
                    this.address,
                    this.workerName,
                    this.sessionId,
                );
            })();
        }
        await this.creatingEntity;
        void channel;
    }

    private async recordRejectedShare(): Promise<void> {
        if (!this.address || !this.statistics) {
            return;
        }
        try {
            if (this.channels.size > 0) {
                const channel = this.channels.values().next().value as ChannelState;
                await this.ensureClientEntity(channel);
            }
            if (this.entity) {
                await this.statistics.addRejected(this.entity);
            }
        } catch (error) {
            console.log(error);
        }
    }

    private parseUserIdentity(identity: string): { address: string; workerName: string } {
        const trimmed = (identity || '').trim();
        const dot = trimmed.indexOf('.');
        if (dot <= 0) {
            return { address: trimmed, workerName: 'default' };
        }
        return {
            address: trimmed.slice(0, dot),
            workerName: trimmed.slice(dot + 1) || 'default',
        };
    }

    private isValidAddress(address: string): boolean {
        try {
            getAddressInfo(address);
            return true;
        } catch {
            return false;
        }
    }

    private getInitialDifficulty(): number {
        const configured = Number(this.configService.get('SV2_START_DIFFICULTY'));
        if (Number.isFinite(configured) && configured > 0) {
            return configured;
        }
        const minDiff = Number(this.configService.get('MINIMUM_DIFFICULTY'));
        if (Number.isFinite(minDiff) && minDiff > 0) {
            return Math.max(minDiff, DEFAULT_MIN_DIFFICULTY);
        }
        return DEFAULT_START_DIFFICULTY;
    }

    private getTargetSharesPerMinute(): number {
        const configured = Number(this.configService.get('SV2_TARGET_SHARES_PER_MINUTE'));
        return Number.isFinite(configured) && configured > 0
            ? configured
            : DEFAULT_TARGET_SHARES_PER_MINUTE;
    }

    private getMinimumDifficulty(): number {
        const minDiff = Number(this.configService.get('MINIMUM_DIFFICULTY'));
        if (Number.isFinite(minDiff) && minDiff > 0) {
            return Math.max(minDiff, DEFAULT_MIN_DIFFICULTY);
        }
        return DEFAULT_MIN_DIFFICULTY;
    }

    private clampDifficulty(difficulty: number): number {
        if (!Number.isFinite(difficulty) || difficulty <= 0) {
            return this.getInitialDifficulty();
        }
        return Math.max(difficulty, this.getMinimumDifficulty());
    }

    private resolveChannelDifficulty(nominalHashRate: number, maxTarget: Buffer): number {
        let sessionDifficulty = this.getInitialDifficulty();
        if (Number.isFinite(nominalHashRate) && nominalHashRate > 0) {
            const calculated = DifficultyUtils.hashRateToDifficulty(
                nominalHashRate,
                this.targetSharesPerMinute,
            );
            if (Number.isFinite(calculated) && calculated > 0) {
                sessionDifficulty = calculated;
            }
        }
        return this.clampDifficulty(
            DifficultyUtils.clampDifficultyToMaxTarget(sessionDifficulty, maxTarget),
        );
    }

    private resolveNetwork(): bitcoinjs.networks.Network {
        const networkConfig = this.configService.get('NETWORK');
        if (networkConfig === 'testnet') {
            return bitcoinjs.networks.testnet;
        }
        if (networkConfig === 'regtest') {
            return bitcoinjs.networks.regtest;
        }
        return bitcoinjs.networks.bitcoin;
    }

    private async sendOpenChannelError(requestId: number, errorCode: string): Promise<void> {
        await this.sendFrame(
            Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR,
            serializeOpenMiningChannelError({ requestId, errorCode }),
        );
    }

    private async sendShareError(
        channelId: number,
        sequenceNumber: number,
        errorCode: string,
    ): Promise<void> {
        await this.sendFrame(
            Sv2MsgType.SUBMIT_SHARES_ERROR,
            serializeSubmitSharesError({ channelId, sequenceNumber, errorCode }),
            SV2_CHANNEL_MSG_FLAG,
        );
    }

    private async sendFrame(msgType: number, payload: Buffer, extensionType = 0): Promise<void> {
        const data = this.frameWriter.writeFrame({
            extensionType,
            msgType,
            msgLength: payload.length,
        }, payload);
        await this.writeRaw(data);
    }

    private async writeRaw(data: Buffer): Promise<void> {
        if (this.destroyed || this.socket.destroyed || this.socket.writableEnded) {
            return;
        }

        const socketBufferedBytes = Number.isFinite(this.socket.writableLength)
            ? this.socket.writableLength
            : 0;
        const bufferedBytes = Math.max(socketBufferedBytes, this.pendingSocketWriteBytes);
        if (bufferedBytes + data.length > DEFAULT_MAX_SOCKET_BUFFER_BYTES) {
            throw new Error(
                `SV2 socket buffer would reach ${bufferedBytes + data.length} bytes `
                + `(limit ${DEFAULT_MAX_SOCKET_BUFFER_BYTES})`,
            );
        }

        this.pendingSocketWriteBytes += data.length;
        try {
            await new Promise<void>((resolve, reject) => {
                let completed = false;
                const timer = setTimeout(() => {
                    finish(new Error(`SV2 socket write timed out after ${DEFAULT_SOCKET_WRITE_TIMEOUT_MS}ms`));
                }, DEFAULT_SOCKET_WRITE_TIMEOUT_MS);

                const finish = (error?: Error): void => {
                    if (completed) {
                        return;
                    }
                    completed = true;
                    clearTimeout(timer);
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

                const ok = this.socket.write(data, (error?: Error | null) => {
                    if (error) {
                        finish(error);
                    } else {
                        finish();
                    }
                });
                if (!ok) {
                    this.socket.once('drain', () => finish());
                }
            });
        } finally {
            this.pendingSocketWriteBytes = Math.max(0, this.pendingSocketWriteBytes - data.length);
        }
    }

    private closeSocket(): void {
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
        void this.destroy();
    }
}

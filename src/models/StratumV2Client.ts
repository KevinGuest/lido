import * as crypto from 'crypto';
import { Socket } from 'net';

import { StratumV2Service } from '../services/stratum-v2.service';
import { BufferReader } from './sv2/sv2-binary-codec';
import {
    SV2_CHANNEL_MSG_FLAG,
    SV2_NOISE_ACT1_SIZE,
    Sv2MiningSetupFlags,
    Sv2MiningSetupSuccessFlags,
    Sv2MsgType,
    Sv2Protocol,
} from './sv2/sv2-constants';
import { Sv2FrameReader, Sv2FrameWriter } from './sv2/sv2-frame';
import {
    deserializeRequestExtensions,
    deserializeSetupConnection,
    serializeRequestExtensionsSuccess,
    serializeSetupConnectionError,
    serializeSetupConnectionSuccess,
} from './sv2/sv2-messages';
import { Sv2NoiseSession } from './sv2/sv2-noise';

const DEFAULT_MAX_SOCKET_BUFFER_BYTES = 256 * 1024;
const DEFAULT_SOCKET_WRITE_TIMEOUT_MS = 2 * 1000;

/**
 * Milestone-1 SV2 client: Noise NX handshake + SetupConnection (Mining Protocol).
 * Channel open / job / share handling lands in later slices.
 */
export class StratumV2Client {
    private readonly sessionId = crypto.randomBytes(4).toString('hex');
    private readonly noiseSession: Sv2NoiseSession;
    private readonly frameReader = new Sv2FrameReader(null);
    private readonly frameWriter = new Sv2FrameWriter(null);

    private handshakeBuffer = Buffer.alloc(0);
    private handshakeComplete = false;
    private processingHandshake = false;
    private destroyed = false;
    private pendingSocketWriteBytes = 0;
    private userAgent = 'unknown/sv2';
    private versionRollingEnabled = false;
    private workSelectionEnabled = false;

    constructor(
        private readonly socket: Socket,
        firstChunk: Buffer,
        private readonly stratumV2Service: StratumV2Service,
    ) {
        this.noiseSession = new Sv2NoiseSession(this.stratumV2Service.getNoiseConfig());

        this.socket.on('data', (data: Buffer) => {
            void this.handleSocketData(data);
        });

        void this.handleSocketData(firstChunk);
    }

    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.stratumV2Service.unregisterClient(this);
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
            default:
                console.warn(
                    `[SV2 ${this.sessionId}] Ignoring message type 0x${msgType.toString(16)} `
                    + '(channel/job/share handling not yet enabled)',
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
                serializeSetupConnectionError({
                    flags: 0,
                    errorCode: 'unsupported-protocol',
                }),
            );
            this.closeSocket();
            return;
        }

        if (message.minVersion > 2 || message.maxVersion < 2) {
            await this.sendFrame(
                Sv2MsgType.SETUP_CONNECTION_ERROR,
                serializeSetupConnectionError({
                    flags: 0,
                    errorCode: 'protocol-version-mismatch',
                }),
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

        const versionRolling = (message.flags & Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING) !== 0;
        this.versionRollingEnabled = versionRolling;
        this.workSelectionEnabled = (message.flags & Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION) !== 0;
        const successFlags = versionRolling ? 0 : Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION;

        await this.sendFrame(
            Sv2MsgType.SETUP_CONNECTION_SUCCESS,
            serializeSetupConnectionSuccess({
                usedVersion: 2,
                flags: successFlags,
            }),
        );

        console.log(
            `[SV2 ${this.sessionId}] SetupConnection ok vendor=${this.userAgent} `
            + `versionRolling=${this.versionRollingEnabled} workSelection=${this.workSelectionEnabled}`,
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

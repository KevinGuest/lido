import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { catchError, combineLatest, delay, filter, from, interval, map, Observable, of, shareReplay, startWith, Subscription, switchMap, tap, timer } from 'rxjs';

import { MiningJob } from '../models/MiningJob';
import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import { BitcoinRpcService } from './bitcoin-rpc.service';

export interface IJobTemplate {

    block: bitcoinjs.Block;
    merkle_branch: string[];
    blockData: {
        id: string,
        creation: number,
        coinbasevalue: number;
        networkDifficulty: number;
        height: number;
        clearJobs: boolean;
    };
}

const JOB_MAX_AGE_MS = 1000 * 60 * 5;
const JOB_PIPELINE_RETRY_MS = 5_000;

@Injectable()
export class StratumV1JobsService {

    public newMiningJob$: Observable<IJobTemplate>;

    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;

    public jobs: { [jobId: string]: MiningJob } = {};

    public blocks: { [id: number]: IJobTemplate } = {};

    // offset the interval so that all the cluster processes don't try and refresh at the same time.
    private delay = process.env.NODE_APP_INSTANCE == null ? 0 : parseInt(process.env.NODE_APP_INSTANCE) * 5000;
    private lastBlockHeight = 0;
    private lastWorkSignature: string;
    /** Keeps the shared job pipeline subscribed for the process lifetime. */
    private readonly pipelineKeepAlive: Subscription;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService
    ) {

        const refreshInterval$ = this.delay > 0
            ? interval(60000).pipe(delay(this.delay), startWith(-1))
            : interval(60000).pipe(startWith(-1));

        this.newMiningJob$ = combineLatest([this.bitcoinRpcService.newBlock$, refreshInterval$]).pipe(
            switchMap(([miningInfo, _intervalTick]) => {
                return from(this.bitcoinRpcService.getBlockTemplate(miningInfo.blocks)).pipe(
                    map((blockTemplate) => {
                        return {
                            blockTemplate,
                            miningInfo
                        }
                    }),
                    catchError((err) => {
                        console.error('getBlockTemplate failed; will retry on next tick:', (err as Error).message);
                        return of(null);
                    }),
                );
            }),
            filter((next): next is { blockTemplate: IBlockTemplate; miningInfo: IMiningInfo } => next != null),
            map(({ blockTemplate, miningInfo }) => {

                let clearJobs = false;
                const currentBlockHeight = miningInfo.blocks;

                if (this.lastBlockHeight == 0 || this.lastBlockHeight != currentBlockHeight) {
                    clearJobs = true;
                    this.lastBlockHeight = currentBlockHeight;
                    console.log('new block');
                }

                const currentTime = Math.floor(new Date().getTime() / 1000);
                const timestamp = blockTemplate.mintime > currentTime ? blockTemplate.mintime : currentTime;
                const workSignature = [
                    blockTemplate.previousblockhash,
                    blockTemplate.version,
                    blockTemplate.bits,
                    timestamp,
                    blockTemplate.height,
                    blockTemplate.coinbasevalue,
                    ...blockTemplate.transactions.map(tx => tx.hash ?? tx.txid ?? tx.data)
                ].join('|');

                if (!clearJobs && workSignature === this.lastWorkSignature) {
                    return null;
                }
                this.lastWorkSignature = workSignature;

                return {
                    version: blockTemplate.version,
                    bits: parseInt(blockTemplate.bits, 16),
                    prevHash: this.convertToLittleEndian(blockTemplate.previousblockhash),
                    transactions: blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data)),
                    coinbasevalue: blockTemplate.coinbasevalue,
                    timestamp,
                    networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
                    clearJobs,
                    height: blockTemplate.height
                };
            }),
            filter(next => next != null),
            map(({ version, bits, prevHash, transactions, timestamp, coinbasevalue, networkDifficulty, clearJobs, height }) => {
                const block = new bitcoinjs.Block();

                //create an empty coinbase tx
                const tempCoinbaseTx = new bitcoinjs.Transaction();
                tempCoinbaseTx.version = 2;
                tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
                tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
                transactions.unshift(tempCoinbaseTx);

                const transactionBuffers = transactions.map(tx => tx.getHash(false));

                const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
                const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter(h => h != null);
                block.merkleRoot = merkleBranches.pop();

                // remove the first (coinbase) and last (root) element from the branch
                const merkle_branch = merkleBranches.slice(1, merkleBranches.length).map(b => b.toString('hex'))

                block.prevHash = prevHash;
                block.version = version;
                block.bits = bits;
                block.timestamp = timestamp;

                block.transactions = transactions;
                block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(transactions, true);

                const id = this.getNextTemplateId();
                this.latestJobTemplateId++;
                return {
                    block,
                    merkle_branch,
                    blockData: {
                        id,
                        creation: new Date().getTime(),
                        coinbasevalue,
                        networkDifficulty,
                        height,
                        clearJobs
                    }
                }
            }),
            tap((data) => {
                if (data.blockData.clearJobs) {
                    this.blocks = {};
                    this.jobs = {};
                } else {
                    this.pruneStaleJobs();
                }
                this.blocks[data.blockData.id] = data;
            }),
            catchError((err, caught) => {
                // Keep the shared stream alive across unexpected map/tap failures.
                console.error('Mining job pipeline error; retrying:', (err as Error).message);
                return timer(JOB_PIPELINE_RETRY_MS).pipe(switchMap(() => caught));
            }),
            shareReplay({ refCount: true, bufferSize: 1 })
        );

        // Keep templates flowing even when no miners are connected, so reconnects
        // immediately receive work instead of waiting for the source to restart.
        this.pipelineKeepAlive = this.newMiningJob$.subscribe({
            error: (err) => {
                console.error('Mining job keep-alive subscription error:', err);
            },
        });
    }

    private pruneStaleJobs() {
        const now = new Date().getTime();
        for (const templateId in this.blocks) {
            if (now - this.blocks[templateId].blockData.creation > JOB_MAX_AGE_MS) {
                delete this.blocks[templateId];
            }
        }
        for (const jobId in this.jobs) {
            if (now - this.jobs[jobId].creation > JOB_MAX_AGE_MS) {
                delete this.jobs[jobId];
            }
        }
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;       // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff;       // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, (exponent - 3));   // Calculate the target value

        const maxTarget = Math.pow(2, 208) * 65535; // Easiest target (max_target)
        const difficulty: number = maxTarget / target;    // Calculate the difficulty

        return difficulty;
    }

    private convertToLittleEndian(hash: string): Buffer {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes;
    }

    public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
        return this.blocks[jobTemplateId];
    }

    public addJob(job: MiningJob) {
        this.jobs[job.jobId] = job;
        this.latestJobId++;
    }

    public getJobById(jobId: string) {
        return this.jobs[jobId];
    }

    public getNextTemplateId() {
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        return this.latestJobId.toString(16);
    }

}

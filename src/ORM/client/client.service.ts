import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom, Subject } from 'rxjs';
import { ObjectLiteral, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService {


    public insertQueue: { result: Subject<ObjectLiteral>, partialClient: Partial<ClientEntity> }[] = [];


    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    @Interval(1000 * 5)
    public async insertClients() {
        const queueCopy = [...this.insertQueue];
        this.insertQueue = [];

        if (queueCopy.length === 0) {
            return;
        }

        try {
            const results = await this.clientRepository.insert(queueCopy.map(c => c.partialClient));

            queueCopy.forEach((c, index) => {
                c.result.next(results.generatedMaps[index]);
                c.result.complete();
            });
        } catch (e) {
            queueCopy.forEach(c => c.result.error(e));
            throw e;
        }
    }

    public async killDeadClients() {
        // Stale sessions after reconnects linger until this runs; keep tight.
        const cutoff = new Date(Date.now() - 2 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ deletedAt: () => "DATETIME('now')" })
            .where('deletedAt IS NULL')
            .andWhere('updatedAt < :cutoff', { cutoff })
            .execute();
    }

    /** Soft-delete older sessions when the same address.worker has multiple live rows. */
    public async pruneDuplicateSessions() {
        const workers = await this.clientRepository.find({
            order: { updatedAt: 'DESC' },
        });
        const keep = new Set<string>();
        const drop: string[] = [];

        for (const worker of workers) {
            const key = `${worker.address}\0${worker.clientName}`;
            if (keep.has(key)) {
                drop.push(worker.sessionId);
            } else {
                keep.add(key);
            }
        }

        if (drop.length === 0) return { affected: 0 };

        return await this.clientRepository
            .createQueryBuilder()
            .softDelete()
            .where('sessionId IN (:...drop)', { drop })
            .andWhere('deletedAt IS NULL')
            .execute();
    }

    public async heartbeat(address: string, clientName: string, sessionId: string, hashRate: number, updatedAt: Date) {
        return await this.clientRepository.update({ address, clientName, sessionId }, { hashRate, deletedAt: null, updatedAt });
    }

    // public async save(client: Partial<ClientEntity>) {
    //     return await this.clientRepository.save(client);
    // }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {

        const result = new Subject<ObjectLiteral>();

        this.insertQueue.push({ result, partialClient });


        //  const insertResult = await this.clientRepository.insert(partialClient);

        const generatedMap = await firstValueFrom(result);

        const client = {
            ...partialClient,
            ...generatedMap
        };

        return client as ClientEntity;
    }

    public async delete(sessionId: string) {
        return await this.clientRepository.softDelete({ sessionId });
    }

    public async deleteOldClients() {

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .delete()
            .from(ClientEntity)
            .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    public async updateBestDifficulty(sessionId: string, bestDifficulty: number) {
        return await this.clientRepository.update({ sessionId }, { bestDifficulty });
    }

    public async updateBestDifficultyIfHigher(sessionId: string, bestDifficulty: number) {
        return await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ bestDifficulty })
            .where('sessionId = :sessionId', { sessionId })
            .andWhere('"bestDifficulty" < :bestDifficulty', { bestDifficulty })
            .execute();
    }

    public async connectedClientCount(): Promise<number> {
        return await this.clientRepository.count();
    }

    public async getAllActive(): Promise<ClientEntity[]> {
        const workers = await this.clientRepository.find({
            order: {
                updatedAt: 'DESC',
                hashRate: 'DESC',
            },
        });

        // One row per address.worker — reconnects create new sessionIds.
        // Rows are ordered newest-first; keep the freshest session's rate/timestamps.
        const byWorker = new Map<string, ClientEntity>();
        for (const worker of workers) {
            const key = `${worker.address}\0${worker.clientName}`;
            const existing = byWorker.get(key);
            if (!existing) {
                byWorker.set(key, worker);
                continue;
            }
            existing.bestDifficulty = Math.max(
                Number(existing.bestDifficulty) || 0,
                Number(worker.bestDifficulty) || 0,
            );
        }

        return Array.from(byWorker.values()).sort(
            (a, b) => (Number(b.hashRate) || 0) - (Number(a.hashRate) || 0),
        );
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }


    public async getByName(address: string, clientName: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address,
                clientName
            }
        })
    }

    public async getBySessionId(address: string, clientName: string, sessionId: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                clientName,
                sessionId
            }
        })
    }

    public async deleteAll() {
        return await this.clientRepository
            .createQueryBuilder()
            .softDelete()
            .execute();
    }

    public async getUserAgents() {
        const workers = await this.getAllActive();
        const byAgent = new Map<
            string,
            { userAgent: string; count: number; bestDifficulty: number; totalHashRate: number }
        >();

        for (const worker of workers) {
            const userAgent = worker.userAgent || 'unknown';
            const row = byAgent.get(userAgent) ?? {
                userAgent,
                count: 0,
                bestDifficulty: 0,
                totalHashRate: 0,
            };
            row.count += 1;
            row.bestDifficulty = Math.max(row.bestDifficulty, Number(worker.bestDifficulty) || 0);
            row.totalHashRate += Number(worker.hashRate) || 0;
            byAgent.set(userAgent, row);
        }

        return Array.from(byAgent.values()).sort((a, b) => b.count - a.count);
    }

}

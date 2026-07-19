import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { BlocksEntity } from './blocks.entity';


@Injectable()
export class BlocksService {

    constructor(

        private dataSource: DataSource,
        @InjectRepository(BlocksEntity)
        private blocksRepository: Repository<BlocksEntity>,
    ) {

    }


    public async save(block: Partial<BlocksEntity>) {
        await this.blocksRepository.save(block);
    }

    public async getFoundBlocks() {
        return await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true
            }
        });
    }

    public async countFoundBlocksSince(sinceMs: number): Promise<number> {
        const blocks = await this.blocksRepository.find({
            select: { id: true, createdAt: true },
        });
        return blocks.filter((block) => {
            const created = block.createdAt ? new Date(block.createdAt).getTime() : 0;
            return created >= sinceMs;
        }).length;
    }

    public async getFoundBlocksByAddress(address: string) {
        return await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true
            },
            where: {
                minerAddress: address
            }
        });
    }
}
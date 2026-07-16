import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PoolMetaEntity } from './pool-meta.entity';
import { PoolMetaService } from './pool-meta.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([PoolMetaEntity])],
    providers: [PoolMetaService],
    exports: [TypeOrmModule, PoolMetaService],
})
export class PoolMetaModule {}

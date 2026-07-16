import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class PoolMetaEntity {
    @PrimaryColumn({ type: 'integer' })
    id: number;

    /** First pool start time (survives process restarts). */
    @Column({ type: 'integer' })
    startedAt: number;
}

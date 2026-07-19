import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class PoolMetaEntity {
    @PrimaryColumn({ type: 'integer' })
    id: number;

    /** First pool start time (survives process restarts). */
    @Column({ type: 'integer' })
    startedAt: number;

    /**
     * Cumulative process uptime from prior sessions (ms).
     * Current session is added at read time / on flush.
     */
    @Column({ type: 'integer', default: 0 })
    cumulativeUptimeMs: number;

    /**
     * Accepted share counts rolled out of pruned client_statistics rows.
     * All-time accepted = this + SUM(current statistics).
     */
    @Column({ type: 'integer', default: 0 })
    rolledUpAcceptedShares: number;

    /** Rejected share counts rolled out of pruned statistics. */
    @Column({ type: 'integer', default: 0 })
    rolledUpRejectedShares: number;
}

/** Process-wide flag so stratum teardown can skip disconnect spam on app update. */
let shuttingDown = false;

export function markShuttingDown(): void {
    shuttingDown = true;
}

export function isShuttingDown(): boolean {
    return shuttingDown;
}

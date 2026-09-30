/**
 * When the draft is sent: debounced, single-flight, retried.
 *
 *   - `schedule()` after every edit: one save once the edits pause for
 *     `delayMs`, so a drag or a typed word is one request, not twenty.
 *   - Single flight: never two saves at once. Overlapping PUTs can land out of
 *     order, and an older definition arriving last would overwrite a newer one
 *     on the server. A save that comes due while another is out runs straight
 *     after it — and it sends whatever is newest THEN, not what was newest
 *     when it was scheduled (the save function reads the store).
 *   - A transient failure is retried after each of `retryDelaysMs`; an edit in
 *     between starts over. A permanent one is not retried at all.
 *   - `flush()` skips the wait (leaving the screen, the app going to the
 *     background, a test run that needs the stored definition) and resolves
 *     once nothing is left to send.
 *
 * The web's BuilderShell does the same with a 500 ms timer and an in-flight
 * queue (performVisualSave); this is that, as a unit with no React in it.
 */

export type SaveOutcome = 'done' | 'transient' | 'permanent';

export interface SchedulerOptions {
    delayMs: number;
    retryDelaysMs: readonly number[];
    /** After a transient failure: whether another attempt has been scheduled. */
    onRetry?: (willRetry: boolean) => void;
}

type Timer = ReturnType<typeof setTimeout>;

export class SaveScheduler {
    private timer: Timer | null = null;
    private retryTimer: Timer | null = null;
    private attempt = 0;
    private running: Promise<void> | null = null;
    private again = false;
    private disposed = false;

    constructor(
        private readonly save: () => Promise<SaveOutcome>,
        private readonly options: SchedulerOptions,
    ) {}

    /** An edit happened: save once edits have paused. */
    schedule(): void {
        if (this.disposed) return;
        this.clearTimers();
        this.attempt = 0;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.kick();
        }, this.options.delayMs);
    }

    /** Save now (after the one in flight); resolves once nothing is left to send. */
    flush(): Promise<void> {
        if (this.disposed) return this.running ?? Promise.resolve();
        this.clearTimers();
        this.attempt = 0;
        return this.kick();
    }

    /** Drop a waiting save or retry; one already out is left to finish. */
    cancel(): void {
        this.clearTimers();
    }

    /** Something is waiting to be sent, or is being sent. */
    get busy(): boolean {
        return this.timer !== null || this.retryTimer !== null || this.running !== null;
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimers();
    }

    private clearTimers(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.timer = null;
        this.retryTimer = null;
    }

    private kick(): Promise<void> {
        if (this.running) {
            this.again = true;
            return this.running;
        }
        const run: Promise<void> = this.loop().finally(() => {
            if (this.running === run) this.running = null;
        });
        this.running = run;
        return run;
    }

    private async loop(): Promise<void> {
        let outcome: SaveOutcome;
        do {
            this.again = false;
            outcome = await this.attemptSave();
        } while (this.again && outcome !== 'transient' && !this.disposed);
        if (outcome === 'transient') this.retryLater();
    }

    private async attemptSave(): Promise<SaveOutcome> {
        try {
            return await this.save();
        } catch {
            return 'transient';
        }
    }

    private retryLater(): void {
        const delay = this.disposed ? undefined : this.options.retryDelaysMs[this.attempt];
        this.options.onRetry?.(delay !== undefined);
        if (delay === undefined) return;
        this.attempt += 1;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.kick();
        }, delay);
    }
}

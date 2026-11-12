/**
 * The queue of callers waiting for a free lane (sqliteStatementRunner.js: an
 * owner's statement process at the cap). First come first served; a waiter
 * that is not served within its time limit is taken out and fails. Pure
 * bookkeeping: what a lane is and how one is found is the caller's.
 */

type Waiter<L> = {
    key: string;
    start: (lane: L) => void;
    fail: (err: Error) => void;
    timer: NodeJS.Timeout;
};

export class LaneWaiters<L> {
    private list: Waiter<L>[] = [];

    get size(): number { return this.list.length; }

    /**
     * Queue `start` for a lane of `key`. When no lane is handed over within
     * `limitMs`, the waiter is dropped and `fail` gets `timeoutError()`.
     */
    add(key: string, limitMs: number, start: (lane: L) => void, fail: (err: Error) => void, timeoutError: () => Error): void {
        const w: Waiter<L> = {
            key,
            start,
            fail,
            timer: setTimeout(() => {
                this.list = this.list.filter((x) => x !== w);
                fail(timeoutError());
            }, limitMs),
        };
        this.list.push(w);
    }

    /**
     * Hand lanes to waiters in order while `laneFor` finds one. Each `start`
     * runs at once, so the lane it got is busy before the next waiter looks.
     */
    serve(laneFor: (key: string) => L | null): void {
        while (this.list.length) {
            const lane = laneFor(this.list[0].key);
            if (!lane) return;
            const w = this.list.shift() as Waiter<L>;
            clearTimeout(w.timer);
            w.start(lane);
        }
    }

    /** Fail every waiter with `err` (the runner is stopping). */
    failAll(err: Error): void {
        for (const w of this.list.splice(0)) {
            clearTimeout(w.timer);
            w.fail(err);
        }
    }
}

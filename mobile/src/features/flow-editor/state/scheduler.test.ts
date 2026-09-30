/**
 * The save scheduler on a fake clock: debounced, never two saves at once, one
 * more save for a change that came due during a flight, retries with backoff
 * on a transient failure only, and a flush that skips the wait and resolves
 * once nothing is left to send.
 */

import { SaveScheduler, type SaveOutcome } from './scheduler';

/** A save whose every call waits until the test settles it. */
function deferredSaves() {
    const pending: ((outcome: SaveOutcome) => void)[] = [];
    const save = jest.fn(
        () =>
            new Promise<SaveOutcome>((resolve) => {
                pending.push(resolve);
            }),
    );
    const settle = async (outcome: SaveOutcome = 'done') => {
        const next = pending.shift();
        if (!next) throw new Error('no save in flight');
        next(outcome);
        await flushMicrotasks();
    };
    return { save, settle, inFlight: () => pending.length };
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('debounce', () => {
    it('saves once after the edits pause, however many there were', async () => {
        const save = jest.fn(async (): Promise<SaveOutcome> => 'done');
        const scheduler = new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [] });
        scheduler.schedule();
        jest.advanceTimersByTime(500);
        scheduler.schedule();
        jest.advanceTimersByTime(500);
        scheduler.schedule();
        expect(save).not.toHaveBeenCalled();
        jest.advanceTimersByTime(900);
        await flushMicrotasks();
        expect(save).toHaveBeenCalledTimes(1);
        expect(scheduler.busy).toBe(false);
    });
});

describe('single flight', () => {
    it('never starts a second save while one is out, and runs exactly one more after it', async () => {
        const { save, settle, inFlight } = deferredSaves();
        const scheduler = new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [] });
        scheduler.schedule();
        jest.advanceTimersByTime(900);
        expect(inFlight()).toBe(1);

        // Two more edits come due while the first save is out.
        scheduler.schedule();
        jest.advanceTimersByTime(900);
        scheduler.schedule();
        jest.advanceTimersByTime(900);
        expect(save).toHaveBeenCalledTimes(1);

        await settle();
        expect(save).toHaveBeenCalledTimes(2);
        await settle();
        expect(save).toHaveBeenCalledTimes(2);
        expect(scheduler.busy).toBe(false);
    });

    it('a flush during a flight resolves only after the follow-up save', async () => {
        const { save, settle } = deferredSaves();
        const scheduler = new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [] });
        void scheduler.flush();
        const done = jest.fn();
        void scheduler.flush().then(done);
        await settle();
        expect(done).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledTimes(2);
        await settle();
        expect(done).toHaveBeenCalled();
    });
});

describe('retries', () => {
    it('retries a transient failure after each backoff, then gives up and says so', async () => {
        const onRetry = jest.fn();
        const save = jest.fn(async (): Promise<SaveOutcome> => 'transient');
        const scheduler = new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [1000, 3000], onRetry });
        await scheduler.flush();
        expect(save).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenLastCalledWith(true);

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        expect(save).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(3000);
        await flushMicrotasks();
        expect(save).toHaveBeenCalledTimes(3);
        expect(onRetry).toHaveBeenLastCalledWith(false);

        jest.advanceTimersByTime(60_000);
        await flushMicrotasks();
        expect(save).toHaveBeenCalledTimes(3);
    });

    it('treats a save that throws as transient', async () => {
        const onRetry = jest.fn();
        const save = jest.fn(async (): Promise<SaveOutcome> => {
            throw new Error('boom');
        });
        await new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [1000], onRetry }).flush();
        expect(onRetry).toHaveBeenCalledWith(true);
    });

    it('does not retry a permanent failure', async () => {
        const onRetry = jest.fn();
        const save = jest.fn(async (): Promise<SaveOutcome> => 'permanent');
        await new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [1000], onRetry }).flush();
        jest.advanceTimersByTime(10_000);
        await flushMicrotasks();
        expect(save).toHaveBeenCalledTimes(1);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('an edit during the backoff starts over with the debounce', async () => {
        const outcomes: SaveOutcome[] = ['transient', 'done'];
        const save = jest.fn(async () => outcomes.shift() ?? 'done');
        const scheduler = new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [5000] });
        await scheduler.flush();
        scheduler.schedule();
        jest.advanceTimersByTime(900);
        await flushMicrotasks();
        expect(save).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(save).toHaveBeenCalledTimes(2);
    });
});

describe('dispose', () => {
    it('drops the waiting save and schedules nothing after', async () => {
        const save = jest.fn(async (): Promise<SaveOutcome> => 'done');
        const scheduler = new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [] });
        scheduler.schedule();
        scheduler.dispose();
        scheduler.schedule();
        jest.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(save).not.toHaveBeenCalled();
    });

    it('cancel drops a waiting save but leaves the scheduler usable', async () => {
        const save = jest.fn(async (): Promise<SaveOutcome> => 'done');
        const scheduler = new SaveScheduler(save, { delayMs: 900, retryDelaysMs: [] });
        scheduler.schedule();
        scheduler.cancel();
        jest.advanceTimersByTime(900);
        expect(save).not.toHaveBeenCalled();
        await scheduler.flush();
        expect(save).toHaveBeenCalledTimes(1);
    });
});

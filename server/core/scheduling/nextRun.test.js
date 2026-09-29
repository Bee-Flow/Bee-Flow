/**
 * The rules that decide when something is retried. Each of the three has a
 * failure mode that only shows up in production:
 *   - ignoring Retry-After turns a soft rate-limit into a block;
 *   - honouring a weekly cron through a failure streak means four more
 *     failures a week apart;
 *   - not widening the interval at all hammers a broken upstream forever.
 *
 * Run: node --test --test-force-exit core/scheduling/nextRun.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { nextRunFor, backoffMinutes, MAX_BACKOFF_MINUTES } = require('./nextRun');

const FROM = Date.parse('2026-08-03T10:00:00Z');

test('an interval schedule simply adds its minutes', () => {
    assert.strictEqual(nextRunFor({ everyMinutes: 30 }, FROM), '2026-08-03T10:30:00.000Z');
});

test('no schedule falls back to the default cadence', () => {
    assert.strictEqual(nextRunFor(null, FROM), '2026-08-03T11:00:00.000Z');
    assert.strictEqual(nextRunFor({}, FROM, { defaultMinutes: 15 }), '2026-08-03T10:15:00.000Z');
});

test('the floor beats a schedule that asks to poll faster than allowed', () => {
    assert.strictEqual(
        nextRunFor({ everyMinutes: 1 }, FROM, { floorMinutes: 15 }),
        '2026-08-03T10:15:00.000Z',
    );
});

test('a cron schedule is resolved with the routine scheduler’s own parser', () => {
    const iso = nextRunFor({ cron: '0 6 * * *', tz: 'Europe/Amsterdam' }, FROM);
    assert.ok(iso, 'a valid cron must resolve');
    assert.ok(Date.parse(iso) > FROM, 'and must be in the future');
});

test('an uncomputable cron falls through to the interval rather than throwing', () => {
    // A hand-edited or migrated cron must not stop a source refreshing.
    assert.strictEqual(
        nextRunFor({ cron: 'not a cron', everyMinutes: 20 }, FROM),
        '2026-08-03T10:20:00.000Z',
    );
});

test('a failure streak abandons cron for the widening interval', () => {
    // Cron says "every Monday at six". Honouring that after four failures
    // means four more failures, a week apart, before anyone notices.
    const iso = nextRunFor({ cron: '0 6 * * 1', tz: 'UTC', everyMinutes: 10 }, FROM, { consecutiveErrors: 2 });
    assert.strictEqual(iso, '2026-08-03T10:40:00.000Z', '10 minutes doubled twice');
});

test('Retry-After outranks our own schedule, cron included', () => {
    const withInterval = nextRunFor({ everyMinutes: 5 }, FROM, { retryAfterMs: 30 * 60_000 });
    assert.strictEqual(withInterval, '2026-08-03T10:30:00.000Z');

    // A cron that lands sooner than the provider allows is pushed out to it.
    const withCron = nextRunFor({ cron: '* * * * *', tz: 'UTC' }, FROM, { retryAfterMs: 45 * 60_000 });
    assert.strictEqual(withCron, '2026-08-03T10:45:00.000Z');
});

test('a Retry-After that lands sooner than the schedule does not pull it in', () => {
    // It is a floor, not an instruction to run early.
    assert.strictEqual(
        nextRunFor({ everyMinutes: 60 }, FROM, { retryAfterMs: 60_000 }),
        '2026-08-03T11:00:00.000Z',
    );
});

test('backoff doubles per failure and stops at the ceiling', () => {
    assert.strictEqual(backoffMinutes(10, 0), 10, 'no streak, no widening');
    assert.strictEqual(backoffMinutes(10, 1), 20);
    assert.strictEqual(backoffMinutes(10, 2), 40);
    assert.strictEqual(backoffMinutes(10, 3), MAX_BACKOFF_MINUTES, 'capped');
    assert.strictEqual(backoffMinutes(10, 500), MAX_BACKOFF_MINUTES, 'and stays capped');
});

test('a nonsense streak is treated as no streak, never as a negative one', () => {
    // A NULL consecutive_errors read straight from the row must not produce
    // a next run in the PAST, which would spin the job.
    for (const bad of [null, undefined, -3, NaN, '2', 1.5]) {
        assert.strictEqual(backoffMinutes(10, bad), 10, `streak ${String(bad)}`);
    }
    assert.strictEqual(nextRunFor({ everyMinutes: 10 }, FROM, { consecutiveErrors: null }), '2026-08-03T10:10:00.000Z');
});

test('a nonsense Retry-After is ignored rather than producing an invalid date', () => {
    for (const bad of [null, undefined, NaN, -1, Infinity]) {
        const iso = nextRunFor({ everyMinutes: 10 }, FROM, { retryAfterMs: bad });
        assert.strictEqual(iso, '2026-08-03T10:10:00.000Z', `retryAfterMs ${String(bad)}`);
    }
});

/**
 * datetime step: timezone option, strict calendar validation, epoch unit.
 * No module mocks: execDateTime and its helpers are pure enough to load as is.
 *
 * Run: node --test core/automationRunner/execDateTime.timezone.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { execDateTime } = require('./execDateTime');

const run = async (step) => (await execDateTime(step, {}, { steps: {}, vars: {} })).output;

test('default (no timezone) extracts in UTC', async () => {
    assert.strictEqual((await run({ op: 'extract', part: 'hour', input: '2026-10-25T00:30:00+02:00' })).value, 22);
    assert.strictEqual((await run({ op: 'extract', part: 'dayOfWeek', input: '2026-10-25T00:30:00+02:00' })).value, 6);
});

test('timezone moves extract and format to that wall clock', async () => {
    const step = { input: '2026-10-25T00:30:00+02:00', timezone: 'Europe/Amsterdam' };
    assert.strictEqual((await run({ ...step, op: 'extract', part: 'hour' })).value, 0);
    assert.strictEqual((await run({ ...step, op: 'extract', part: 'dayOfWeek' })).value, 0);
    assert.strictEqual((await run({ ...step, op: 'format', format: 'yyyy-MM-dd HH:mm' })).value, '2026-10-25 00:30');
});

test('a zone-less string is read in the step timezone', async () => {
    const o = await run({ op: 'parse', input: '2026-07-01T09:00:00', timezone: 'Europe/Amsterdam' });
    assert.strictEqual(o.iso, '2026-07-01T07:00:00.000Z');
    const winter = await run({ op: 'parse', input: '2026-01-15 09:00', timezone: 'Europe/Amsterdam' });
    assert.strictEqual(winter.iso, '2026-01-15T08:00:00.000Z');
    const utc = await run({ op: 'parse', input: '2026-07-01T09:00:00' });
    assert.strictEqual(utc.iso, '2026-07-01T09:00:00.000Z');
});

test('addDays with a timezone keeps the wall clock across a DST change', async () => {
    const o = await run({ op: 'addDays', input: '2026-10-24T09:00:00', amount: 2, timezone: 'Europe/Amsterdam' });
    assert.strictEqual(o.iso, '2026-10-26T08:00:00.000Z');
    const plain = await run({ op: 'addDays', input: '2026-10-24T09:00:00Z', amount: 2 });
    assert.strictEqual(plain.iso, '2026-10-26T09:00:00.000Z');
});

test('an unknown timezone fails loudly', async () => {
    await assert.rejects(run({ op: 'parse', input: '2026-01-01', timezone: 'Mars/Base' }), (e) => e.errorClass === 'datetime_timezone_invalid');
});

test('dates that do not exist are rejected, not rolled over', async () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-01-01T24:00:00', '2026-01-01T10:61']) {
        await assert.rejects(run({ op: 'parse', input: bad }), (e) => e.errorClass === 'datetime_unresolved_input', bad);
    }
    assert.strictEqual((await run({ op: 'parse', input: '2028-02-29' })).iso, '2028-02-29T00:00:00.000Z');
    await assert.rejects(run({ op: 'parse', input: '2026-02-29' }));
});

test('epoch seconds and milliseconds', async () => {
    const trigger = { output: { s: 1792888200, ms: 1792888200000 } };
    const go = async (step) => (await execDateTime(step, {}, { trigger, steps: {}, vars: {} })).output;
    assert.strictEqual((await go({ op: 'parse', input: 'trigger.output.s' })).iso, '2026-10-25T00:30:00.000Z');
    assert.strictEqual((await go({ op: 'parse', input: 'trigger.output.ms' })).iso, '2026-10-25T00:30:00.000Z');
    assert.strictEqual((await go({ op: 'parse', input: 'trigger.output.ms', epochUnit: 'ms' })).iso, '2026-10-25T00:30:00.000Z');
    assert.strictEqual((await go({ op: 'parse', input: 'trigger.output.s', epochUnit: 'ms' })).iso, '1970-01-21T18:01:28.200Z');
    assert.strictEqual((await go({ op: 'parse', input: 'trigger.output.s', epochUnit: 'seconds' })).iso, '2026-10-25T00:30:00.000Z');
});

test('an hour that happens twice reads as its first occurrence; a skipped hour lands later', async () => {
    const tz = 'Europe/Amsterdam';
    const fall = await run({ op: 'parse', input: '2026-10-25T02:30:00', timezone: tz });
    assert.strictEqual(fall.iso, '2026-10-25T00:30:00.000Z');
    const spring = await run({ op: 'parse', input: '2026-03-29T02:30:00', timezone: tz });
    assert.strictEqual(spring.iso, '2026-03-29T01:30:00.000Z');
});

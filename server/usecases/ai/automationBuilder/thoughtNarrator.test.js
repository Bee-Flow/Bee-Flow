/**
 * The narrator is a side channel on the builder's SSE stream, and the two
 * things that matter about it are negative: it must never change what the
 * client sees, and the small model must never see anything but the reasoning
 * window. The cadence rules (skip, never queue; one call in flight; a minimum
 * interval) exist because the LFM child runs with `--parallel 1` — a queued
 * call answers about text that is already old.
 *
 * Timers and the clock are injected so every rule is tested to the millisecond
 * without waiting; `chat` is a fake that records each call and lets the test
 * decide when (and whether) it resolves.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createThoughtNarrator, sanitiseSummary, SYSTEM } = require('./thoughtNarrator');

const SENTINEL = 'SENTINEL_BRIEF_TEXT';

function makeClock() {
    let t = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => t,
        setTimeout: (fn, ms) => {
            const id = nextId++;
            timers.set(id, { at: t + Math.max(0, ms), fn });
            return id;
        },
        clearTimeout: (id) => { timers.delete(id); },
        // Fires due timers in order, moving the clock to each one, then lands
        // on the target time — the same order real timers would take.
        advance(ms) {
            const target = t + ms;
            for (;;) {
                let next = null;
                for (const [id, x] of timers) {
                    if (x.at <= target && (!next || x.at < next.x.at)) next = { id, x };
                }
                if (!next) break;
                timers.delete(next.id);
                t = next.x.at;
                next.x.fn();
            }
            t = target;
        },
        pendingTimers: () => timers.size,
    };
}

function makeChat() {
    const calls = [];
    const chat = (modelId, messages, options) => new Promise((resolve, reject) => {
        calls.push({ modelId, messages, options, resolve, reject });
    });
    return { calls, chat };
}

// Lets the narrator's .then() handlers run after a fake call resolves.
const flush = () => new Promise(resolve => setImmediate(resolve));

const chars = (n, ch = 'a') => ch.repeat(n);

function setup(overrides = {}) {
    const clock = makeClock();
    const { calls, chat } = makeChat();
    const sent = [];
    const send = (event, data) => { sent.push([event, data]); };
    const logs = [];
    const narrator = createThoughtNarrator({
        send,
        modelId: 'lfm2.5-350m',
        chat,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: (line) => logs.push(line),
        ...overrides,
    });
    const wrapped = narrator.wrap(send);
    const summaries = () => sent.filter(([event]) => event === 'thinking_summary').map(([, data]) => data);
    return { clock, calls, sent, logs, narrator, wrapped, send, summaries };
}

test('coalesces deltas: one call carries the concatenated text once the threshold is crossed', () => {
    const { wrapped, calls } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(50, 'a') });
    wrapped('thinking', { partId: 'p1', text: chars(50, 'b') });
    assert.equal(calls.length, 0, 'below minNewChars nothing is called');
    wrapped('thinking', { partId: 'p1', text: chars(50, 'c') });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[1].content, chars(50, 'a') + chars(50, 'b') + chars(50, 'c'));
});

test('no call before minNewChars have arrived since the last summarised position', () => {
    const { wrapped, calls } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(119) });
    assert.equal(calls.length, 0);
    wrapped('thinking', { partId: 'p1', text: 'z' });
    assert.equal(calls.length, 1);
});

test('the second call is not made before minIntervalMs after the first call STARTED', async () => {
    const { wrapped, calls, clock } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(120) });
    assert.equal(calls.length, 1);
    calls[0].resolve({ content: 'Choosing the schedule' });
    await flush();

    clock.advance(100);
    wrapped('thinking', { partId: 'p1', text: chars(200, 'b') });
    assert.equal(calls.length, 1, 'enough text, but the interval has not elapsed');
    clock.advance(2399);
    assert.equal(calls.length, 1, 'one millisecond early is still too early');
    clock.advance(1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].messages[1].content, chars(200, 'b'), 'only the text since the previous summary');
});

test('never overlaps: a slow call leaves later deltas for a single follow-up after it resolves', async () => {
    const { wrapped, calls, clock } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(120) });
    assert.equal(calls.length, 1);

    clock.advance(3000);
    wrapped('thinking', { partId: 'p1', text: chars(300, 'b') });
    clock.advance(5000);
    wrapped('thinking', { partId: 'p1', text: chars(300, 'c') });
    assert.equal(calls.length, 1, 'exactly one call in flight, never a queued second');

    calls[0].resolve({ content: 'First phrase' });
    await flush();
    assert.equal(calls.length, 2, 'the follow-up fires once the first has resolved');
    assert.equal(calls[1].messages[1].content, chars(300, 'b') + chars(300, 'c'));
});

test('payload is exactly [system, window]; the window is a suffix of the fed reasoning and nothing else leaks', () => {
    // A bogus option, other stream events and a nested object all carry the
    // sentinel; the only text allowed into chat() is the reasoning tail.
    const { wrapped, calls } = setup({ brief: SENTINEL, draft: { message: SENTINEL }, history: [SENTINEL] });
    wrapped('builder_session', { builderSessionId: SENTINEL, automationId: 'a1' });
    wrapped('message', { content: SENTINEL });
    wrapped('tool_call', { name: 'builder_add_step', arguments: { label: SENTINEL }, result: { ok: true } });
    wrapped('draft', { definition: { name: SENTINEL, steps: [] } });

    const fed = chars(700, 'x') + ' choosing the schedule for the nightly export ' + chars(300, 'y');
    let offset = 0;
    while (offset < fed.length) {
        wrapped('thinking', { partId: 'p1', text: fed.slice(offset, offset + 97) });
        offset += 97;
    }
    assert.ok(calls.length >= 1);

    for (const call of calls) {
        assert.equal(call.modelId, 'lfm2.5-350m');
        assert.equal(call.messages.length, 2, 'exactly two messages');
        assert.deepEqual(call.messages[0], { role: 'system', content: SYSTEM });
        assert.equal(call.messages[1].role, 'user');
        assert.ok(call.messages[1].content.length <= 600, 'window is capped at windowChars');
        assert.ok(fed.includes(call.messages[1].content), 'the user message is a slice of the fed text');
        assert.deepEqual(call.options, { maxTokens: 24, temperature: 0, timeoutMs: 1500, reasoningEffort: 'none' });
        const everything = JSON.stringify([call.modelId, call.messages, call.options]);
        assert.ok(!everything.includes(SENTINEL), 'no argument ever contains the sentinel');
    }
    // The first call fires at the threshold crossing (194 chars fed), so the
    // window check needs a call whose buffer exceeded windowChars.
    const { wrapped: wrapped2, calls: calls2 } = setup();
    wrapped2('thinking', { partId: 'p1', text: fed });
    assert.equal(calls2.length, 1);
    assert.equal(calls2[0].messages[1].content, fed.slice(fed.length - 600), 'tail(windowChars) of the text received');
});

test('sanitises the reply: quotes and trailing punctuation stripped, words capped at maxWords', async () => {
    const { wrapped, calls, clock, summaries } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(120) });
    calls[0].resolve({ content: '"Choosing the schedule."' });
    await flush();
    assert.deepEqual(summaries().map(s => s.text), ['Choosing the schedule']);

    clock.advance(2500);
    wrapped('thinking', { partId: 'p1', text: chars(120, 'b') });
    calls[1].resolve({ content: 'one two three four five six seven eight nine ten eleven twelve' });
    await flush();
    assert.equal(summaries()[1].text, 'one two three four five six seven eight');

    clock.advance(2500);
    wrapped('thinking', { partId: 'p1', text: chars(120, 'c') });
    calls[2].resolve({ content: '\n\n  Wiring   the error  branch…\nBecause the previous step can fail.' });
    await flush();
    assert.equal(summaries()[2].text, 'Wiring the error branch', 'first non-empty line, whitespace collapsed');
});

test('sanitiseSummary handles the orders small models actually produce', () => {
    assert.equal(sanitiseSummary('"Choosing the schedule".', 8), 'Choosing the schedule');
    assert.equal(sanitiseSummary("'Wiring the error branch!'", 8), 'Wiring the error branch');
    assert.equal(sanitiseSummary('Checking the response shape:', 8), 'Checking the response shape');
    assert.equal(sanitiseSummary('...', 8), '');
    assert.equal(sanitiseSummary('', 8), '');
    assert.equal(sanitiseSummary(null, 8), '');
    assert.equal(sanitiseSummary('a b c', 2), 'a b');
    // Labels a 350M model prepends despite the instruction (measured on the demo box).
    assert.equal(sanitiseSummary('Caption: Checking the cron schedule', 8), 'Checking the cron schedule');
    assert.equal(sanitiseSummary('"Samenvatting: Het filter instellen."', 8), 'Het filter instellen');
    assert.equal(sanitiseSummary('Caption: Checking the cron schedule\n\nWiring the HTTP request', 8), 'Checking the cron schedule');
});

test('drops empty replies and a summary identical to the previous one', async () => {
    const { wrapped, calls, clock, summaries } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(120) });
    calls[0].resolve({ content: 'Same phrase' });
    await flush();

    clock.advance(2500);
    wrapped('thinking', { partId: 'p1', text: chars(120, 'b') });
    calls[1].resolve({ content: '"Same phrase."' });
    await flush();

    clock.advance(2500);
    wrapped('thinking', { partId: 'p1', text: chars(120, 'c') });
    calls[2].resolve({ content: '…' });
    await flush();

    clock.advance(2500);
    wrapped('thinking', { partId: 'p1', text: chars(120, 'd') });
    calls[3].resolve({ content: '' });
    await flush();

    assert.equal(calls.length, 4);
    assert.deepEqual(summaries().map(s => s.text), ['Same phrase']);
});

test('seq is monotonic and every summary names its part', async () => {
    const { wrapped, calls, clock, summaries } = setup();
    const phrases = ['Choosing the schedule', 'Adding the HTTP step', 'Wiring the error branch'];
    for (let i = 0; i < phrases.length; i++) {
        wrapped('thinking', { partId: `p${i}`, text: chars(120, String(i)) });
        calls[i].resolve({ content: phrases[i] });
        await flush();
        clock.advance(2500);
    }
    const out = summaries();
    assert.deepEqual(out.map(s => s.seq), [1, 2, 3]);
    assert.deepEqual(out.map(s => s.partId), ['p0', 'p1', 'p2']);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].seq > out[i - 1].seq);
});

test('forwards every event unchanged and in order, before observing it', () => {
    const clock = makeClock();
    const { calls, chat } = makeChat();
    const forwarded = [];
    const callsSeenAtForward = [];
    const target = (event, data) => {
        forwarded.push([event, data]);
        // Forward-first: when the crossing delta is forwarded the model call
        // has not been made yet.
        if (event === 'thinking') callsSeenAtForward.push(calls.length);
    };
    const narrator = createThoughtNarrator({
        send: target, modelId: 'lfm2.5-350m', chat,
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: () => {},
    });
    const wrapped = narrator.wrap(target);

    const events = [
        ['builder_session', { builderSessionId: 's1' }],
        ['thinking_start', { partId: 'p1' }],
        ['thinking', { partId: 'p1', text: chars(70) }],
        ['thinking', { partId: 'p1', text: chars(70, 'b') }],
        ['thinking_stop', { partId: 'p1' }],
        ['tool_call', { name: 'builder_add_step', arguments: {}, result: {} }],
        ['draft', { definition: { steps: [] } }],
        ['message', { content: 'Done.' }],
    ];
    for (const [event, data] of events) wrapped(event, data);

    assert.equal(forwarded.length, events.length);
    events.forEach(([event, data], i) => {
        assert.equal(forwarded[i][0], event);
        assert.strictEqual(forwarded[i][1], data, 'the same data object, not a copy');
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(callsSeenAtForward, [0, 0], 'forwarded before the call was made');
});

test('disabled when modelId is falsy: wrap returns the original send', () => {
    const send = () => {};
    for (const modelId of ['', null, undefined, '   ']) {
        const narrator = createThoughtNarrator({ send, modelId, chat: () => { throw new Error('must not be called'); } });
        assert.strictEqual(narrator.wrap(send), send);
        assert.doesNotThrow(() => narrator.close());
    }
});

test('thinking_stop is a tick opportunity under the same gates and tolerates missing data', () => {
    const { wrapped, calls, sent } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(100) });
    wrapped('thinking_stop', { partId: 'p1' });
    assert.equal(calls.length, 0, 'below minNewChars the stop does not force a call');
    assert.doesNotThrow(() => wrapped('thinking_stop'));
    assert.doesNotThrow(() => wrapped('thinking'));
    assert.doesNotThrow(() => wrapped('thinking', { partId: 'p1' }));
    assert.equal(sent.length, 5, 'all five events were still forwarded');
});

test('a new reasoning part drops the previous part\'s leftover', () => {
    const { wrapped, calls } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(100, 'a') });
    wrapped('thinking_stop', { partId: 'p1' });
    wrapped('thinking_start', { partId: 'p2' });
    wrapped('thinking', { partId: 'p2', text: chars(120, 'b') });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[1].content, chars(120, 'b'));
});

test('backs off after 3 consecutive failures and logs only the first', async () => {
    const { wrapped, calls, clock, logs, summaries } = setup();
    for (let i = 0; i < 3; i++) {
        wrapped('thinking', { partId: 'p1', text: chars(120, String(i)) });
        assert.equal(calls.length, i + 1);
        calls[i].reject(new Error('timeout'));
        await flush();
        clock.advance(2500);
    }
    wrapped('thinking', { partId: 'p1', text: chars(400, 'z') });
    clock.advance(10000);
    assert.equal(calls.length, 3, 'disabled: no fourth call');
    assert.equal(logs.length, 1, 'one log line for the whole turn');
    assert.match(logs[0], /lfm2\.5-350m/);
    assert.match(logs[0], /timeout/);
    assert.deepEqual(summaries(), []);
});

test('a success resets the failure count', async () => {
    const { wrapped, calls, clock } = setup();
    const step = async (outcome, i) => {
        wrapped('thinking', { partId: 'p1', text: chars(120, String(i)) });
        assert.equal(calls.length, i + 1, `call ${i + 1} is made`);
        if (outcome === 'ok') calls[i].resolve({ content: `Phrase ${i}` });
        else calls[i].reject(new Error('timeout'));
        await flush();
        clock.advance(2500);
    };
    await step('fail', 0);
    await step('fail', 1);
    await step('ok', 2);
    await step('fail', 3);
    await step('fail', 4);
    await step('ok', 5);
    assert.equal(calls.length, 6);
});

test('a chat that throws synchronously is a failure, never an exception on the stream', () => {
    const clock = makeClock();
    const logs = [];
    const sent = [];
    const send = (event, data) => sent.push([event, data]);
    const narrator = createThoughtNarrator({
        send, modelId: 'lfm2.5-350m',
        chat: () => { throw new Error('boom'); },
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        log: (line) => logs.push(line),
    });
    const wrapped = narrator.wrap(send);
    assert.doesNotThrow(() => wrapped('thinking', { partId: 'p1', text: chars(120) }));
    assert.equal(sent.length, 1, 'the delta was forwarded');
});

test('a late resolve after close() emits nothing and leaves no timer behind', async () => {
    const { wrapped, calls, clock, narrator, summaries } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(120) });
    assert.equal(calls.length, 1);
    wrapped('thinking', { partId: 'p1', text: chars(300, 'b') });
    narrator.close();

    calls[0].resolve({ content: 'Too late' });
    await flush();
    assert.deepEqual(summaries(), []);
    assert.equal(calls.length, 1, 'no follow-up call after close');
    assert.equal(clock.pendingTimers(), 0);

    // Deltas after close are ignored as well.
    wrapped('thinking', { partId: 'p1', text: chars(500, 'c') });
    clock.advance(10000);
    assert.equal(calls.length, 1);
});

test('close() clears an armed timer so nothing fires after the turn ends', async () => {
    const { wrapped, calls, clock, narrator } = setup();
    wrapped('thinking', { partId: 'p1', text: chars(120) });
    calls[0].resolve({ content: 'First' });
    await flush();
    clock.advance(100);
    wrapped('thinking', { partId: 'p1', text: chars(200, 'b') });
    assert.equal(clock.pendingTimers(), 1, 'a timer is waiting for the interval');
    narrator.close();
    assert.equal(clock.pendingTimers(), 0);
    clock.advance(10000);
    assert.equal(calls.length, 1);
});

test('the cadence knobs are honoured', async () => {
    const { wrapped, calls, clock, summaries } = setup({ minNewChars: 10, minIntervalMs: 1000, windowChars: 20, timeoutMs: 300, maxWords: 3 });
    wrapped('thinking', { partId: 'p1', text: chars(30) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[1].content.length, 20);
    assert.equal(calls[0].options.timeoutMs, 300);
    calls[0].resolve({ content: 'one two three four' });
    await flush();
    assert.equal(summaries()[0].text, 'one two three');
    clock.advance(999);
    wrapped('thinking', { partId: 'p1', text: chars(10, 'b') });
    assert.equal(calls.length, 1);
    clock.advance(1);
    assert.equal(calls.length, 2);
});

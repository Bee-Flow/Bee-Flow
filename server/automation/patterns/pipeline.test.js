'use strict';

/**
 * The pattern scan end to end, on the golden fixture streams: the events it
 * yields and their order, the suggestion it maps a candidate to, the name
 * masking before any card is built, the suppression and the focus ranking,
 * the cache key, and a stop mid-scan. Collectors, stores and the model are
 * injected; no module mocking.
 *
 * Run: cd server && node --test automation/patterns/pipeline.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    runPatternScan, suppressSuggestions, scanCacheKey, automationShape, focusTokens, toSuggestion,
} = require('./pipeline');
const { fixtures } = require('./__fixtures__/streams');
const { NOW, DAY, at, daysOn, mailIn, session } = require('./__fixtures__/builders');

const stream = (name) => fixtures.find((f) => f.name === name).events;

/** collectAll as the sources would run it: progress per app, then the events. */
function fakeCollect(events, { reason = null, onCall = null } = {}) {
    return async (ctx, { onProgress, signal }) => {
        if (onCall) await onCall(ctx, signal);
        if (reason) return { events: [], steps: [], reason };
        const steps = [{ source: 'mail', app: 'gmail', status: 'done', events: events.length }, { source: 'beeflow', app: 'chat', status: 'done', events: 0 }];
        for (const s of steps) {
            onProgress({ ...s, status: 'start', events: 0 });
            onProgress(s);
        }
        return { events, steps, reason: null };
    };
}

const noStores = {
    getAutomatedToolNames: async () => [],
    getAutomations: async () => [],
    getSuppressedSignatures: async () => [],
    appOfTool: (t) => t.split('_')[0],
    detectPii: null,
};

async function collect(gen) {
    const out = [];
    for await (const e of gen) out.push(e);
    return out;
}

/** A supplier invoice with a person's name in the subject, every Monday, filed by hand. */
function namedInvoices() {
    return daysOn([1]).filter((d) => d > 0).flatMap((d, i) => [
        mailIn(at(d, 8), 'gmail', `Factuur ${4000 + i} van Pieter Bakker`, { attachment: true, domain: 'd1' }),
        ...session(at(d, 9), `c-${d}`, [['gmail_read_attachment', 'gmail'], ['sheets_append_rows', 'google-sheets']]),
    ]);
}

test('the cache key is per user, mode, sources (in any order or spelling), focus and day', () => {
    const base = { userId: 'u1', mode: 'patterns', sources: ['mail', 'google_drive'], focus: '', now: NOW };
    const k = scanCacheKey(base);
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.strictEqual(scanCacheKey({ ...base, sources: ['google-drive', 'mail'] }), k);
    assert.strictEqual(scanCacheKey({ ...base, now: NOW + 60_000 }), k);
    for (const other of [{ userId: 'u2' }, { mode: 'ideas' }, { sources: ['mail'] }, { focus: 'invoices' }, { now: NOW + DAY }]) {
        assert.notStrictEqual(scanCacheKey({ ...base, ...other }), k, JSON.stringify(other));
    }
});

test('a scan yields its phases, the sources\' steps, stats, one suggestion per pattern and the result', async () => {
    const events = [...stream('invoice_gmail_to_sheet_monday'), ...stream('monday_report_upload_nextcloud')];
    const out = await collect(runPatternScan({ userId: 'u1', now: NOW, naming: { modelId: null } }, { ...noStores, collectAll: fakeCollect(events) }));
    const names = out.map((e) => e.event);
    assert.deepStrictEqual(names.filter((e, i) => e !== names[i - 1]),
        ['phase', 'source_step', 'phase', 'stats', 'phase', 'suggestion', 'result']);
    assert.deepStrictEqual(out.filter((e) => e.event === 'phase').map((e) => e.data.phase), ['collecting', 'templating', 'mining', 'naming']);
    const stats = out.find((e) => e.event === 'stats').data;
    assert.strictEqual(stats.events, events.length);
    assert.ok(stats.templates > 0 && stats.candidates >= 2);

    const { suggestions, summary, reason } = out.at(-1).data;
    assert.strictEqual(reason, null);
    assert.deepStrictEqual(out.filter((e) => e.event === 'suggestion').map((e) => e.data.suggestion), suggestions);
    assert.deepStrictEqual(summary.sources, ['gmail', 'chat']);
    assert.strictEqual(summary.patterns, suggestions.length);
    const kinds = suggestions.map((s) => s.pattern.kind).sort();
    assert.ok(kinds.includes('mail_template') && kinds.includes('file_drop'), kinds.join());
    for (const s of suggestions) {
        for (const key of ['id', 'title', 'description', 'requiredIntegrations', 'unavailableIntegrations', 'triggerKind', 'buildPrompt', 'groundedIn', 'complexity', 'evidence', 'value', 'pattern']) {
            assert.ok(key in s, `${key} on ${s.title}`);
        }
        assert.strictEqual(s.groundedIn, 'activity');
        assert.strictEqual(s.pattern.windowDays, 90);
        assert.strictEqual(s.pattern.weekdayHistogram.length, 7);
        assert.ok(s.value.minutesSavedPerMonth >= 0 && s.value.minutesSavedPerMonth <= 600);
    }
    // Ranked: higher score first.
    const scores = suggestions.map((s) => s.value.score);
    assert.deepStrictEqual([...scores].sort((a, b) => b - a), scores);
});

test('names in a template are masked before a card exists: by the guard, or by the fallback without one', async () => {
    const withGuard = async (text) => {
        const entities = [];
        for (let at2 = text.indexOf('Pieter Bakker'); at2 >= 0; at2 = text.indexOf('Pieter Bakker', at2 + 1)) {
            entities.push({ category: 'Person', offset: at2, length: 'Pieter Bakker'.length });
        }
        return { entities };
    };
    for (const detectPii of [withGuard, null]) {
        const calls = [];
        const llmClient = { chatForcedTool: async (_m, messages) => { calls.push(messages); return { structured: null }; } };
        const out = await collect(runPatternScan(
            { userId: 'u1', now: NOW, naming: { modelId: 'fast', llmClient } },
            { ...noStores, detectPii, collectAll: fakeCollect(namedInvoices()) },
        ));
        const { suggestions, summary } = out.at(-1).data;
        assert.strictEqual(suggestions.length, 1);
        assert.match(suggestions[0].pattern.template, /<name>/);
        assert.ok(!/Pieter|Bakker/.test(JSON.stringify(calls)), 'no name reaches the model');
        assert.ok(!/Pieter|Bakker/.test(JSON.stringify(suggestions)), 'no name reaches the client');
        assert.deepStrictEqual(summary.piiCategories, detectPii ? ['Person'] : []);
    }
});

test('no sources, no history, nothing repeating: the reason says which', async () => {
    let out = await collect(runPatternScan({ userId: 'u1', now: NOW }, { ...noStores, collectAll: fakeCollect([], { reason: 'no_sources' }) }));
    assert.deepStrictEqual(out.map((e) => e.event), ['phase', 'result']);
    assert.strictEqual(out.at(-1).data.reason, 'no_sources');

    out = await collect(runPatternScan({ userId: 'u1', now: NOW }, { ...noStores, collectAll: fakeCollect([]) }));
    assert.strictEqual(out.at(-1).data.reason, 'not_enough_history');

    out = await collect(runPatternScan({ userId: 'u1', now: NOW }, { ...noStores, collectAll: fakeCollect(stream('newsletter_weekly_bulk')) }));
    assert.strictEqual(out.at(-1).data.reason, 'no_patterns');
});

test('a pattern the user snoozed, or whose tools an automation already runs, is not suggested', async () => {
    const events = namedInvoices();
    const first = await collect(runPatternScan({ userId: 'u1', now: NOW }, { ...noStores, collectAll: fakeCollect(events) }));
    const sig = first.at(-1).data.suggestions[0].pattern.signature;

    const seen = [];
    const snoozed = await collect(runPatternScan({ userId: 'u1', now: NOW }, {
        ...noStores, collectAll: fakeCollect(events),
        getSuppressedSignatures: async (p) => { seen.push(p); return [{ signature: sig, action: 'snoozed', reasonCode: null }]; },
    }));
    assert.deepStrictEqual(seen, [{ userId: 'u1' }]);
    assert.deepStrictEqual(snoozed.at(-1).data.suggestions, []);
    assert.strictEqual(snoozed.at(-1).data.reason, 'no_patterns');

    const automated = await collect(runPatternScan({ userId: 'u1', now: NOW }, {
        ...noStores, collectAll: fakeCollect(events),
        getAutomatedToolNames: async () => ['gmail_read_attachment', 'sheets_append_rows'],
    }));
    assert.deepStrictEqual(automated.at(-1).data.suggestions, []);
});

test('a focus lifts the patterns it names to the top', async () => {
    const events = [...stream('invoice_gmail_to_sheet_monday'), ...stream('monday_report_upload_nextcloud')];
    const run = async (focus) => (await collect(runPatternScan({ userId: 'u1', now: NOW, focus }, { ...noStores, collectAll: fakeCollect(events) })))
        .at(-1).data.suggestions.map((s) => s.pattern.kind);
    assert.strictEqual((await run('weekly reports'))[0], 'file_drop');
    assert.strictEqual((await run('factuur'))[0], 'mail_template');
    assert.deepStrictEqual(focusTokens('The invoices, for Q3!'), ['invoice']);
});

test('a stop mid-scan ends the stream without a result, and the sources got the signal', async () => {
    const ac = new AbortController();
    let sourceSignal = null;
    const out = await collect(runPatternScan({ userId: 'u1', now: NOW, signal: ac.signal }, {
        ...noStores,
        collectAll: fakeCollect(namedInvoices(), { onCall: async (_ctx, signal) => { sourceSignal = signal; ac.abort(); } }),
    }));
    assert.strictEqual(sourceSignal, ac.signal);
    assert.ok(!out.some((e) => e.event === 'result'));
    assert.ok(!out.some((e) => e.event === 'stats'));
});

test('a cached result is re-checked against the user\'s feedback and automations', async () => {
    const mk = (signature, kind, apps, triggerKind) => ({
        id: `pat_${signature}`, title: signature,
        pattern: { signature, kind, apps, cadence: { kind: 'weekly' }, draft: { trigger: { kind: triggerKind, label: 'x' }, steps: [] } },
    });
    const list = [
        mk('aaaaaaaaaaaa', 'mail_template', ['gmail', 'google-sheets'], 'app'),
        mk('bbbbbbbbbbbb', 'file_drop', ['nextcloud'], 'schedule'),
        mk('cccccccccccc', 'sequence', ['slack'], 'schedule'),
        { id: 'sug_1', title: 'An old idea without a pattern' },
    ];
    const kept = await suppressSuggestions(list, { userId: 'u1', now: NOW }, {
        ...noStores,
        getSuppressedSignatures: async () => [{ signature: 'aaaaaaaaaaaa', action: 'dismissed', reasonCode: 'do_myself' }],
        getAutomations: async () => [{ title: 'Reports', definition: { trigger: { kind: 'schedule' }, steps: [{ tool: 'nextcloud_files_upload' }] } }],
    });
    assert.deepStrictEqual(kept.map((s) => s.id), ['pat_cccccccccccc', 'sug_1']);
});

test('an automation is compared by its trigger kind and the apps of its trigger and steps', () => {
    const shape = automationShape({
        title: 'Invoices', triggerType: 'manual',
        definition: { trigger: { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }, steps: [{ tool: 'sheets_append_rows' }, { type: 'ai' }] },
    }, (t) => t.split('_')[0]);
    assert.deepStrictEqual(shape, { title: 'Invoices', triggerKind: 'app_event', apps: ['gmail', 'sheets'] });
});

test('an app the user no longer has is listed as unavailable; Bee Flow\'s own never is', () => {
    const c = {
        kind: 'sequence', apps: ['beeflow', 'slack'], verbs: ['kb_search', 'slack_post_message'], verbApps: ['beeflow', 'slack'],
        templateIds: [], template: null, occurrences: 8, timestamps: [NOW - DAY], distinctDays: 8,
        cadence: { kind: 'weekly', perMonth: 2.7, weeksPresent: 8, weeksWindow: 13, weekdayHistogram: [0, 8, 0, 0, 0, 0, 0], lastTs: NOW - DAY },
        confidence: 'normal', minutes: { range: [2, 5], basis: 'heuristic' }, score: 0.8, reasons: [], signature: 'f'.repeat(32), draft: null,
    };
    const s = toSuggestion(c, { title: 'T', why: 'W', buildPrompt: 'B' }, { now: NOW, windowDays: 90, connected: new Set(['gmail']) });
    assert.deepStrictEqual(s.unavailableIntegrations, ['slack']);
    assert.strictEqual(s.triggerKind, 'manual');
    assert.strictEqual(s.complexity, 'quick');
    assert.strictEqual(s.evidence.signals[0].lastUsedDays, 1);
    assert.strictEqual(s.pattern.draft, null);
});

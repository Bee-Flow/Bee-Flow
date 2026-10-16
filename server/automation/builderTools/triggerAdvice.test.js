'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { appEventWarnings } = require('./triggerAdvice');
const { applyTrigger } = require('./stepBuilders/triggerApply');
const { applyAddTrigger, applyUpdateTrigger } = require('./triggers');

const nc = (event, filter = null) => ({ provider: 'nextcloud', event, filter });

test('a deliverable event with known filter keys draws no warning', () => {
    assert.deepStrictEqual(appEventWarnings(nc('file.new', { inFolder: '/Invoices', extension: 'pdf' })), []);
    assert.deepStrictEqual(appEventWarnings(nc('file.new', { any: [{ extension: 'pdf' }], expr: 'true' })), []);
});

test('share.created warns loudly that it never fires', () => {
    const w = appEventWarnings(nc('share.created'));
    assert.ok(w.some(m => /NEVER fire/.test(m)), w.join('|'));
});

test('an unknown event and an unknown provider warn', () => {
    assert.ok(appEventWarnings(nc('x')).some(m => /provides no event "x"/.test(m)));
    assert.ok(appEventWarnings({ provider: 'nope-provider', event: 'x' }).some(m => /No integration/.test(m)));
});

test('unknown filter keys, a non-numeric tagId and summaryContains on calendar.event.created warn', () => {
    assert.ok(appEventWarnings(nc('file.new', { bogusKey: 1 })).some(m => /"bogusKey"/.test(m)));
    assert.ok(appEventWarnings(nc('file.tagged', { tagId: 'invoice' })).some(m => /numeric/.test(m)));
    assert.ok(appEventWarnings(nc('file.tagged', { tagId: ['1', '2'] })).some(m => /numeric/.test(m)));
    assert.deepStrictEqual(appEventWarnings(nc('file.tagged', { tagId: 7 })), []);
    assert.ok(appEventWarnings(nc('calendar.event.created', { summaryContains: 'Review' })).some(m => /summaryContains/.test(m)));
});

test('propose / add / update trigger carry the warnings in _warnings', () => {
    const draft = {};
    const r = applyTrigger(draft, { kind: 'app_event', appProvider: 'nextcloud', appEvent: 'share.created' });
    assert.ok(r._warnings.some(m => /NEVER fire/.test(m)));
    const add = applyAddTrigger(draft, { kind: 'app_event', appProvider: 'nextcloud', appEvent: 'file.new', filter: { bogusKey: 1 } });
    assert.ok(add._warnings.some(m => /"bogusKey"/.test(m)));
    const upd = applyUpdateTrigger(draft, { triggerId: 'trg', patch: { appEvent: 'x' } });
    assert.ok(upd._warnings.some(m => /provides no event "x"/.test(m)));
});

// Drift guard: a filter key documented to the model or offered in the editor
// must be one the builder accepts without warning.
test('every documented / editor-offered Nextcloud filter key is in NEXTCLOUD_FILTER_KEYS', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { NEXTCLOUD_FILTER_KEYS } = require('./triggerAdvice');
    const { TRIGGER_PROMPT_NOTES } = require('../builderPrompt/triggerBlock');
    const bare = (entry) => String(entry).split('+').map(s => (/^\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(s) || [])[1]).filter(Boolean);
    for (const [key, note] of Object.entries(TRIGGER_PROMPT_NOTES)) {
        if (!key.startsWith('nextcloud.') || !Array.isArray(note.filters)) continue;
        const known = NEXTCLOUD_FILTER_KEYS[key.slice('nextcloud.'.length)];
        if (!known) continue;
        for (const k of note.filters.flatMap(bare)) assert.ok(known.includes(k), `${key}: documented filter "${k}" would draw an unknown-key warning`);
    }
    const src = fs.readFileSync(path.join(__dirname, '../../../agent-hub/src/components/automation/Builder/flow/settings/triggerFilters.tsx'), 'utf8');
    const keysOf = (component) => {
        const body = new RegExp(`export function ${component}\\([\\s\\S]*?\\n}\\n`).exec(src)?.[0] || '';
        return [...body.matchAll(/setFilter\('(\w+)'/g)].map(m => m[1]);
    };
    const events = [...src.matchAll(/'nextcloud\.([\w.]+)': (Nextcloud\w+),/g)];
    assert.ok(events.length > 10, 'sanity: the editor map was found');
    for (const [, event, component] of events) {
        const known = NEXTCLOUD_FILTER_KEYS[event];
        assert.ok(known, `nextcloud.${event}: the editor offers filters but the builder has no key list`);
        for (const k of keysOf(component)) assert.ok(known.includes(k), `nextcloud.${event}: the editor offers "${k}"`);
    }
});

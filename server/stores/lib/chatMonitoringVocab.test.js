'use strict';

/**
 * The chat signals vocabulary is closed, frozen and keeps its two permanent
 * exclusions: no health kind, and no surface between people.
 *
 * Run: cd server && node --test stores/lib/chatMonitoringVocab.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vocab = require('./chatMonitoringVocab');

test('everything exported is frozen', () => {
    assert.ok(Object.isFrozen(vocab), 'the module object');
    for (const [name, value] of Object.entries(vocab)) {
        if (typeof value === 'function') continue;
        if (value && typeof value === 'object') assert.ok(Object.isFrozen(value), `${name} is frozen`);
    }
    assert.throws(() => { 'use strict'; vocab.SURFACES.push('notebook'); }, TypeError);
    assert.throws(() => { 'use strict'; vocab.K.outcomes = 1; }, TypeError);
});

test('no surface is both an employee and a visitor surface', () => {
    for (const s of vocab.EMPLOYEE_SURFACES) assert.ok(!vocab.VISITOR_SURFACES.includes(s), s);
    for (const s of [...vocab.SURFACES, ...vocab.FUTURE_SURFACES]) {
        assert.ok(vocab.isEmployeeSurface(s) !== vocab.isVisitorSurface(s), `${s} has exactly one population`);
    }
});

test('messages between people can never become a surface (amendment 24)', () => {
    const surfaces = new Set([...vocab.SURFACES, ...vocab.FUTURE_SURFACES, ...vocab.EMPLOYEE_SURFACES, ...vocab.VISITOR_SURFACES]);
    for (const h of vocab.HUMAN_TO_HUMAN) assert.ok(!surfaces.has(h), `${h} is not a surface`);
    assert.deepEqual([...vocab.PHASE.surfaces], [...vocab.SURFACES]);
});

test('health is never a kind, and every other personal-data kind is', () => {
    assert.ok(!vocab.KINDS.includes('health'));
    const { KIND_OF_CATEGORY } = require('../../core/privacy/personalColumns');
    for (const kind of new Set(Object.values(KIND_OF_CATEGORY))) {
        if (kind === 'health') continue;
        assert.ok(vocab.KINDS.includes(kind), `${kind} is in KINDS`);
    }
    assert.ok(vocab.KINDS.includes('id_number'), 'identification numbers are an ordinary kind');
    assert.ok(!vocab.SIGNALS.includes('special_kinds'));
});

test('PROVIDER_TYPES covers every provider type the adapter factory knows, normalised', () => {
    const providers = require('../../core/providers');
    const named = ['openai', 'mistral', 'claude', 'google', 'google-vertex', 'azure', 'scaleway', 'eugpt', 'local'];
    for (const type of [...named, ...providers.LOCAL_PROVIDER_TYPES]) {
        assert.notEqual(providers.getAdapter(type), providers.baseAdapter, `${type} is a key of PROVIDER_MAP`);
        const normalised = type === 'google-vertex' ? 'google_vertex'
            : (type === 'local' || providers.isLocalProviderType(type)) ? 'local' : type;
        assert.ok(vocab.PROVIDER_TYPES.includes(normalised), `${type} → ${normalised}`);
    }
    assert.ok(vocab.PROVIDER_TYPES.includes('other'), 'an unknown type has somewhere to go');
});

test('the marker is a surface of this release plus an exact ISO version', () => {
    assert.ok(vocab.MARKER_RE.test('direct@2026-10-14T09:00:00.000Z'));
    assert.ok(vocab.MARKER_RE.test('agent_public@2026-10-14T09:00:00.000Z'));
    for (const bad of [
        'notebook@2026-10-14T09:00:00.000Z', 'project_chat@2026-10-14T09:00:00.000Z',
        'direct@2026-10-14', 'direct@2026-10-14T09:00:00Z', 'direct', 'hello there', '',
        'direct@2026-10-14T09:00:00.000Z ', ' direct@2026-10-14T09:00:00.000Z',
    ]) {
        assert.ok(!vocab.MARKER_RE.test(bad), JSON.stringify(bad));
    }
});

test('this release carries the objection preference, so employee surfaces may be offered', () => {
    assert.equal(vocab.PHASE.objection, true);
});

test('granularity: website visitors per day, everyone else per ISO week', () => {
    assert.equal(vocab.granularityFor('agent_public'), 'day');
    for (const s of ['direct', 'agent', 'notebook', 'voice']) assert.equal(vocab.granularityFor(s), 'week');
});

test('the readers\' thresholds and the retention range', () => {
    assert.deepEqual({ ...vocab.K }, { outcomes: 5, kinds: 10, cell: 5 });
    assert.deepEqual({ ...vocab.RETENTION }, { min: 30, max: 90, default: 90 });
    assert.equal(vocab.MIN_TURNS, 25);
    assert.equal(vocab.CHAT_MONITORING_DPIA_KEY, 'chat_monitoring');
});

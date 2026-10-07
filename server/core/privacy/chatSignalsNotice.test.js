/**
 * core/privacy/chatSignalsNotice.js: what a chat is told about chat signals.
 *
 * Pure. Pinned: each payload is an exact allow-list; a state that cannot be
 * tied to a version reads off (no version, no marker, no notice); paused and
 * unknown chat types never appear; only https links survive; the embed notice
 * needs website visitors to be counted; the agent gate needs the caller's org
 * to be the agent's org, exactly as the recorder decides who counts
 * (chatSignals.agentTurnTarget).
 *
 * Run: cd server && node --test core/privacy/chatSignalsNotice.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('./chatSignalsNotice');
const { agentTurnTarget } = require('./chatSignals');

const ON = Object.freeze({
    state: 'on', version: '2026-10-14T09:00:00.000Z', from: '2026-10-14',
    surfaces: ['direct', 'agent', 'agent_public'], paused: [], signals: ['outcomes', 'kinds'],
    noticeUrl: 'https://acme.example/chat-signals', visitorNoticeUrl: 'https://acme.example/privacy', retentionDays: 30,
});

test('the off payloads are frozen and carry no claim', () => {
    for (const off of [N.STATUS_OFF, N.EMBED_OFF, N.COUNTING_OFF]) {
        assert.ok(Object.isFrozen(off));
        assert.equal(off.state, 'off');
        assert.equal(off.from, null);
    }
    assert.deepEqual(N.statusPayload(null), N.STATUS_OFF);
    assert.deepEqual(N.embedNotice(undefined), N.EMBED_OFF);
    assert.deepEqual(N.agentCounting(null, { callerOrgId: 'o', agentOrgId: 'o' }), N.COUNTING_OFF);
});

test('statusPayload: exactly six keys, in the order the client reads them', () => {
    const p = N.statusPayload({ ...ON, paused: [{ surface: 'notebook', missing: ['x'] }], orgName: 'Acme', userId: 'u-1' });
    assert.deepEqual(p, {
        state: 'on', from: '2026-10-14', version: '2026-10-14T09:00:00.000Z',
        surfaces: ['direct', 'agent', 'agent_public'], signals: ['outcomes', 'kinds'], noticeUrl: 'https://acme.example/chat-signals',
    });
});

test('a state that cannot be tied to a version, or counts nothing, reads off', () => {
    for (const bad of [
        { ...ON, state: 'off' },
        { ...ON, state: 'paused' },
        { ...ON, version: null },
        { ...ON, version: '2026-10-14' },
        { ...ON, version: '2026-10-14T09:00:00Z' },
        { ...ON, surfaces: [] },
        { ...ON, surfaces: ['project_chat', 'comment', 'support', 'talk', 'mail'] },
        { ...ON, signals: ['kinds'] },
        { ...ON, signals: 'outcomes' },
    ]) {
        assert.deepEqual(N.statusPayload(bad), N.STATUS_OFF, JSON.stringify(bad));
        assert.deepEqual(N.embedNotice(bad), N.EMBED_OFF, JSON.stringify(bad));
        assert.deepEqual(N.agentCounting(bad, { callerOrgId: 'o', agentOrgId: 'o' }), N.COUNTING_OFF, JSON.stringify(bad));
    }
});

test('ids are filtered to the vocabulary, deduplicated and put in vocabulary order; health never appears', () => {
    const p = N.statusPayload({ ...ON, surfaces: ['agent_public', 'talk', 'direct', 'direct'], signals: ['kinds', 'health', 'outcomes'] });
    assert.deepEqual(p.surfaces, ['direct', 'agent_public']);
    assert.deepEqual(p.signals, ['outcomes', 'kinds']);
});

test('a bad start date falls back to the version\'s own day', () => {
    assert.equal(N.statusPayload({ ...ON, from: '14-10-2026' }).from, '2026-10-14');
});

test('only an absolute https link survives', () => {
    for (const url of ['http://acme.example/n', 'javascript:alert(1)', '//acme.example/n', '/privacy', '', 42, `https://acme.example/${'x'.repeat(500)}`]) {
        assert.equal(N.statusPayload({ ...ON, noticeUrl: url }).noticeUrl, null, String(url).slice(0, 40));
        assert.equal(N.embedNotice({ ...ON, visitorNoticeUrl: url }).privacyNoticeUrl, null, String(url).slice(0, 40));
    }
    assert.equal(N.httpsOrNull('https://acme.example/n?x=1'), 'https://acme.example/n?x=1');
});

test('embedNotice: only when website visitors are counted; the visitor link, five keys', () => {
    assert.deepEqual(N.embedNotice(ON), {
        state: 'on', from: '2026-10-14', version: '2026-10-14T09:00:00.000Z', signals: ['outcomes', 'kinds'],
        privacyNoticeUrl: 'https://acme.example/privacy',
    });
    assert.deepEqual(N.embedNotice({ ...ON, surfaces: ['direct', 'agent'] }), N.EMBED_OFF);
    assert.equal(N.embedNotice({ ...ON, state: 'scheduled' }).state, 'scheduled');
});

test('agentCounting: the caller is told only when the recorder would count their turn', () => {
    const cases = [
        // [callerOrgId, agentOrgId, userId]
        ['org-1', 'org-1', 'u-1'],
        ['org-2', 'org-1', 'u-1'],
        [null, 'org-1', 'u-1'],
        ['org-1', null, 'u-1'],
        [null, null, 'u-1'],
    ];
    for (const [callerOrgId, agentOrgId, userId] of cases) {
        const told = N.agentCounting(ON, { callerOrgId, agentOrgId });
        const counted = agentTurnTarget({ userId, callerOrgId, agentOrgId });
        assert.equal(told.state !== 'off', !!counted && counted.surface === 'agent', JSON.stringify({ callerOrgId, agentOrgId }));
    }
    assert.deepEqual(N.agentCounting(ON, { callerOrgId: 'org-1', agentOrgId: 'org-1' }), { state: 'on', from: '2026-10-14' });
    assert.deepEqual(N.agentCounting({ ...ON, surfaces: ['direct', 'agent_public'] }, { callerOrgId: 'org-1', agentOrgId: 'org-1' }), N.COUNTING_OFF);
});

test('announcesSurface follows the same rule', () => {
    assert.equal(N.announcesSurface(ON, 'agent'), true);
    assert.equal(N.announcesSurface({ ...ON, surfaces: ['direct'] }, 'agent'), false);
    assert.equal(N.announcesSurface({ ...ON, version: null }, 'direct'), false);
});

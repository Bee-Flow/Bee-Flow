'use strict';

/**
 * Chat signals in the processing register: present only while on, scheduled
 * or while counts remain; data subjects and legal basis follow the selection;
 * observed kinds are k-suppressed and never counted out; no ids, no numbers
 * about people, and no "anonymous" claim anywhere (amendment 5).
 *
 * Run: cd server && node --test compliance/ropa/chatMonitoringActivity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { chatMonitoringActivity } = require('./chatMonitoringActivity');

const NOW = new Date('2026-10-21T12:00:00.000Z');

function deps({ settings = {}, hasRows = false, dpia = null, kinds = {}, contributors = 12 } = {}) {
    const kindReads = [];
    return {
        kindReads,
        getSettings: async () => ({
            chat_monitoring_enabled: true,
            chat_monitoring_surfaces: ['direct', 'agent', 'agent_public'],
            chat_monitoring_signals: ['outcomes', 'kinds'],
            chat_monitoring_legal_basis: 'art6_1_f',
            chat_monitoring_retention_days: 60,
            chat_monitoring_enabled_by: 'user-secret-7',
            chat_monitoring_notice_url: 'https://intranet.example.org/n',
            ...settings,
        }),
        getDpia: async () => dpia,
        hasRows: async () => hasRows,
        kindTotals: async (org, w) => { kindReads.push(w.surfaces[0]); return kinds[w.surfaces[0]] || []; },
        contributorCount: async () => contributors,
        now: () => NOW,
    };
}

test('present only when on, scheduled, or while collected counts remain', async () => {
    assert.equal((await chatMonitoringActivity('org1', deps())).length, 1);
    assert.deepEqual(await chatMonitoringActivity('org1', deps({ settings: { chat_monitoring_enabled: false } })), []);
    const remaining = await chatMonitoringActivity('org1', deps({ settings: { chat_monitoring_enabled: false }, hasRows: true }));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].activity_id, 'chat-compliance-signals');
});

test('data subjects follow the selection, plus the third parties named in messages', async () => {
    const [all] = await chatMonitoringActivity('org1', deps());
    assert.deepEqual(all.data_subjects, [
        'Employees and members using: Direct chat, Agent chat',
        'Website visitors who chat with an embedded agent',
        'People named in those messages (third parties)',
    ]);
    const [visitors] = await chatMonitoringActivity('org1', deps({ settings: { chat_monitoring_surfaces: ['agent_public'] } }));
    assert.deepEqual(visitors.data_subjects, ['Website visitors who chat with an embedded agent', 'People named in those messages (third parties)']);
    const [direct] = await chatMonitoringActivity('org1', deps({ settings: { chat_monitoring_surfaces: ['direct'], chat_monitoring_signals: ['outcomes'] } }));
    assert.deepEqual(direct.data_subjects, ['Employees and members using: Direct chat', 'People named in those messages (third parties)']);
    assert.ok(!direct.data_categories.some(c => /kinds of personal data/.test(c)), 'no kinds line without the kinds signal');
    assert.ok(direct.data_categories.some(c => /small groups/.test(c)));
});

test('the legal basis follows the selection, for all three', async () => {
    const want = {
        art6_1_f: /^Art\. 6\(1\)\(f\) GDPR, legitimate interest/,
        art6_1_e: /^Art\. 6\(1\)\(e\) GDPR, public task$/,
        art6_1_c: /^Art\. 6\(1\)\(c\) GDPR, legal obligation \(Art\. 32\)$/,
    };
    for (const [basis, re] of Object.entries(want)) {
        const [a] = await chatMonitoringActivity('org1', deps({ settings: { chat_monitoring_legal_basis: basis } }));
        assert.match(a.legal_basis, re, basis);
    }
});

test('observed kinds are listed only with 10 or more people on an employee chat type, as labels without counts', async () => {
    const kinds = {
        direct: [{ value: 'email', protection: 'protected', turns: 3 }, { value: 'credential', protection: 'exposed', turns: 1 }],
        agent_public: [{ value: 'phone', protection: 'protected', turns: 40 }],
    };
    const [ten] = await chatMonitoringActivity('org1', deps({ kinds, contributors: 10 }));
    assert.deepEqual(ten.observed_kinds, ['E-mail addresses', 'Phone numbers', 'Secrets and passwords'], 'in the vocabulary\'s order');
    const nine = deps({ kinds, contributors: 9 });
    const [few] = await chatMonitoringActivity('org1', nine);
    assert.deepEqual(few.observed_kinds, ['Phone numbers'], 'employee kinds are hidden under 10 people; website visitors have no gate');
    assert.deepEqual(nine.kindReads, ['agent_public'], 'the kinds of a small employee group are not even read');
});

test('retention, DPIA and the fixed security measures', async () => {
    const [a] = await chatMonitoringActivity('org1', deps({ dpia: { approved_at: new Date('2026-09-01T00:00:00Z'), risk_level: 'low' } }));
    assert.match(a.retention, /^60 days\./);
    assert.ok(a.security_measures.includes('Kept 60 days'));
    assert.equal(a.dpia, 'internal record');
    assert.equal(a.dpia_link, 'admin/compliance/dpia');
    assert.deepEqual(a.transfers, []);
    assert.equal(a.ai_act, null);
    assert.deepEqual(a.source, { kind: 'chat_signals', id: 'chat_monitoring' });
    const [none] = await chatMonitoringActivity('org1', deps({ settings: { chat_monitoring_retention_days: null } }));
    assert.equal(none.dpia, 'none');
    assert.match(none.retention, /^90 days\./);
});

test('no ids, no counts and no "anonymous" anywhere in the entry', async () => {
    const [a] = await chatMonitoringActivity('org1', deps({ kinds: { agent_public: [{ value: 'email', protection: 'protected', turns: 37 }] } }));
    const json = JSON.stringify(a);
    assert.doesNotMatch(json, /anonym/i);
    assert.ok(!json.includes('user-secret-7'));
    assert.ok(!json.includes('intranet.example.org'));
    assert.ok(!json.includes('37'));
    assert.ok(!/"[a-z_]*_id":"(?!chat-compliance-signals)/.test(json));
});

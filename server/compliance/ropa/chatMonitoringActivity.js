'use strict';

/**
 * Chat signals as a processing activity (amendment 20).
 *
 * Present while chat signals are switched on (on or scheduled), and also
 * while collected counts remain after switching off: stored counts are still
 * processing until their retention ends or someone deletes them.
 *
 * Everything here describes the configuration the controller chose: the
 * legal basis, the chat types and so the people concerned, the retention.
 * The kinds of personal data observed come from the last 90 days of counts,
 * listed for an employee chat type only when at least 10 people used it in
 * that window, and never with a number. English only, like the rest of the
 * register builder.
 */

const V = require('../../stores/lib/chatMonitoringVocab');
const rules = require('../../stores/lib/chatMonitoringRules');
const sup = require('../../stores/lib/chatSignalSuppression');
const { KIND_LABEL } = require('./projectActivities');

const OBSERVED_DAYS = 90;
const SURFACE_LABEL = Object.freeze({ direct: 'Direct chat', agent: 'Agent chat' });
const LABELS = Object.freeze({
    ...KIND_LABEL,
    credential: 'Secrets and passwords',
    other: 'Other personal data (your own data types)',
});
const LEGAL_BASIS = Object.freeze({
    art6_1_f: 'Art. 6(1)(f) GDPR, legitimate interest: keeping personal data safe when people use AI in chat (network and information security, recital 49), balanced in the DPIA',
    art6_1_e: 'Art. 6(1)(e) GDPR, public task',
    art6_1_c: 'Art. 6(1)(c) GDPR, legal obligation (Art. 32)',
});
const DPIA_WORD = Object.freeze({ internal: 'internal record', external: 'external reference', none: 'none' });

function defaultDeps() {
    return {
        getSettings: (orgKey) => require('../../stores/complianceStore').getSettings(orgKey),
        getDpia: (orgKey) => require('../../stores/dpiaStore').getLatestForAgent(orgKey, V.CHAT_MONITORING_DPIA_KEY),
        hasRows: (orgKey) => require('../../stores/chatSignalStore').hasRows(orgKey),
        kindTotals: (orgKey, w) => require('../../stores/chatSignalStore').kindTotals(orgKey, w),
        contributorCount: (orgKey, surface, w) => require('../../stores/chatSignalStore').contributorCount(orgKey, surface, w),
        now: () => new Date(),
    };
}

/** Kind labels seen in the last 90 days, k-suppressed per employee chat type; no counts. */
async function observedKinds(orgKey, deps, now) {
    const to = sup.utcDay(now);
    const from = sup.addDays(to, -OBSERVED_DAYS);
    const seen = new Set();
    for (const surface of V.SURFACES) {
        if (V.isEmployeeSurface(surface)) {
            const n = await deps.contributorCount(orgKey, surface, { from, toExclusive: sup.addDays(to, 1) });
            if (!(Number(n) >= V.K.kinds)) continue;
        }
        const rows = await deps.kindTotals(orgKey, { from, to, surfaces: [surface] });
        for (const r of rows || []) if (V.KINDS.includes(r.value) && Number(r.turns) > 0) seen.add(r.value);
    }
    return V.KINDS.filter(k => seen.has(k)).map(k => LABELS[k] || k);
}

/**
 * @param {string} orgId
 * @returns {Promise<object[]>} [] or [activity]
 */
async function chatMonitoringActivity(orgId, deps = defaultDeps()) {
    const orgKey = orgId || 'default';
    const s = (await deps.getSettings(orgKey)) || {};
    const enabled = s.chat_monitoring_enabled === true;
    if (!enabled && !(await deps.hasRows(orgKey))) return [];

    const now = deps.now();
    const surfaces = (Array.isArray(s.chat_monitoring_surfaces) ? s.chat_monitoring_surfaces : []).filter(x => V.SURFACES.includes(x));
    const signals = (Array.isArray(s.chat_monitoring_signals) ? s.chat_monitoring_signals : []).filter(x => V.SIGNALS.includes(x));
    const days = rules.clampedRetention(s);
    const employee = surfaces.filter(x => V.isEmployeeSurface(x));

    const dataSubjects = [];
    if (employee.length) dataSubjects.push(`Employees and members using: ${employee.map(x => SURFACE_LABEL[x] || x).join(', ')}`);
    if (surfaces.includes('agent_public')) dataSubjects.push('Website visitors who chat with an embedded agent');
    if (!surfaces.length) dataSubjects.push('Employees, members and website visitors whose chat messages were counted before chat signals were switched off');
    dataSubjects.push('People named in those messages (third parties)');

    const dataCategories = ['Weekly counts per chat type (employees) and daily counts (website visitors) of how the Privacy Shield handled messages'];
    if (signals.includes('kinds')) dataCategories.push('Counts of the kinds of personal data found, without the values; health data is never counted');
    dataCategories.push('These counts can relate to identifiable people in small groups');

    let dpia = 'none';
    try { dpia = rules.dpiaStatus(s, await deps.getDpia(orgKey), now).kind; } catch { dpia = 'none'; }
    let observed = [];
    try { observed = await observedKinds(orgKey, deps, now); } catch { observed = []; }

    return [{
        activity_id: 'chat-compliance-signals',
        name: 'Chat signals: checking whether the Privacy Shield works',
        purpose: 'Checking whether the Privacy Shield works on chat messages (GDPR Art. 32(1)(d)) and keeping this register accurate (Art. 30(1)(c)). Never used to evaluate employees, their performance, absence or health.',
        processing: 'For each counted message, the outcome the Privacy Shield already decided (and, when switched on, the kinds of personal data it found) is turned into a counter inside the same request. The message is not stored for this.',
        data_categories: dataCategories,
        data_subjects: dataSubjects,
        recipients: 'The organisation’s compliance team (Compliance Center); administrators with database access.',
        transfers: [],
        retention: `${days} days. Whole weeks (days for website visitors) are deleted once all of them are older than ${days} days.`,
        legal_basis: LEGAL_BASIS[s.chat_monitoring_legal_basis] || 'Not recorded',
        security_measures: [
            'Derived in the request from the Privacy Shield’s own decision; message text is never stored for this',
            'No user, conversation, agent or message identifiers in the counts; an Art. 15 request cannot select them (Art. 11(2))',
            'Figures from fewer than 5 people (10 for kinds of data) are hidden; counts under 5 read "<5"',
            'Employee chats are stored per week, not per day',
            `Kept ${days} days`,
            'Every read of the figures is recorded in the access log',
            'People can object: "Don’t count my chat turns" in the chat; website visitors: "Don’t count my messages"',
        ],
        dpia: DPIA_WORD[dpia] || 'none',
        dpia_link: 'admin/compliance/dpia',
        observed_kinds: observed,
        ai_act: null,
        source: { kind: 'chat_signals', id: 'chat_monitoring' },
    }];
}

module.exports = { chatMonitoringActivity, LEGAL_BASIS, LABELS };

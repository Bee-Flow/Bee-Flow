'use strict';

/**
 * GDPR Art. 32(1)(d) — does the Privacy Shield cover chat messages?
 *
 * Reads only the chat signals totals (chat_signal_counts), after suppression:
 * per counted chat type, how many turns completed a Privacy Shield scan
 * before reaching the model, and whether found personal data was protected.
 * Never a per-person, per-agent or per-conversation figure.
 *
 *   not_applicable  chat signals are off; or no chat type can be judged yet:
 *                   an employee chat type needs a completed ISO week in the
 *                   window (amendment 8) and at least 5 distinct people, and
 *                   every chat type needs at least 25 turns
 *   warn            on a judged chat type, and only when the rule's own
 *                   numerator is at least 5 turns:
 *                     · 5% or more of turns went to an external (or unknown)
 *                       model without a completed scan (Art. 32(1)(b), Art. 25)
 *                     · 5% or more of turns were stopped by a failed scan
 *                     · of 10 or more turns with findings, 10% or more were
 *                       sent anyway (training: Art. 39(1)(b), AI Act Art. 4)
 *   pass            otherwise
 *
 * Evidence holds windows, bands and suppressed percentages only: never a raw
 * count below 5 and never kinds (amendment 10: compliance_evidence is
 * hash-chained and never purged). The counts are approximate (the recorder
 * can lose up to a minute on a crash), and the details say so.
 */

const V = require('../../../stores/lib/chatMonitoringVocab');
const sup = require('../../../stores/lib/chatSignalSuppression');

const WINDOW_DAYS = 30;
const LABEL = Object.freeze({ direct: 'Direct chat', agent: 'Agent chat', agent_public: 'Embedded agents' });
const NOT_COUNTED = 'Not counted: voice, template chat, the webpage builder, the public webpage AI bridge, App Studio AI chat, '
    + 'the Nextcloud Assistant, the learning coach, the component designer and the builders; agent chat without streaming '
    + 'and the support responder; notebook chat (not yet); the mobile app (not yet).';

function defaultDeps() {
    return {
        resolve: (orgKey) => require('../../../core/entitlements/chatMonitoringFlag').resolveChatMonitoring(orgKey),
        outcomeTotals: (orgKey, w) => require('../../../stores/chatSignalStore').outcomeTotals(orgKey, w),
        contributorCount: (orgKey, surface, w) => require('../../../stores/chatSignalStore').contributorCount(orgKey, surface, w),
        now: () => new Date(),
    };
}

const words = (v) => sup.cellWords(v);
const pctWords = (v) => (v === '<5' ? 'fewer than 5' : v === 'hidden' ? 'a hidden share' : v === null ? 'n/a' : `${v}%`);

/** Raw per-outcome totals of one surface, kept inside this module. */
function rawOf(rows) {
    const raw = Object.fromEntries(V.OUTCOMES.map(o => [o, 0]));
    let gap = 0;
    for (const r of rows) {
        if (!(r.value in raw)) continue;
        raw[r.value] += Number(r.turns) || 0;
        if ((r.value === 'unscanned' || r.value === 'scan_failed_open') && (r.destination === 'external' || r.destination === 'unknown')) {
            gap += Number(r.turns) || 0;
        }
    }
    const turns = V.OUTCOMES.reduce((a, o) => a + raw[o], 0);
    const found = raw.protected + raw.blocked + raw.sent_unprotected;
    return { raw, turns, found, gap };
}

/** The warning rules of one judged surface, on raw numbers; a rule fires only from 5 turns. */
function rulesFired({ raw, turns, found, gap }) {
    const fired = [];
    if (gap >= V.K.cell && gap / turns >= 0.05) fired.push('unscanned_external');
    if (raw.scan_failed_closed >= V.K.cell && raw.scan_failed_closed / turns >= 0.05) fired.push('failed_closed');
    if (found >= 10 && raw.sent_unprotected >= V.K.cell && raw.sent_unprotected / found >= 0.10) fired.push('sent_unprotected');
    return fired;
}

const RULE_TEXT = {
    unscanned_external: (s, f) => `${LABEL[s]}: ${pctWords(f.pct.unscanned_external)} of turns reached an external or unknown model without a completed Privacy Shield scan.`,
    failed_closed: (s, f) => `${LABEL[s]}: ${pctWords(f.pct.failed_closed)} of turns were stopped because the Privacy Shield scan failed.`,
    sent_unprotected: (s, f) => `${LABEL[s]}: of the turns where personal data was found, a large share was sent anyway (${pctWords(f.pct.sent_unprotected)} of all turns).`,
};

const EMPTY_PCT = Object.freeze({ scanned: null, protected_of_found: null, blocked: null, sent_unprotected: null, failed_open: null, failed_closed: null, unscanned_external: null });

module.exports = {
    id: 'GDPR-Art32-chat-shield-coverage',
    regulation: 'GDPR',
    article: '32',
    frameworks: [{ regulation: 'ISO27001', ref: 'A.8.12' }, { regulation: 'ISO27001', ref: 'A.8.16' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'chat_monitoring.checks.gdpr_art32_chat_cov.title',
    descriptionKey: 'chat_monitoring.checks.gdpr_art32_chat_cov.desc',
    remediationKey: 'chat_monitoring.checks.gdpr_art32_chat_cov.fix',
    remediationLink: 'admin/security/guardrails',

    async evaluate(orgId, _subject, deps = defaultDeps()) {
        const orgKey = orgId || 'default';
        const mon = await deps.resolve(orgKey);
        if (!mon || mon.state === 'off') {
            return { status: 'not_applicable', evidence: { chat_signals: 'off' }, details: 'Chat signals are off.' };
        }
        const today = deps.now();
        const surfaces = {};
        const judged = [];
        for (const surface of mon.surfaces || []) {
            if (!V.SURFACES.includes(surface)) continue;
            const employee = V.isEmployeeSurface(surface);
            const w = sup.windowFor(surface, { days: WINDOW_DAYS, effectiveFrom: mon.version, today });
            const entry = { applicable: false, reason: null, from: w ? w.from : null, to: w ? w.to : null, contributors: null, turns: null, pct: { ...EMPTY_PCT } };
            surfaces[surface] = entry;
            if (!w) { entry.reason = 'no_full_period'; continue; }
            const rows = await deps.outcomeTotals(orgKey, { from: w.from, to: w.to, surfaces: [surface], granularity: w.granularity });
            const contributors = employee ? await deps.contributorCount(orgKey, surface, { from: w.from, toExclusive: w.toExclusive }) : null;
            if (employee) entry.contributors = sup.contributorBand(contributors);
            if (employee && !(Number(contributors) >= V.K.outcomes)) { entry.reason = 'too_few_contributors'; continue; }
            const fig = sup.surfaceFigures({ outcomeRows: rows, contributors, surface, kindsActive: false });
            const totals = rawOf(rows);
            entry.turns = fig.turns;
            if (fig.pct) entry.pct = fig.pct;
            if (totals.turns < V.MIN_TURNS) { entry.reason = 'too_few_turns'; continue; }
            entry.applicable = true;
            judged.push({ surface, fig, totals, fired: rulesFired(totals) });
        }

        const evidence = {
            window: { granularity_employee: 'week', granularity_visitor: 'day', days: WINDOW_DAYS },
            min_turns: V.MIN_TURNS,
            min_contributors: V.K.outcomes,
            surfaces,
            findings: judged.flatMap(j => j.fired.map(rule => ({ surface: j.surface, rule }))),
        };
        if (!judged.length) {
            return {
                status: 'not_applicable',
                evidence,
                details: `Not enough completed weeks, people or turns to judge yet. ${NOT_COUNTED}`,
            };
        }
        const warnings = judged.flatMap(j => j.fired.map(rule => RULE_TEXT[rule](j.surface, j.fig)));
        if (warnings.length) {
            return { status: 'warn', evidence, details: `${warnings.join(' ')} Counts are approximate. ${NOT_COUNTED}` };
        }
        const sum = judged.reduce((a, j) => ({
            turns: a.turns + j.totals.turns,
            scanned: a.scanned + j.totals.turns - j.totals.raw.scan_failed_open - j.totals.raw.scan_failed_closed - j.totals.raw.unscanned,
            found: a.found + j.totals.found,
            protectedFound: a.protectedFound + j.totals.raw.protected + j.totals.raw.blocked,
        }), { turns: 0, scanned: 0, found: 0, protectedFound: 0 });
        // The summed shares obey the per-surface suppression: a share that is
        // hidden on one surface (a small cell could be worked out from it)
        // stays hidden in the total too.
        const hiddenOn = (key) => judged.some(j => j.fig.pct && j.fig.pct[key] === 'hidden');
        const scannedPct = hiddenOn('scanned') ? 'hidden' : sup.pct(sum.scanned, sum.turns);
        const protectedPct = hiddenOn('protected_of_found') ? 'hidden' : sup.pct(sum.protectedFound, sum.found);
        const protectedText = protectedPct === null ? 'no personal data was found' : `${pctWords(protectedPct)} of findings were protected before the model`;
        return {
            status: 'pass',
            evidence,
            details: `${words(sup.band(sum.turns))} turns on ${judged.length} chat type${judged.length === 1 ? '' : 's'} in ${WINDOW_DAYS} days; `
                + `${pctWords(scannedPct)} completed a Privacy Shield scan; ${protectedText}. Counts are approximate. ${NOT_COUNTED}`,
        };
    },

    _rulesFired: rulesFired,
    NOT_COUNTED,
};

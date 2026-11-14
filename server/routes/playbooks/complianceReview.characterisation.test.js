// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the compliance phase's review
 * (makeRunComplianceReview): per scenario the answer (or what it threw) and
 * every call it makes on its collaborators, in order, with what it handed
 * them: the playbook store, the datatable, automation and app stores, the
 * framework policy, the facts and the reviewer, and the save at the end.
 *
 * The scenarios reach each branch: a first run and a recheck, a phase that
 * is not ready, a refused tier, a playbook that changed elsewhere, a table
 * that is gone or cannot be read, automations of someone else or unreadable,
 * the app through the app phase or the access phase, each read of the app
 * failing on its own, frameworks with and without a name, the row sample
 * failing at each step, facts that cannot be enriched, and a save that
 * conflicts.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test routes/playbooks/complianceReview.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeRunComplianceReview } = require('./complianceReview');

const GOLDEN = path.join(__dirname, 'complianceReview.characterisation.golden.json');
const clone = (/** @type {unknown} */ v) => (v === undefined ? '<undefined>' : JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x === undefined ? '<undefined>' : x))));
/** @param {string} message @param {string} [code] */
const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});

const TABLE = { datatableId: 'tbl1', datatableScope: 'org:o1', datatableName: 'Orders', fields: [{ key: 'name' }, { key: '' }, { key: 'email' }], rowCount: 3, isMirror: 1 };
const AUTOMATION = (over = {}) => ({ userId: 'me', title: 'Send mail', description: 'Mails the customer', definition: { trigger: { kind: 'manual' }, steps: [{ type: 'integration_action', tool: 'gmail_compose' }, { type: 'set' }, null] }, ...over });
const APP = (over = {}) => ({ id: 'app1', userId: 'me', name: 'Order desk', isPublished: 1, sharedGroups: ['g1'], definition: { screens: [{}, {}] }, ...over });
const MODEL = { model: { roles: ['admin', 'viewer'], roleMapping: { default: 'viewer' }, tables: [{ access: { rowFilters: { viewer: 'own', sales: 'team' } } }, { access: {} }, null, { access: { rowFilters: { viewer: 'own' } } }] } };

const phasesOf = (status = 'ready', extra = {}) => [
    { key: 'table', kind: 'table', status: 'done', artifacts: { ...TABLE } },
    { key: 'auto1', kind: 'automation', status: 'done', artifacts: { automationId: 'a1' } },
    { key: 'auto2', kind: 'automation', status: 'done', artifacts: { automationId: 'a2' } },
    { key: 'fill', kind: 'fill', status: 'done', artifacts: { automationId: 'a1' } },
    { key: 'app', kind: 'app', status: 'done', artifacts: { appId: 'app1' } },
    { key: 'compliance', kind: 'compliance', status, ...extra },
    { key: 'done', kind: 'done', status: 'pending' },
];
const playbook = (over = {}) => ({ id: 'pb1', userId: 'me', organizationId: 'o1', version: 4, options: { locale: 'nl' }, phases: phasesOf(), ...over });

/**
 * The collaborators, each recording its call; `fx` says how each one answers.
 * @param {Record<string, any>} fx
 * @param {unknown[][]} calls
 */
function collaborators(fx, calls) {
    const rec = (/** @type {string} */ name, /** @type {(...a: any[]) => any} */ answer) => (/** @type {any[]} */ ...args) => {
        calls.push([name, ...clone(args.map((a) => (a && a.body ? '<req>' : a)))]);
        return answer(...args);
    };
    let clock = Date.parse('2026-10-01T10:00:00Z');
    let tableReads = 0;
    const d = {
        now: () => { clock += 1000; return clock; },
        playbookStore: { savePhases: rec('playbookStore.savePhases', async () => fx.savePhases ?? { ok: true, version: 5 }) },
        datatableStore: {
            getDatatable: rec('datatableStore.getDatatable', async () => {
                tableReads += 1;
                const answer = Array.isArray(fx.datatable) ? fx.datatable[tableReads - 1] : fx.datatable;
                if (answer instanceof Error) throw answer;
                return answer === undefined ? { rowCount: '12', lawfulBasis: 'contract', retentionDays: 365, retentionField: 'created', subjectColumn: 'email', rowScope: 'org' } : answer;
            }),
        },
        automationStore: {
            getAutomation: rec('automationStore.getAutomation', async (id) => {
                const answer = (fx.automations || { a1: AUTOMATION(), a2: AUTOMATION({ userId: 'someone else' }) })[id];
                if (answer instanceof Error) throw answer;
                return answer;
            }),
        },
        studioAppStore: {
            getStudioApp: rec('studioAppStore.getStudioApp', async () => { if (fx.app instanceof Error) throw fx.app; return fx.app === undefined ? APP() : fx.app; }),
            listPublicPages: rec('studioAppStore.listPublicPages', async () => { if (fx.publicPages instanceof Error) throw fx.publicPages; return fx.publicPages === undefined ? [{}, {}, {}] : fx.publicPages; }),
        },
        studioAppDataStore: {
            getDataModel: rec('studioAppDataStore.getDataModel', async () => { if (fx.model instanceof Error) throw fx.model; return fx.model === undefined ? MODEL : fx.model; }),
            listMembers: rec('studioAppDataStore.listMembers', async () => { if (fx.members instanceof Error) throw fx.members; return fx.members === undefined ? [{}, {}] : fx.members; }),
        },
        frameworkPolicy: {
            activeRegulations: rec('frameworkPolicy.activeRegulations', async () => { if (fx.frameworks instanceof Error) throw fx.frameworks; return new Set(fx.frameworks || ['GDPR', 'AI_ACT', 'NIS2', 'PLAIN']); }),
        },
        complianceFrameworks: fx.noFrameworkLookup ? {} : {
            byRegulation: (/** @type {string} */ code) => ({ GDPR: { name_key: 'fw.gdpr' }, AI_ACT: { name_key: 'fw.ai' }, NIS2: { name: 'no key' }, PLAIN: { name_key: 'fw.plain' } })[code] || null,
        },
        guiDefaults: fx.noGuiDefaults ? undefined : { 'fw.gdpr': 'General Data Protection Regulation', 'fw.plain': 'PLAIN' },
        datatableAccessPlan: { resolveDatatablePrincipalForUser: rec('datatableAccessPlan.resolvePrincipal', async () => { if (fx.principal instanceof Error) throw fx.principal; return { userId: 'me' }; }) },
        datatableRuntime: {
            resolveForPrincipal: rec('datatableRuntime.resolveForPrincipal', async () => { if (fx.resolved instanceof Error) throw fx.resolved; return { table: 'tbl1' }; }),
            readRows: rec('datatableRuntime.readRows', async () => { if (fx.rows instanceof Error) throw fx.rows; return fx.rows === undefined ? { rows: [{ name: 'A' }, { name: 'B' }] } : fx.rows; }),
        },
        enrichComplianceFacts: rec('enrichComplianceFacts', async () => { if (fx.enrichment instanceof Error) throw fx.enrichment; return { personalColumns: ['email'] }; }),
        gatherFacts: rec('gatherFacts', (facts) => ({ gathered: Object.keys(facts) })),
        runCompliancePhase: rec('runCompliancePhase', async () => { if (fx.review instanceof Error) throw fx.review; return { summary: 'Two findings.', artifacts: { findings: [{ id: 'f1' }, { id: 'f2' }], reviewedAt: 'now' } }; }),
    };
    const flow = {
        phaseTier: rec('phaseTier', async (_req, res) => { if (fx.tier === null) { res.status(403).json({ error: 'This tier is not on your list.', code: 'tier_not_allowed' }); return null; } return fx.tier || 'standard'; }),
        savePhaseOutcome: rec('savePhaseOutcome', async () => fx.saved ?? { ok: true, playbook: { id: 'pb1', version: 6 } }),
    };
    return { d, flow };
}

const awaiting = (artifacts) => playbook({ phases: phasesOf('awaiting', { summary: 'before', error: 'old', artifacts }) });
const withoutPhase = (/** @type {string[]} */ ...keys) => playbook({ phases: phasesOf().filter((p) => !keys.includes(p.key)) });

/** @type {Record<string, { fx?: Record<string, any>, pb?: Record<string, any>, body?: unknown, key?: string }>} */
const SCENARIOS = {
    'a first review of everything the playbook built': {},
    'a recheck keeps the phase where it is and notes what changed': { body: { recheck: true }, pb: awaiting({ findings: [{}, {}, {}], kept: true, rechecks: [1, 2, 3, 4, 5].map((n) => ({ at: `t${n}`, was: n, now: n })) }) },
    'a recheck of a phase without artifacts': { body: { recheck: 'yes' }, pb: awaiting(undefined) },
    'recheck asked while the phase is ready: an ordinary first run': { body: { recheck: true } },
    'the phase is awaiting and no recheck was asked': { pb: awaiting({}) },
    'the phase is done': { body: { recheck: true }, pb: playbook({ phases: phasesOf('done') }) },
    'the playbook has no such phase': { key: 'nope' },
    'no body at all': { body: null },
    'the tier is refused': { fx: { tier: null } },
    'the playbook changed elsewhere before the review': { fx: { savePhases: { ok: false, conflict: true, currentVersion: 9, playbook: { id: 'pb1', version: 9 } } } },
    'the playbook is gone before the review': { fx: { savePhases: { ok: false } } },
    'the playbook changed elsewhere before the save': { fx: { saved: { ok: false, currentVersion: 9, playbook: { id: 'pb1', version: 9 } } } },
    'the table was dropped': { fx: { datatable: fail('relation "dt_1" does not exist', '42P01') } },
    'the table cannot be read': { fx: { datatable: fail('connection reset') } },
    'the table row is gone': { fx: { datatable: null } },
    'the table has no row count': { fx: { datatable: { rowCount: 'many', lawfulBasis: 'consent' } } },
    'the second read of the table fails': { fx: { datatable: [{ rowCount: 7 }, fail('connection reset')] } },
    'no table was built': { pb: withoutPhase('table') },
    'a table phase without a table': { pb: playbook({ phases: phasesOf().map((p) => (p.key === 'table' ? { ...p, artifacts: undefined } : p)) }) },
    'a table without scope or fields': { pb: playbook({ phases: phasesOf().map((p) => (p.key === 'table' ? { ...p, artifacts: { datatableId: 'tbl2' } } : p)) }) },
    'an automation that cannot be read, one without a definition, one that is gone': { fx: { automations: { a1: fail('store down'), a2: AUTOMATION({ description: '', definition: null }) } }, pb: playbook({ phases: [...phasesOf().slice(0, 3), { key: 'auto3', kind: 'automation', status: 'done', artifacts: { automationId: 'a3' } }, { key: 'auto4', status: 'done', artifacts: {} }, ...phasesOf().slice(3)] }) },
    'an automation without steps or trigger': { fx: { automations: { a1: AUTOMATION({ definition: { steps: 'none' } }), a2: AUTOMATION({ definition: { trigger: {}, steps: [] } }) } } },
    'the app comes from the access phase': { pb: playbook({ phases: [...phasesOf().filter((p) => p.key !== 'app').slice(0, 4), { key: 'access', kind: 'access', status: 'done', artifacts: { appId: 'app9' } }, ...phasesOf().slice(5)] }) },
    'an app built in a later phase is not the one reviewed': { pb: playbook({ phases: [...phasesOf().filter((p) => p.key !== 'app'), { key: 'app', kind: 'app_turn', status: 'done', artifacts: { appId: 'app1' } }] }) },
    'no app was built': { pb: withoutPhase('app') },
    'the app is someone else\'s': { fx: { app: APP({ userId: 'someone else' }) } },
    'the app is gone': { fx: { app: null } },
    'the app cannot be read': { fx: { app: fail('store down') } },
    'a bare app: no groups, no screens, no model': { fx: { app: { userId: 'me', name: 'Bare' }, model: null, members: null, publicPages: 'none' } },
    'the app\'s public pages, model and members cannot be read': { fx: { publicPages: fail('store down'), model: fail('store down'), members: fail('store down') } },
    'a model without roles or tables': { fx: { model: { model: { roles: 'admin', roleMapping: {}, tables: 'none' } } } },
    'the active frameworks cannot be read': { fx: { frameworks: fail('policy store down') } },
    'frameworks without a lookup or names': { fx: { noFrameworkLookup: true, noGuiDefaults: true } },
    'frameworks with a lookup but no names': { fx: { noGuiDefaults: true } },
    'the principal cannot be resolved': { fx: { principal: fail('no principal') } },
    'the table cannot be opened for the owner': { fx: { resolved: fail('forbidden') } },
    'the rows cannot be read': { fx: { rows: fail('timeout') } },
    'the row sample is not a list': { fx: { rows: { rows: 'none' } } },
    'the row sample answers nothing': { fx: { rows: null } },
    'the facts cannot be enriched': { fx: { enrichment: fail('classifier down') } },
    'the reviewer fails': { fx: { review: fail('model unavailable') } },
    'a playbook without organisation or locale': { pb: playbook({ organizationId: undefined, options: undefined }) },
    'the fast tier': { fx: { tier: 'fast' } },
};

test('the compliance review: answer and collaborator calls per scenario (golden)', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [name, { fx = {}, pb = playbook(), body = {}, key = 'compliance' }] of Object.entries(SCENARIOS)) {
        /** @type {unknown[][]} */
        const calls = [];
        const { d, flow } = collaborators(fx, calls);
        /** @type {{ status?: number, body?: unknown }} */
        const answer = {};
        const res = { status(/** @type {number} */ code) { answer.status = code; return this; }, json(/** @type {unknown} */ b) { answer.body = b; return this; } };
        const before = JSON.stringify(pb);
        let threw = null;
        try { await makeRunComplianceReview({ d, flow })({ body }, res, pb, key); } catch (e) { threw = String(e); }
        actual[name] = clone({ answer, threw, calls, playbookUntouched: JSON.stringify(pb) === before });
    }
    // One scenario per line.
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, `{\n${Object.entries(actual).map(([name, seen]) => `${JSON.stringify(name)}: ${JSON.stringify(seen)}`).join(',\n')}\n}\n`);
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});

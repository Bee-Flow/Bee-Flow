/**
 * GDPR Art. 30(1)(d) — "the categories of recipients to whom the personal data
 * have been or will be disclosed", read off the routines that are actually
 * running.
 *
 * The playbook's compliance phase asks this of a routine the moment it is
 * built: does personal data leave, where does it go, and does anything stand
 * in front of it. That answer is a snapshot of a definition that was five
 * minutes old. This check asks the same question of what is LIVE today — a
 * routine somebody activated in March, whose table has since gained an e-mail
 * column and whose Privacy Shield step somebody removed.
 *
 * It is the same analyser, deliberately: `core/privacy/dataFlow.js`, which is
 * in core because `playbooks/` and `compliance/` are both features and neither
 * may require the other (ARCHITECTURE.md, layering.test.js). Everything about
 * WHICH step leaves the building, WHERE it goes and whether a shield precedes
 * it is answered there and nowhere else, so this check and the playbook review
 * cannot come to two different conclusions about the same routine. The same
 * goes for "which columns hold personal data": `core/privacy/personalColumns`
 * answers it, and asking it again here in different words is exactly the drift
 * that module was written to end.
 *
 * TWO READINGS, AND THE SECOND ONE IS WHY THIS CHECK EXISTS AT ALL.
 *
 *   - The DEFINITION says what can happen: a mail step downstream of a table
 *     that holds names, with no Privacy Shield in front of it.
 *   - The EGRESS LEDGER (`integration_activity_log`) says what did happen:
 *     which PII categories really left, through which tool, attributed to this
 *     routine. Nothing in a definition can be as strong as that, and nothing
 *     in the ledger can acquit a definition either — an empty ledger means the
 *     routine has not run, not that it is safe. So a silent ledger never turns
 *     `unguarded` into a pass, and a ledger that names categories turns it
 *     into a `fail`, because at that point it is not a risk, it is a record.
 *
 * Every category that arrives from that ledger goes through
 * `piiCategories.normalizeCategory` (via the analyser). This side of the
 * product has already shipped a private snake_case squash of the same ids once
 * and it meant eighteen of the twenty-one categories — telephone numbers,
 * IBANs, BSNs, medical data — silently matched nothing at all.
 *
 * AND IT REPORTS ITS OWN COVERAGE. A per-source check only produces rows for
 * the subjects it can see, and the score is computed from the rows a sweep
 * produced: a check that quietly skipped half the workspace used to hand the
 * Compliance Center a number computed over the other half, so the less anyone
 * had ever looked at, the greener the dashboard. `listCoverage()` (see the
 * COVERAGE section at the top of compliance/runner.js) hands the runner the
 * whole population of live routines and the part of it this check could not
 * open, by name.
 *
 * Reads only. What it finds is a check result, not a change.
 */

const dataFlow = require('../../../core/privacy/dataFlow');
const personalColumns = require('../../../core/privacy/personalColumns');

/** How far back the egress ledger is read. The same window Art. 44's check uses. */
const EGRESS_WINDOW_DAYS = 30;
/** Ledger groups per routine. A routine with more tools than this is not a routine. */
const EGRESS_GROUP_LIMIT = 200;

function defaultDeps() {
    return {
        getAll: (...a) => require('../../../db').getAll(...a),
        getTableMeta: (...a) => require('../../../stores/datatableStore').getTableMeta(...a),
    };
}

// WHAT "LIVE" MEANS — one definition, written twice on purpose.
//
// A routine is live when it is a routine (not a reusable Step, `kind='block'`),
// it is switched on, and it is not a draft. The SQL form and the JavaScript
// form below have to stay the same sentence: `listSubjects` asks the database
// which routines to judge and `listCoverage` asks it which routines exist to
// be judged, and a drift between them would put a routine in the population
// and outside the subject list, or the reverse — which is the shape of the
// bug coverage was added to prevent.
//
// The org filter is the one aiAct/signals.js and detectors/ already use:
// rows created before `organization_id` was stamped resolve through the owner,
// so a plain `a.organization_id = $1` loses every routine older than that
// column — and a check that loses routines reports a score about the ones it
// happened to keep.
const LIVE_SQL = "a.kind = 'automation' AND a.is_active = TRUE AND COALESCE(a.is_draft, FALSE) = FALSE";
const ORG_SQL = 'COALESCE(a.organization_id, u."organizationId") = $1';

/**
 * A routine's steps, in the ONE shape the analyser reads: `{ type, tool,
 * datatableId }` per step, and nothing else.
 *
 * An explicit ALLOW-LIST, not the raw step (BFSF-441). A step object is the
 * routine's own configuration — a recipient address, a subject line, a bound
 * template, a body — and everything that goes past this function ends up in a
 * compliance evidence record, which is the one artifact in this product
 * designed to be handed to an outsider. Three keys go through. A step field
 * somebody adds next year does not come along by default, which is the entire
 * difference between an allow-list and deleting the keys you thought of.
 *
 * → `[]` for a definition that cannot be read. The caller decides what that
 * means; here it means "not examined", never "examined and clean".
 */
function stepsOf(row) {
    let def = row && row.definition_json;
    if (typeof def === 'string') {
        try { def = JSON.parse(def); } catch { return []; }
    }
    const steps = def && Array.isArray(def.steps) ? def.steps : [];
    return steps.filter(Boolean).map((s) => ({
        type: s.type || null,
        tool: s.tool || null,
        datatableId: s.datatableId || null,
    }));
}

/** The JS half of LIVE_SQL's companion question: could this routine be read at all? */
const isReadable = (row) => stepsOf(row).length > 0;

/**
 * Every live routine of this org.
 *
 * This one does NOT swallow its errors when `listCoverage` calls it, and that
 * is the whole point of the flag. A short subject list is survivable — the
 * runner writes fewer verdicts. A short POPULATION is not: it would say "this
 * workspace has no live routines", i.e. "there is nothing we failed to look
 * at", which is the exact false reassurance coverage exists to prevent. A
 * database that cannot be read has to surface as unknown coverage, so the
 * error travels up to the runner.
 */
async function _liveRoutines(orgId, deps, { swallow = false } = {}) {
    const sql = `
        SELECT a.id, a.title, a.definition_json
          FROM automations a
          JOIN users u ON u.id = a.user_id
         WHERE ${ORG_SQL} AND ${LIVE_SQL}
         ORDER BY a.title ASC, a.id ASC`;
    if (!swallow) return (await deps.getAll(sql, [orgId])) || [];
    try { return (await deps.getAll(sql, [orgId])) || []; } catch { return []; }
}

/**
 * Which columns of the tables THIS routine touches hold personal data.
 *
 * → `null` when the routine names no table we can read. Null is not `[]`: a
 * routine that reads its personal data out of a mailbox rather than a Studio
 * table is a routine we cannot answer for, and saying "no personal data" about
 * it would be the same lie as a value scan reporting a column clean because it
 * could not open it. The NAMES answer here rather than the values — a sweep
 * runs over every routine of every organisation and cannot hand a hundred
 * tables' contents to the PII guard — and `personalColumns` says so in every
 * entry it returns (`by: 'names'`, `confidence: 'name_only'`).
 */
async function _personalFor(orgId, steps, deps) {
    const ids = [...new Set(steps.map((s) => s.datatableId).filter(Boolean))];
    if (!ids.length) return null;
    let rows = [];
    try {
        rows = (await deps.getAll(
            'SELECT id, name, scope_kind, scope_id FROM datatables WHERE organization_id = $1 AND id = ANY($2::text[])',
            [orgId, ids],
        )) || [];
    } catch { return null; }
    if (!rows.length) return null;
    const columns = [];
    let read = 0;
    for (const r of rows) {
        let fields = [];
        try {
            const meta = await deps.getTableMeta({ kind: r.scope_kind, id: r.scope_id }, r.id);
            fields = (meta && meta.fields) || [];
        } catch { continue; }
        read += 1;
        for (const c of personalColumns.byName(fields)) columns.push({ ...c, datatableId: r.id });
    }
    // Not one table could be opened: that is "nobody looked", not "nothing
    // personal is in play".
    return read ? columns : null;
}

/**
 * What really left this routine in the last 30 days, per tool.
 *
 * → `null` when the ledger cannot be read at all (absent on a fresh install),
 * which is deliberately different from a ledger that was read and holds
 * nothing. Dry runs are excluded: a simulated send moved no data.
 */
async function _egressFor(orgId, automationId, deps) {
    try {
        const rows = await deps.getAll(`
            SELECT tool_name, pii_categories_detected, COUNT(*)::int AS calls
              FROM integration_activity_log
             WHERE organization_id = $1
               AND automation_id = $2
               AND timestamp >= NOW() - INTERVAL '${EGRESS_WINDOW_DAYS} days'
               AND COALESCE(is_dry_run, FALSE) = FALSE
             GROUP BY tool_name, pii_categories_detected
             LIMIT ${EGRESS_GROUP_LIMIT}
        `, [orgId, String(automationId)]);
        return dataFlow.observedEgress(rows || []);
    } catch {
        return null;
    }
}

/**
 * The one verdict for one live routine. Pure, given the flow — so the ladder
 * can be read and tested without a database anywhere near it.
 *
 * The order of the rungs is the order they matter in: a record beats a risk,
 * a risk beats a gap in what we know, and "we could not tell" is never a pass.
 */
function verdict(name, flow) {
    const record = dataFlow.flowRecord(flow);
    const where = flow.destinations.length ? flow.destinations.join(', ') : 'outside the workspace';
    const observed = flow.observed;

    if (flow.verdict === dataFlow.VERDICTS.confirmed) {
        const kinds = observed.kinds.join(', ');
        return {
            status: 'fail',
            evidence: record,
            details: `"${name}" has sent personal data (${kinds}) to ${where} in the last ${EGRESS_WINDOW_DAYS} days, with no Privacy Shield step in front of the step that sent it. This is the egress log, not a reading of the definition.`,
        };
    }
    if (flow.verdict === dataFlow.VERDICTS.unguarded) {
        return {
            status: 'warn',
            evidence: record,
            details: `"${name}" can send ${flow.carries.join(', ')} to ${where}, and no Privacy Shield step stands in front of the ${flow.unguardedExits.length} step(s) that send. Add a Guard or Tokenize step before them, or record the recipient in the processing register.`,
        };
    }
    if (flow.verdict === dataFlow.VERDICTS.unknown) {
        // The ledger can answer what the definition could not: a routine that
        // has really been sending, with the PII scan reporting nothing
        // personal in any of it, has been observed rather than guessed at.
        if (observed && observed.tools.length && !observed.kinds.length) {
            return {
                status: 'pass',
                evidence: record,
                details: `Nothing this check can read says what "${name}" handles, but the egress log records ${record.observed_calls} call(s) to ${where} in the last ${EGRESS_WINDOW_DAYS} days and no personal data in any of them.`,
            };
        }
        if (!flow.readable) {
            return { status: 'warn', evidence: record, details: `"${name}" is switched on, and its steps could not be read — so nothing here has judged where its data goes.` };
        }
        return {
            status: 'warn',
            evidence: record,
            details: `"${name}" sends data to ${where}, and nothing this check can read says whether personal data is among it: it names no Studio table whose columns could be opened, and the egress log has nothing for it. That is a gap in what is known, not a clean bill.`,
        };
    }
    if (flow.verdict === dataFlow.VERDICTS.contained) {
        return { status: 'pass', evidence: record, details: `Nothing in "${name}" leaves the workspace.` };
    }
    if (flow.verdict === dataFlow.VERDICTS.no_personal_data) {
        return { status: 'pass', evidence: record, details: `"${name}" sends data to ${where}, and none of the columns it reads holds personal data.` };
    }
    return {
        status: 'pass',
        evidence: record,
        details: `"${name}" sends ${flow.carries.join(', ')} to ${where}, and a Privacy Shield step stands in front of every step that sends.`,
    };
}

/**
 * The population this check judges, and the part of it it never opened.
 *
 * `unexamined` is the live routines whose steps could not be read — an
 * unparseable definition, an empty one, a row written by an import that never
 * finished. They are not accused of anything; the claim is about US. These are
 * the routines that ran all month with nothing in this product looking at
 * where their data went, so nothing above judged them and neither does the
 * score.
 */
async function listCoverage(orgId, deps = defaultDeps()) {
    const rows = await _liveRoutines(orgId, deps);
    const unexamined = rows.filter((r) => !isReadable(r));
    return {
        kind: 'automation',
        label: 'live routines',
        total: rows.length,
        examined: rows.length - unexamined.length,
        unexamined: unexamined.map((r) => ({ id: r.id, label: r.title || r.id })),
        link: 'admin/compliance/ropa',
        // The runner writes the row; what "examined" means here and where to
        // go about it are this check's words, since it is the only module that
        // knows a routine from a supplier contract.
        examined_as: 'read for where its data goes',
        next_step: 'Open each one in the Builder and check its steps — a routine whose definition cannot be read is one nothing can judge.',
    };
}

module.exports = {
    id: 'GDPR-Art30-personal-data-flows',
    regulation: 'GDPR',
    article: '30(1)(d)',
    severity: 'medium',
    scope: 'per-source',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art30_flows.title',
    descriptionKey: 'compliance.checks.gdpr_art30_flows.desc',
    remediationKey: 'compliance.checks.gdpr_art30_flows.fix',
    remediationLink: 'admin/compliance/ropa',

    async listSubjects(orgId, deps = defaultDeps()) {
        // Swallows: a subject list that came up short costs verdicts, and
        // `listCoverage` is what refuses to let that pass for completeness.
        const rows = await _liveRoutines(orgId, deps, { swallow: true });
        return rows.filter(isReadable).map((r) => ({ id: `automation:${r.id}`, label: r.title || r.id }));
    },

    async evaluate(orgId, subject, deps = defaultDeps()) {
        if (!subject || !subject.id) {
            return { status: 'not_applicable', evidence: {}, details: 'No live routine to examine.' };
        }
        const id = String(subject.id).replace(/^automation:/, '');
        const rows = await _liveRoutines(orgId, deps, { swallow: true });
        const row = rows.find((r) => String(r.id) === id);
        if (!row) {
            return { status: 'not_applicable', evidence: { automation_id: id }, details: 'That routine is no longer switched on.' };
        }
        const steps = stepsOf(row);
        const personal = await _personalFor(orgId, steps, deps);
        const observed = await _egressFor(orgId, id, deps);
        const flow = dataFlow.mergeObserved(dataFlow.analyseFlow({ steps, personal }), observed);
        return verdict(row.title || row.id, flow);
    },

    // Optional contract (compliance/runner.js): a check that can name its own
    // population declares it here, and the runner turns the gap into a row of
    // its own — so a live routine nothing could read is visible in the Center
    // instead of being silently absent from the score.
    listCoverage,

    // Exported for the tests: the ladder is the whole of the judgement.
    _verdict: verdict,
    _liveRoutines,
    _personalFor,
    _egressFor,
    stepsOf,
    isReadable,
    LIVE_SQL,
    EGRESS_WINDOW_DAYS,
};

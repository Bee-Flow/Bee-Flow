/**
 * GDPR Art. 30(1)(d) — "the categories of recipients to whom the personal data
 * have been or will be disclosed", read off the automations that are actually
 * running.
 *
 * The playbook's compliance phase asks this of an automation the moment it is
 * built: does personal data leave, where does it go, and does anything stand
 * in front of it. That answer is a snapshot of a definition that was five
 * minutes old. This check asks the same question of what is LIVE today — a
 * automation somebody activated in March, whose table has since gained an e-mail
 * column and whose Privacy Shield step somebody removed.
 *
 * It is the same analyser, deliberately: `core/privacy/dataFlow.js`, which is
 * in core because `playbooks/` and `compliance/` are both features and neither
 * may require the other (ARCHITECTURE.md, layering.test.js). Everything about
 * WHICH step leaves the building, WHERE it goes and whether a shield precedes
 * it is answered there and nowhere else, so this check and the playbook review
 * cannot come to two different conclusions about the same automation. The same
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
 *     automation. Nothing in a definition can be as strong as that, and nothing
 *     in the ledger can acquit a definition either — an empty ledger means the
 *     automation has not run, not that it is safe. So a silent ledger never turns
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
 * whole population of live automations and the part of it this check could not
 * open, by name.
 *
 * Reads only. What it finds is a check result, not a change.
 */

const dataFlow = require('../../../core/privacy/dataFlow');
const personalColumns = require('../../../core/privacy/personalColumns');
const { LEDGER_ORG_SQL } = require('../../lib/observedOperators');

/** How far back the egress ledger is read. The same window Art. 44's check uses. */
const EGRESS_WINDOW_DAYS = 30;
/** Ledger groups per automation. An automation with more tools than this is not an automation. */
const EGRESS_GROUP_LIMIT = 200;

function defaultDeps() {
    return {
        getAll: (...a) => require('../../../db').getAll(...a),
        getTableMeta: (...a) => require('../../../stores/datatableStore').getTableMeta(...a),
    };
}

// WHAT "LIVE" MEANS — one definition, written twice on purpose.
//
// An automation is live when it is an automation (not a reusable Step, `kind='block'`),
// it is switched on, and it is not a draft. The SQL form and the JavaScript
// form below have to stay the same sentence: `listSubjects` asks the database
// which automations to judge and `listCoverage` asks it which automations exist to
// be judged, and a drift between them would put an automation in the population
// and outside the subject list, or the reverse — which is the shape of the
// bug coverage was added to prevent.
//
// The org filter is the one aiAct/signals.js and detectors/ already use:
// rows created before `organization_id` was stamped resolve through the owner,
// so a plain `a.organization_id = $1` loses every automation older than that
// column — and a check that loses automations reports a score about the ones it
// happened to keep.
const LIVE_SQL = "a.kind = 'automation' AND a.is_active = TRUE AND COALESCE(a.is_draft, FALSE) = FALSE";
const ORG_SQL = 'COALESCE(a.organization_id, u."organizationId") = $1';

/**
 * An automation's steps, in the ONE shape the analyser reads: `{ type, tool,
 * datatableId }` per step, and nothing else.
 *
 * An explicit ALLOW-LIST, not the raw step (BFSF-441). A step object is the
 * automation's own configuration — a recipient address, a subject line, a bound
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

/** The JS half of LIVE_SQL's companion question: could this automation be read at all? */
const isReadable = (row) => stepsOf(row).length > 0;

/**
 * Every live automation of this org.
 *
 * This one does NOT swallow its errors, for any caller. A short POPULATION
 * would say "this workspace has no live automations", i.e. "there is nothing
 * we failed to look at", which is the exact false reassurance coverage exists
 * to prevent. A short SUBJECT LIST is no better since the check retires
 * vanished subjects (`retiresVanished`): read as the whole population, an
 * empty list would retire every automation's slot on one failed read. So the
 * error travels up — to the runner, which records the listing as incomplete,
 * or to `evaluate`, which says it could not judge this run.
 */
async function _liveAutomations(orgId, deps) {
    const sql = `
        SELECT a.id, a.title, a.definition_json
          FROM automations a
          JOIN users u ON u.id = a.user_id
         WHERE ${ORG_SQL} AND ${LIVE_SQL}
         ORDER BY a.title ASC, a.id ASC`;
    return (await deps.getAll(sql, [orgId])) || [];
}

/**
 * Which columns of the tables THIS automation touches hold personal data.
 *
 * → `null` when the automation names no table we can read. Null is not `[]`: a
 * automation that reads its personal data out of a mailbox rather than a Studio
 * table is an automation we cannot answer for, and saying "no personal data" about
 * it would be the same lie as a value scan reporting a column clean because it
 * could not open it. The NAMES answer here rather than the values — a sweep
 * runs over every automation of every organisation and cannot hand a hundred
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
 * What really left this automation in the last 30 days, per tool.
 *
 * → `null` when the ledger cannot be read at all (absent on a fresh install),
 * which is deliberately different from a ledger that was read and holds
 * nothing. Dry runs are excluded: a simulated send moved no data.
 */
async function _egressFor(orgId, automationId, deps) {
    try {
        const rows = await deps.getAll(`
            SELECT tool_name, pii_categories_detected, COUNT(*)::int AS calls,
                   COALESCE(pii_scan_enabled, FALSE) AS scanned
              FROM integration_activity_log
             WHERE ${LEDGER_ORG_SQL}
               AND automation_id = $2
               AND timestamp >= NOW() - INTERVAL '${EGRESS_WINDOW_DAYS} days'
               AND COALESCE(is_dry_run, FALSE) = FALSE
             GROUP BY tool_name, pii_categories_detected, COALESCE(pii_scan_enabled, FALSE)
             LIMIT ${EGRESS_GROUP_LIMIT}
        `, [orgId, String(automationId)]);
        return dataFlow.observedEgress(rows || []);
    } catch {
        return null;
    }
}

/**
 * The one verdict for one live automation. Pure, given the flow — so the ladder
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
        // The ledger can answer what the definition could not: an automation that
        // has really been sending, with the PII scan reporting nothing
        // personal in any of it, has been observed rather than guessed at.
        // EVERY exit has to have been seen, each through its own tool: the rows
        // of a tool that only reads acquit nothing, and an exit with no tool
        // (an HTTP request, a code step) never reaches the ledger at all. And
        // every call has to have been scanned — an empty category column
        // written while the scan was off says nobody looked.
        const exitsSeenClean = flow.exits.length > 0
            && flow.exits.every((e) => e.observedCalls > 0 && !(e.observedKinds || []).length);
        if (observed && exitsSeenClean && !observed.unscanned_calls) {
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
 * `unexamined` is the live automations whose steps could not be read — an
 * unparseable definition, an empty one, a row written by an import that never
 * finished. They are not accused of anything; the claim is about US. These are
 * the automations that ran all month with nothing in this product looking at
 * where their data went, so nothing above judged them and neither does the
 * score.
 */
async function listCoverage(orgId, deps = defaultDeps()) {
    const rows = await _liveAutomations(orgId, deps);
    const unexamined = rows.filter((r) => !isReadable(r));
    return {
        kind: 'automation',
        label: 'live automations',
        total: rows.length,
        examined: rows.length - unexamined.length,
        unexamined: unexamined.map((r) => ({ id: r.id, label: r.title || r.id })),
        link: 'admin/compliance/ropa',
        // The runner writes the row; what "examined" means here and where to
        // go about it are this check's words, since it is the only module that
        // knows an automation from a supplier contract.
        examined_as: 'read for where its data goes',
        next_step: 'Open each one in the Builder and check its steps — an automation whose definition cannot be read is one nothing can judge.',
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

    // The subject list is the WHOLE live, readable population (no LIMIT), so
    // the runner may retire the slot of an automation that left it — switched
    // off, made a draft, deleted, or no longer readable (which the coverage
    // row still names). Otherwise its last warning stayed in the score for good.
    retiresVanished: true,
    retiredDetails: 'This automation is no longer live (switched off, made a draft or deleted), or its steps can no longer be read — see the coverage row.',

    async listSubjects(orgId, deps = defaultDeps()) {
        // Does not swallow: a failed read must reach the runner as an
        // incomplete listing, never as "no automations", which would retire
        // every slot (see `retiresVanished`).
        const rows = await _liveAutomations(orgId, deps);
        return rows.filter(isReadable).map((r) => ({ id: `automation:${r.id}`, label: r.title || r.id }));
    },

    async evaluate(orgId, subject, deps = defaultDeps()) {
        if (!subject || !subject.id) {
            return { status: 'not_applicable', evidence: {}, details: 'No live automation to examine.' };
        }
        const id = String(subject.id).replace(/^automation:/, '');
        // A failed read is not "no longer switched on": that answer is
        // not_applicable and drops the automation out of the score. Only the
        // SQLSTATE travels — a raw error message can carry query text.
        let rows;
        try {
            rows = await _liveAutomations(orgId, deps);
        } catch (e) {
            return {
                status: 'warn',
                evidence: { automation_id: id, error: 'automations_unreadable', sqlstate: e?.code || null },
                details: 'The live automations could not be read, so this automation was not judged this run.',
            };
        }
        const row = rows.find((r) => String(r.id) === id);
        if (!row) {
            return { status: 'not_applicable', evidence: { automation_id: id }, details: 'That automation is no longer switched on.' };
        }
        const steps = stepsOf(row);
        const personal = await _personalFor(orgId, steps, deps);
        const observed = await _egressFor(orgId, id, deps);
        const flow = dataFlow.mergeObserved(dataFlow.analyseFlow({ steps, personal }), observed);
        return verdict(row.title || row.id, flow);
    },

    // Optional contract (compliance/runner.js): a check that can name its own
    // population declares it here, and the runner turns the gap into a row of
    // its own — so a live automation nothing could read is visible in the Center
    // instead of being silently absent from the score.
    listCoverage,

    // Exported for the tests: the ladder is the whole of the judgement.
    _verdict: verdict,
    _liveAutomations,
    _personalFor,
    _egressFor,
    stepsOf,
    isReadable,
    LIVE_SQL,
    EGRESS_WINDOW_DAYS,
};

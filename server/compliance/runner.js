/**
 * Compliance Runner — executes checks and persists their results.
 *
 * Check contract (see registry.js for full docs):
 *   - `scope: 'global' | 'per-source'`
 *     Per-source checks must also export `listSubjects(orgId) -> [{ id, label }]`.
 *     The runner invokes evaluate() once per subject, persisting one row each.
 *   - OPTIONAL: `listCoverage(orgId) -> { kind, label, total, examined,
 *     unexamined: [{ id, label }], link, examined_as, next_step }` — see
 *     COVERAGE below. `examined_as` and `next_step` let the check supply the
 *     words for its own domain ("recorded in the processing register"), since
 *     the runner has no business knowing what a Studio table is.
 *   - Every result row is paired with an immutable evidence record
 *     (compliance_evidence) containing a SHA-256 hash of the payload. This is
 *     what makes the system defensible under GDPR Art. 5(2) accountability.
 *
 * Frameworks are a growing, per-org set (frameworks.js + frameworkPolicy.js).
 * A check RUNS only when its home regulation is active for the org — enabled
 * and licensed. A disabled or locked framework's checks are neither evaluated
 * nor persisted (PLAN.md §1.4): no `not_applicable` filler rows, no evidence,
 * no score. Rows of a framework that was later disabled stay in history and
 * are filtered at read time.
 *
 * One hanging evaluate() used to block the whole org sweep (and every org
 * after it — the scheduler runs orgs sequentially). Every evaluate() now races
 * a wall clock: past CHECK_TIMEOUT_MS the check is recorded as `fail` with the
 * timeout in its details, and the sweep moves on.
 *
 * COVERAGE — why a score is never allowed to stand alone (2026-09-21).
 *
 * The score is computed from the rows a sweep produced, and a per-source check
 * only produces rows for the subjects it can see. `GDPR-Art30-datatable-
 * registrations` sees the Studio tables someone recorded a legal basis or a
 * retention period for; a table nobody ever touched is not a subject, so it
 * produced no row, so it was in no denominator. When an organisation had
 * registered NOTHING the check wrote a single `not_applicable` filler, which
 * computeScore excludes outright, and the Compliance Center showed that
 * organisation the score of the checks that happened to run — often 100. The
 * arithmetic ran backwards: the less of a workspace anyone had ever looked at,
 * the greener its dashboard, and the greenest dashboard of all belonged to the
 * organisation with the most personal data sitting outside every record. A
 * compliance product saying "you are fine" about data it never opened is the
 * worst thing this code can do, so it is now structurally prevented.
 *
 * A check that can enumerate its own population says so with `listCoverage()`.
 * The runner then writes ONE extra row per such check, `scope_type` 'coverage'
 * and `scope_id` 'coverage' (constant, so each run replaces the last rather
 * than piling stale coverage claims up in getLatestPerCheck):
 *
 *   nothing exists to examine        → not_applicable
 *   everything examined              → pass
 *   some of it never examined        → warn  (named in the details)
 *   NOTHING examined, but things are
 *   there to examine                 → fail  (the verdicts above are about
 *                                             nothing at all)
 *   the population could not be read → warn  ("coverage unknown" — never a
 *                                             silent zero, see _allTables)
 *
 * That row is an ordinary result row: it carries the check's own severity, it
 * counts for the same frameworks, and it lands in the score. And because the
 * unexamined things are NAMED in its details and its evidence, the existing
 * check table and drawer show which tables they are, so the next click is the
 * RoPA page rather than a shrug. The per-run summary (examined / not examined
 * / which populations are unknown) rides on the score snapshot as `coverage`,
 * so the trend line records how much of the workspace each number covered.
 *
 * ONE CONSTRAINT ON WHERE listCoverage() MAY GO, until routes/compliance/
 * checks.js is taught about the slot: that route renders every latest row of a
 * PER-SOURCE check but only `matches[0]` of a GLOBAL one, and 'coverage' sorts
 * before 'global', so a global check with a listCoverage() would have its own
 * verdict hidden behind its coverage row in the check table. Per-source checks
 * are unaffected and are where this belongs anyway — a check that can list a
 * population has subjects by definition.
 */

const crypto = require('crypto');
const registry = require('./registry');
const frameworks = require('./frameworks');
const frameworkPolicy = require('./frameworkPolicy');
const complianceStore = require('../stores/complianceStore');
const { computeScore, scoresByFramework, scoreNumbers, SNAPSHOT_COLUMN } = require('./score');
const log = require('../telemetry/log');

// Wall-clock budget per evaluate(). Env override exists for tests and for a
// self-hosted box whose telemetry probes are slow — not a tuning knob.
const CHECK_TIMEOUT_MS = parseInt(process.env.COMPLIANCE_CHECK_TIMEOUT_MS || '30000', 10);
const DEBUG = process.env.COMPLIANCE_RUNNER_DEBUG === '1';

// The coverage row's slot. Constant per check so a new run overwrites the
// previous coverage claim instead of adding a second one beside it — and
// distinct from the `null` a global (or subject-less per-source) row uses, so
// the two never collide in getLatestPerCheck or in the client's row key.
const COVERAGE_SCOPE = 'coverage';
// How many of the unexamined things to name in the sentence a human reads,
// and how many to keep in the evidence row behind it. The count is always
// exact; only the naming is capped, because a details line with 400 table
// names in it is one nobody reads.
const COVERAGE_NAMES_IN_DETAILS = 5;
const COVERAGE_NAMES_IN_EVIDENCE = 50;

class FrameworkDisabledError extends Error {
    constructor(checkId, regulation) {
        super(`Check ${checkId} belongs to ${regulation}, which is not active for this organisation`);
        this.name = 'FrameworkDisabledError';
        this.code = 'framework_disabled';
        this.status = 409;
        this.regulation = regulation;
        this.body = { error: 'framework_disabled', check_id: checkId, regulation, framework: frameworks.frameworkIdOf(regulation) };
    }
}

function _hashPayload(payload) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(payload || {}))
        .digest('hex');
}

function _humanTimeout(ms) {
    return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * Persist one result row + its evidence link. `scope` overrides the slot the
 * row occupies; without it the slot is derived from the subject, which is what
 * every check verdict does. The coverage row passes its own slot so it sits
 * beside the check's verdicts instead of overwriting one of them.
 */
async function _persistResult(check, orgId, result, runType, subject, scope = null) {
    const scopeType = scope?.type || (subject ? 'per-source' : 'global');
    const scopeId = scope ? (scope.id ?? null) : (subject?.id || null);
    await complianceStore.recordCheckResult({
        organization_id: orgId,
        check_id: check.id,
        regulation: check.regulation,
        article: check.article,
        severity: check.severity,
        status: result.status,
        evidence: result.evidence,
        details: result.details,
        scope_type: scopeType,
        scope_id: scopeId,
        run_type: runType,
    });
    // Immutable audit row — Art. 5(2) accountability. The store chains it
    // (evidence/chain.js) and returns { id, seq, hash }; the runner only
    // supplies the payload and its own hash of it.
    const payload = {
        status: result.status,
        evidence: result.evidence,
        details: result.details,
        run_type: runType,
        subject: subject || null,
    };
    await complianceStore.addEvidence({
        organization_id: orgId,
        check_id: check.id,
        subject_type: scopeType,
        subject_id: scopeId,
        hash: _hashPayload(payload),
        payload,
    });
}

/**
 * evaluate() under a wall clock. The timer is cleared as soon as the race
 * settles, so a finished check leaves nothing behind (deliberately not
 * unref'd: an unref'd timer lets the event loop drain mid-race). A check that
 * finishes after the deadline has its result dropped — the fail row is
 * already written.
 */
function _withTimeout(promise, ms, label) {
    let timer = null;
    const clock = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const e = new Error(`${label} timed out after ${_humanTimeout(ms)}`);
            e.code = 'check_timeout';
            reject(e);
        }, ms);
    });
    return Promise.race([promise, clock]).finally(() => { if (timer) clearTimeout(timer); });
}

async function _runSafe(check, orgId, subject) {
    const started = Date.now();
    try {
        const r = await _withTimeout(
            Promise.resolve().then(() => check.evaluate(orgId, subject || null)),
            CHECK_TIMEOUT_MS,
            'check',
        );
        if (DEBUG) log.debug(`[ComplianceRunner] ${check.id}${subject ? `#${subject.id}` : ''} ${r?.status || 'not_applicable'} in ${Date.now() - started} ms`);
        return {
            status: r?.status || 'not_applicable',
            evidence: r?.evidence || {},
            details: r?.details || null,
        };
    } catch (e) {
        const ms = Date.now() - started;
        if (e?.code === 'check_timeout') {
            log.warn(`[ComplianceRunner] ${check.id} timed out after ${ms} ms`);
            return {
                status: 'fail',
                evidence: { error: 'timeout', timeout_ms: CHECK_TIMEOUT_MS, elapsed_ms: ms },
                details: e.message,
            };
        }
        log.error(`[ComplianceRunner] ${check.id} threw:`, e.message);
        return {
            status: 'fail',
            evidence: { error: e.message },
            details: `Check raised an exception: ${e.message}`,
        };
    }
}

/**
 * Turn a check's coverage report into the row a human reads.
 *
 * The wording is deliberately about US, not about the things listed. A Studio
 * table nobody registered is not thereby unlawful — it may hold no personal
 * data at all — so this never says "breach". What it says is that the verdicts
 * above did not look at it, which is a fact about the completeness of the
 * score and is exactly what an admin needs to know before reading the number
 * as an answer. The names are in the sentence so the next click is obvious.
 */
function _coverageVerdict(check, report) {
    const label = (report.label || report.kind || 'items').toLowerCase();
    // What "examined" MEANS here is the check's word, not the runner's — this
    // module has no business knowing what a Studio table or a register is.
    const examinedAs = report.examined_as || 'examined';
    const nextStep = report.next_step ? ` ${report.next_step}` : '';
    const all = Array.isArray(report.unexamined) ? report.unexamined : [];
    const total = Number(report.total) || 0;
    const examined = Number(report.examined) || 0;
    const missing = all.length;
    const evidence = {
        kind: report.kind || null,
        label: report.label || null,
        total,
        examined,
        unexamined_count: missing,
        unexamined: all.slice(0, COVERAGE_NAMES_IN_EVIDENCE).map(u => ({ id: u.id ?? null, label: u.label ?? String(u.id ?? '') })),
        unexamined_truncated: missing > COVERAGE_NAMES_IN_EVIDENCE,
        link: report.link || check.remediationLink || null,
    };

    if (total === 0) {
        return { status: 'not_applicable', evidence, details: `This organisation has no ${label}, so there is nothing outside what this check examined.` };
    }
    if (missing === 0) {
        return { status: 'pass', evidence, details: `All ${total} of this organisation's ${label} were ${examinedAs}, so the verdicts above cover every one of them.` };
    }
    const named = all.slice(0, COVERAGE_NAMES_IN_DETAILS).map(u => `"${u.label ?? u.id}"`).join(', ');
    const andMore = missing > COVERAGE_NAMES_IN_DETAILS ? `, and ${missing - COVERAGE_NAMES_IN_DETAILS} more` : '';
    if (examined === 0) {
        return {
            status: 'fail',
            evidence,
            details: `None of this organisation's ${total} ${label} has ever been ${examinedAs}, so this check examined nothing at all and the score says nothing about them: ${named}${andMore}.${nextStep}`,
        };
    }
    return {
        status: 'warn',
        evidence,
        details: `${missing} of this organisation's ${total} ${label} have never been ${examinedAs}, so nothing above judged them and the score covers only the other ${examined}: ${named}${andMore}.${nextStep}`,
    };
}

/**
 * Ask a check what its whole population is, and record the part of it the
 * check never examined — as an ordinary result row, so it is in the score.
 *
 * A listCoverage() that throws or times out does NOT mean "nothing is
 * missing". It means we do not know how much of this organisation the run
 * covered, and the row says so rather than quietly leaving the score looking
 * complete. Checks without listCoverage() are untouched; they simply declare
 * no population, and the snapshot summary counts them as neither covered nor
 * uncovered.
 */
async function _runCoverage(check, orgId, runType) {
    if (typeof check.listCoverage !== 'function') return null;
    let result;
    try {
        const report = await _withTimeout(
            Promise.resolve().then(() => check.listCoverage(orgId)),
            CHECK_TIMEOUT_MS,
            'coverage',
        );
        if (!report || typeof report !== 'object') throw new Error('listCoverage returned no report');
        result = _coverageVerdict(check, report);
    } catch (e) {
        log.warn(`[ComplianceRunner] ${check.id} listCoverage failed:`, e.message);
        result = {
            status: 'warn',
            evidence: { kind: null, label: null, total: null, examined: null, unexamined_count: null, unexamined: [], unknown: true, error: e.message, link: check.remediationLink || null },
            details: `How much of this organisation this check actually covered could not be established (${e.message}), so the score above is over an unknown share of it. Re-run once the source is readable.`,
        };
    }
    const row = { check_id: check.id, regulation: check.regulation, scope: COVERAGE_SCOPE, subject: null, ...result };
    await _persistResult(check, orgId, result, runType, null, { type: COVERAGE_SCOPE, id: COVERAGE_SCOPE });
    return row;
}

/**
 * The run-level answer to "what was this score computed over". Built from the
 * coverage rows the sweep just wrote, so there is one source of the numbers.
 * `complete` is narrow on purpose: it means every population that CAN be
 * counted was fully examined — not that everything in the product was, since
 * a check that declares no population is not counted either way.
 */
function _coverageSummary(results) {
    const rows = results.filter(r => r.scope === COVERAGE_SCOPE);
    if (!rows.length) return null;
    let total = 0, examined = 0, unexamined = 0, unknown = 0;
    const populations = [];
    for (const r of rows) {
        const e = r.evidence || {};
        if (e.unknown) {
            unknown++;
            populations.push({ check_id: r.check_id, kind: e.kind || null, label: e.label || null, unknown: true });
            continue;
        }
        total += Number(e.total) || 0;
        examined += Number(e.examined) || 0;
        unexamined += Number(e.unexamined_count) || 0;
        populations.push({
            check_id: r.check_id,
            kind: e.kind || null,
            label: e.label || null,
            total: Number(e.total) || 0,
            examined: Number(e.examined) || 0,
            unexamined: Number(e.unexamined_count) || 0,
            link: e.link || null,
            sample: (e.unexamined || []).slice(0, COVERAGE_NAMES_IN_DETAILS),
        });
    }
    return { total, examined, unexamined, unknown_populations: unknown, complete: unexamined === 0 && unknown === 0, populations };
}

/** The check's own verdicts: one row for a global check, one per subject otherwise. */
async function _runVerdicts(check, orgId, runType) {
    const results = [];
    if (check.scope === 'per-source' && typeof check.listSubjects === 'function') {
        let subjects = [];
        try {
            subjects = await check.listSubjects(orgId) || [];
        } catch (e) {
            log.warn(`[ComplianceRunner] ${check.id} listSubjects failed:`, e.message);
        }
        if (!subjects.length) {
            const naResult = {
                status: 'not_applicable',
                evidence: { subjects: 0 },
                details: 'No subjects to evaluate.',
            };
            results.push({ check_id: check.id, regulation: check.regulation, scope: 'per-source', subject: null, ...naResult });
            await _persistResult(check, orgId, naResult, runType, null);
            return results;
        }
        for (const subj of subjects) {
            const r = await _runSafe(check, orgId, subj);
            results.push({ check_id: check.id, regulation: check.regulation, scope: 'per-source', subject: subj, ...r });
            await _persistResult(check, orgId, r, runType, subj);
        }
        return results;
    }
    const r = await _runSafe(check, orgId, null);
    results.push({ check_id: check.id, regulation: check.regulation, scope: 'global', subject: null, ...r });
    await _persistResult(check, orgId, r, runType, null);
    return results;
}

/**
 * Evaluate one check (expanding per-source subjects) and persist every row,
 * with its coverage row last. Returns the result rows.
 *
 * The coverage row runs AFTER the verdicts and never in place of them: a check
 * that can enumerate its population still has to judge the part of it it can
 * see, and the two answers are both wanted.
 */
async function _runCheck(check, orgId, runType) {
    const results = await _runVerdicts(check, orgId, runType);
    const coverage = await _runCoverage(check, orgId, runType);
    if (coverage) results.push(coverage);
    return results;
}

/**
 * Org-defined frameworks are DB rows evaluated by attestation, not registry
 * modules — compliance/custom/runner.js (Wave 1) walks them. Until it ships
 * its absence is harmless; once it does, whatever it returns under `scores`
 * ({ 'custom:<uuid>': n }) joins the snapshot.
 */
async function _runCustom(orgId, runType) {
    let customRunner = null;
    try { customRunner = require('./custom/runner'); } catch { return null; }
    if (typeof customRunner?.runAll !== 'function') return null;
    try {
        return await customRunner.runAll(orgId, { runType });
    } catch (e) {
        log.warn(`[ComplianceRunner] custom frameworks run failed for org="${orgId}":`, e.message);
        return null;
    }
}

function _invalidateCounts(orgId) {
    // routes/compliance/counts.js caches /counts for 60 s per org; bust it so
    // the rail reflects this sweep. The module lands in Wave 1 — best-effort.
    try { require('./countsCache').invalidate(orgId); } catch { /* not shipped yet */ }
}

/**
 * Run every check whose home framework is active for the organisation.
 * Per-source checks are expanded over their listSubjects() iterable.
 *
 * `frameworks` (regulation codes) restricts the sweep further — that is how
 * runFramework() works. A restricted sweep writes no score snapshot: the trend
 * line is a full-sweep series, and a partial one would record every other
 * framework as NULL.
 *
 * Throws frameworkPolicy.EntitlementsUnavailableError when the licence cannot
 * be resolved — the scheduler skips the org rather than running with an empty
 * set (which would look like "nothing to check").
 */
async function runAll(orgId, { runType = 'scheduled', frameworks: only = null } = {}) {
    const active = await frameworkPolicy.activeRegulations(orgId);
    const restrict = Array.isArray(only) ? new Set(only) : null;
    const checks = registry.getAll().filter(c => active.has(c.regulation) && (!restrict || restrict.has(c.regulation)));

    const started = Date.now();
    const results = [];
    for (const check of checks) {
        results.push(...await _runCheck(check, orgId, runType));
    }

    const custom = (active.has(frameworks.CUSTOM_REGULATION) && (!restrict || restrict.has(frameworks.CUSTOM_REGULATION)))
        ? await _runCustom(orgId, runType)
        : null;

    if (DEBUG) log.debug(`[ComplianceRunner] org="${orgId}" ${checks.length} checks → ${results.length} rows in ${Date.now() - started} ms (active: ${[...active].join(',')})`);

    // One score snapshot per full sweep — powers the trend on the Overview
    // page. Best-effort: a snapshot failure never fails the run itself.
    if (!restrict) {
        try {
            const overall = computeScore(results);
            // One entry per ACTIVE built-in framework, keyed by framework id;
            // null where no row counts for it (a framework whose checks are all
            // still to be written) — NULL, not 100.
            const scores = scoreNumbers(scoresByFramework(results, active));
            if (custom && custom.scores && typeof custom.scores === 'object') {
                for (const [id, s] of Object.entries(custom.scores)) {
                    if (frameworks.isCustomId(id)) scores[id] = typeof s === 'number' ? s : (s?.score ?? null);
                }
            }
            const snapshot = {
                organization_id: orgId,
                overall_score: overall.score,
                pass: overall.pass, warn: overall.warn, fail: overall.fail, na: overall.na,
                run_type: runType,
                scores,
                // What this number was computed over. Stored with the score
                // rather than derived later, because "the score as the org saw
                // it" and "how much of the org it covered" have to stay the
                // same pair forever — a trend point that lost its coverage
                // would be the false green again, one release later.
                coverage: _coverageSummary(results),
            };
            // The three legacy columns are the same numbers under their old
            // names; an inactive (locked) core framework stays NULL.
            for (const [reg, col] of Object.entries(SNAPSHOT_COLUMN)) {
                snapshot[col] = scores[frameworks.frameworkIdOf(reg)] ?? null;
            }
            await complianceStore.recordScoreSnapshot(snapshot);
        } catch (e) {
            log.warn('[ComplianceRunner] score snapshot failed:', e.message);
        }
    }
    _invalidateCounts(orgId);
    return results;
}

/**
 * Run the checks of ONE framework (by framework id: 'nis2', 'cra', …) —
 * invoked when an admin enables it, so the card scores right away instead of
 * at the next 6-hourly sweep. Same activity gate as runAll: a framework that
 * is not active yields no rows.
 */
async function runFramework(orgId, frameworkId, opts = {}) {
    const regulation = frameworks.regulationOf(frameworkId);
    if (!regulation) throw new frameworkPolicy.UnknownFrameworkError(frameworkId);
    return runAll(orgId, { runType: 'manual', ...opts, frameworks: [regulation] });
}

/**
 * Re-judge ONE subject across every check that actually holds it — the sweep
 * a thing deserves the moment it changes, rather than at the next 6-hourly
 * one. compliance/subjectReview.js is what calls this, off the request path,
 * when a routine is switched on or off.
 *
 * `subjectIds` is one id or several SPELLINGS OF THE SAME THING, because the
 * tree has more than one: `AIA-Art50-content-marking` holds a routine under
 * its bare id while `MACHINERY-Art18-safety-component-assessment` holds it as
 * `automation:<id>`. A caller passes every spelling and gets the union.
 *
 * WHY THIS IS NOT A LOOP OVER runOne(). runOne, handed a subjectId a check
 * does not have, filters its subject list down to nothing and then persists a
 * `not_applicable` row with NO subject — which lands in that check's GLOBAL
 * slot (scope_type 'global', scope_id NULL), and getLatestPerCheck takes the
 * newest row per slot. Asking six checks about one routine would therefore
 * blank the real verdict of the five that never heard of it and replace each
 * with "Subject not found.". A routine going live would have turned five
 * honest findings into five shrugs.
 *
 * So the subject is DISCOVERED instead of assumed: each per-source check of an
 * active framework is asked for its own subjects, and only the checks whose
 * list contains this one are run. That also means no check has to register
 * anywhere or declare what kind of thing it judges — a check added next year
 * that lists routines is picked up by this the day it lands.
 *
 * Global checks are deliberately skipped. Their verdict is about the
 * workspace, not about this routine; re-deriving one from a single toggle
 * would rewrite a workspace-wide answer from a single click's worth of
 * evidence. That is what runAll is for.
 *
 * No score snapshot is written, for the reason runAll gives about restricted
 * sweeps: the trend line is a full-sweep series, and a point computed from one
 * routine would record every framework it did not look at as NULL.
 *
 * Never throws for an absent subject or a switched-off framework — both are
 * ordinary, and an empty array is the honest answer.
 */
async function runForSubject(orgId, subjectIds, { runType = 'event' } = {}) {
    const wanted = new Set(
        (Array.isArray(subjectIds) ? subjectIds : [subjectIds])
            .filter(v => v != null && String(v).trim() !== '')
            .map(String),
    );
    if (!orgId || !wanted.size) return [];

    const active = await frameworkPolicy.activeRegulations(orgId);
    const out = [];
    for (const check of registry.getAll()) {
        if (check.scope !== 'per-source' || typeof check.listSubjects !== 'function') continue;
        if (!active.has(check.regulation)) continue;
        let subjects;
        try {
            subjects = await _withTimeout(
                Promise.resolve().then(() => check.listSubjects(orgId)),
                CHECK_TIMEOUT_MS,
                'listSubjects',
            ) || [];
        } catch (e) {
            // One check that cannot enumerate its population must not stop the
            // others from judging this routine. Nothing is persisted for it —
            // its previous row stands, and the scheduled sweep will try again.
            log.warn(`[ComplianceRunner] ${check.id} listSubjects failed during subject review:`, e.message);
            continue;
        }
        for (const subj of subjects) {
            if (!subj || !wanted.has(String(subj.id))) continue;
            const r = await _runSafe(check, orgId, subj);
            await _persistResult(check, orgId, r, runType, subj);
            out.push({ check_id: check.id, scope: 'per-source', subject: subj, ...r });
        }
    }
    if (DEBUG) log.debug(`[ComplianceRunner] org="${orgId}" subject review [${[...wanted].join(', ')}] → ${out.length} rows`);
    if (out.length) _invalidateCounts(orgId);
    return out;
}

/**
 * Run a single check by id. For per-source checks, runs across all subjects
 * unless a `subjectId` is provided to scope down to one. Refuses a check
 * whose home framework is not active for the org — a manual "re-run" from
 * a stale tab must not write rows for a framework that was switched off.
 */
async function runOne(orgId, checkId, { runType = 'manual', subjectId = null } = {}) {
    const check = registry.get(checkId);
    if (!check) throw new Error(`Unknown check: ${checkId}`);
    const active = await frameworkPolicy.activeRegulations(orgId);
    if (!active.has(check.regulation)) throw new FrameworkDisabledError(check.id, check.regulation);

    if (check.scope === 'per-source' && typeof check.listSubjects === 'function') {
        let subjects = await check.listSubjects(orgId) || [];
        if (subjectId) subjects = subjects.filter(s => String(s.id) === String(subjectId));
        if (!subjects.length) {
            const naResult = {
                status: 'not_applicable',
                evidence: { subjects: 0 },
                details: subjectId ? 'Subject not found.' : 'No subjects to evaluate.',
            };
            await _persistResult(check, orgId, naResult, runType, null);
            return { check_id: check.id, scope: 'per-source', subject: null, ...naResult };
        }
        const out = [];
        for (const subj of subjects) {
            const r = await _runSafe(check, orgId, subj);
            await _persistResult(check, orgId, r, runType, subj);
            out.push({ check_id: check.id, scope: 'per-source', subject: subj, ...r });
        }
        return out.length === 1 ? out[0] : { check_id: check.id, scope: 'per-source', results: out };
    }
    const r = await _runSafe(check, orgId, null);
    await _persistResult(check, orgId, r, runType, null);
    return { check_id: check.id, scope: 'global', subject: null, ...r };
}

/**
 * Invoke a check's autoFix(orgId, opts) handler if defined and persist an
 * evidence row capturing the action for audit. Returns the autofix output.
 */
async function autoFix(orgId, checkId, opts = {}) {
    const check = registry.get(checkId);
    if (!check) throw new Error(`Unknown check: ${checkId}`);
    if (typeof check.autoFix !== 'function') {
        throw new Error(`Check ${checkId} does not support auto-fix`);
    }
    const result = await check.autoFix(orgId, opts);
    const payload = {
        action: 'auto-fix',
        check_id: checkId,
        opts,
        result,
        actor: opts.actorId || null,
        at: new Date().toISOString(),
    };
    await complianceStore.addEvidence({
        organization_id: orgId,
        check_id: checkId,
        subject_type: 'auto-fix',
        subject_id: opts.subjectId || null,
        hash: _hashPayload(payload),
        payload,
    });
    return result;
}

module.exports = {
    runAll, runFramework, runOne, runForSubject, autoFix,
    FrameworkDisabledError, CHECK_TIMEOUT_MS, COVERAGE_SCOPE,
    // Exported for the tests: the two pure pieces of the coverage answer.
    _coverageVerdict, _coverageSummary,
};

'use strict';

/**
 * COVERAGE — the pure half of the runner's coverage contract (the reasoning is
 * in the header of compliance/runner.js, "why a score is never allowed to
 * stand alone"). A check that can enumerate its own population says so with
 * `listCoverage()`; the runner calls it under the check timeout and turns the
 * report into one result row with coverageVerdict, a failed or hung listing
 * into an "unknown coverage" row with coverageFailure, and the run's coverage
 * rows into the snapshot's `coverage` summary with coverageSummary.
 */

const { errorShape } = require('./lib/errorShape');

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
function coverageVerdict(check, report) {
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
 * The row of a listCoverage() that threw or timed out: unknown coverage, a
 * warn, never "nothing is missing". Only the error's class and code are
 * recorded (lib/errorShape.js): a driver message can quote row values and the
 * row enters the evidence chain. `timedOutAfter` is the human budget ("30 s")
 * when the listing timed out, else null.
 */
function coverageFailure(check, e, timedOutAfter) {
    const { name, code } = errorShape(e);
    const failure = timedOutAfter
        ? { error: `coverage timed out after ${timedOutAfter}` }
        : { error: 'coverage_exception', error_name: name, error_code: code };
    const why = timedOutAfter ? `the population listing timed out after ${timedOutAfter}` : 'the population could not be read';
    return {
        status: 'warn',
        evidence: { kind: null, label: null, total: null, examined: null, unexamined_count: null, unexamined: [], unknown: true, ...failure, link: check.remediationLink || null },
        details: `How much of this organisation this check actually covered could not be established (${why}), so the score above is over an unknown share of it. Re-run once the source is readable.`,
    };
}

/**
 * The run-level answer to "what was this score computed over". Built from the
 * coverage rows the sweep just wrote, so there is one source of the numbers.
 * `complete` is narrow on purpose: it means every population that CAN be
 * counted was fully examined — not that everything in the product was, since
 * a check that declares no population is not counted either way.
 */
function coverageSummary(results) {
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

module.exports = {
    COVERAGE_SCOPE,
    COVERAGE_NAMES_IN_DETAILS,
    COVERAGE_NAMES_IN_EVIDENCE,
    coverageVerdict,
    coverageFailure,
    coverageSummary,
};

/**
 * Compliance subject review — re-judge ONE thing the moment it changes,
 * instead of waiting for the next sweep.
 *
 * WHY THIS EXISTS. compliance/scheduler.js sweeps every organisation once
 * every six hours, and that is the only thing that ever moves a verdict. So a
 * automation switched on at 09:05 was judged by a sweep that had already run at
 * 06:00 — a sweep that could not have seen it, because it did not exist yet.
 * For the rest of the day the Compliance Center went on describing a workspace
 * that no longer existed: the new automation generating documents with no
 * AI-marking verdict against it at all, the dashboard still green, and the
 * admin reading that green as an answer. Nobody was told anything was wrong
 * until the sweep caught up, which for an evening activation meant the next
 * morning. The product's promise is compliant workflow automations; a review
 * that lands a shift late is not that.
 *
 * WHAT IT DOES. `reviewAutomation(orgId, automationId)` queues a review of
 * exactly that automation and returns immediately. Some milliseconds later
 * runner.runForSubject() re-runs the per-source checks that actually claim the
 * automation as a subject, writes their rows, and the dashboard tells the truth
 * about it the same minute it went live.
 *
 * THE THREE THINGS THIS IS CAREFUL ABOUT
 *
 *   1. It never touches the request. Every entry point returns synchronously
 *      after arming a timer; nothing the caller does is awaited on the review.
 *      A compliance sweep is not something a user waits for behind a spinner.
 *
 *   2. It COALESCES rather than resets. An armed review is left alone when
 *      another toggle of the same automation arrives — the run that is already
 *      scheduled will read whatever state the automation has settled into by the
 *      time it fires, so five flips of one switch are one review, not five.
 *      The window is deliberately NOT restarted on each toggle: a debounce
 *      that restarts can be held off forever by someone drumming the switch,
 *      and "forever" is the bug being fixed here. Coalescing puts a ceiling on
 *      the delay (DEBOUNCE_MS after the FIRST toggle) instead of on nothing.
 *
 *   3. It is scoped to one subject, never a sweep. runForSubject touches only
 *      the checks that list this automation, so a toggle costs a handful of
 *      queries — not a full-workspace run per click, which at six checks over
 *      a few hundred subjects would make the switch a denial-of-service on the
 *      org's own database.
 *
 * AND THE RULE ABOVE ALL OF THEM: nothing in here may fail an activation. The
 * caller has already switched the automation on and told the user so; a
 * compliance check that throws, hangs or finds the framework switched off must
 * end as a log line and nothing else. Every path is wrapped, including the
 * scheduling call itself.
 *
 * No personal data is logged. The ids of an automation and of a check are not
 * personal data; the automation's title, its owner and anything a check found are
 * not repeated here (BFSF-441).
 */

// Long enough that a hand on the switch produces one review rather than one
// per click, short enough that "the same minute it went live" stays true.
// Env override is for the tests and for a box whose checks are slow — not a
// tuning knob for production.
const log = require('../telemetry/log');
const DEBOUNCE_MS = parseInt(process.env.COMPLIANCE_SUBJECT_REVIEW_DEBOUNCE_MS || '5000', 10);

// key -> { timer, kind, orgId, subjectId, reason }. A key present here has a
// review already coming; see the coalescing note above.
const _armed = new Map();
// Keys whose review is executing right now, and keys that changed WHILE their
// review was executing. The second set is not belt-and-braces: a review that
// outruns the debounce window would otherwise swallow the toggle that arrived
// during it, and a silently dropped review is the exact failure this module
// was written to end.
const _running = new Set();
const _again = new Set();

// JSON, not a separator character: an organisation id and a subject id are
// opaque strings, and a key built by gluing them together with a character
// that turns out to be legal in one of them stops being injective — two
// automations would then share one debounce slot and one of them would never be
// reviewed. The kind is part of the key, so an automation and a project that
// happen to share an id never share a slot either.
function _key(kind, orgId, subjectId) {
    return JSON.stringify([String(kind), String(orgId), String(subjectId)]);
}

/**
 * Every spelling under which a check may hold this automation as a subject.
 *
 * There are two in the tree today and they are not interchangeable:
 * `AIA-Art50-content-marking` lists automations under their bare id, while
 * `MACHINERY-Art18-safety-component-assessment` lists everything it detects as
 * `<source>:<id>` and so holds the same automation as `automation:<id>`. Asking
 * with only one spelling silently reviews only half of what applies to it,
 * which looks exactly like working.
 */
function subjectSpellings(automationId) {
    const id = String(automationId);
    return [id, `automation:${id}`];
}

/**
 * Every spelling under which a check may hold a collaborative project. The
 * project checks list `project:<id>`; the bare id is asked too, for the same
 * reason as above — a check written later that forgets the prefix must still
 * be found.
 */
function projectSpellings(projectId) {
    const id = String(projectId);
    return [`project:${id}`, id];
}

const KINDS = Object.freeze({
    automation: { spellings: subjectSpellings, noun: 'automation' },
    project: { spellings: projectSpellings, noun: 'project' },
});

async function _run(key, kind, orgId, subjectId, reason) {
    if (_running.has(key)) { _again.add(key); return; }
    _running.add(key);
    const { spellings, noun } = KINDS[kind];
    try {
        // Required lazily: compliance/runner.js pulls in the registry, the
        // framework policy and the store, and an automation route must not pay
        // that at boot for a review it may never queue.
        const runner = require('./runner');
        const results = await runner.runForSubject(orgId, spellings(subjectId), { runType: 'event' });
        if (results.length) {
            const worst = results.filter(r => r.status === 'fail' || r.status === 'warn').length;
            log.info(`[ComplianceSubjectReview] ${reason} of ${noun} ${subjectId} → ${results.length} check row(s), ${worst} needing attention`);
        }
    } catch (e) {
        // Swallowed on purpose. The change is already live and the user has
        // already been told so; the worst this may cost is a verdict that
        // waits for the next scheduled sweep after all, which is where we
        // were before this module existed.
        log.warn(`[ComplianceSubjectReview] ${reason} review of ${noun} ${subjectId} failed: ${e.message}`);
    } finally {
        _running.delete(key);
        if (_again.delete(key)) _queue(kind, orgId, subjectId, { reason });
    }
}

function _queue(kind, orgId, subjectId, { reason = 'activation' } = {}) {
    try {
        if (!orgId || subjectId == null || String(subjectId).trim() === '') return;
        const key = _key(kind, orgId, subjectId);
        if (_armed.has(key)) return;   // a review is already coming — it will read the final state
        const timer = setTimeout(() => {
            _armed.delete(key);
            _run(key, kind, orgId, subjectId, reason).catch(() => { /* _run never rejects */ });
        }, DEBOUNCE_MS);
        // unref: a pending review must never be the reason a worker or a test
        // run refuses to exit. Losing it on shutdown costs one verdict that
        // the scheduled sweep will write anyway.
        if (timer.unref) timer.unref();
        _armed.set(key, { timer, kind, orgId, subjectId, reason });
    } catch (e) {
        log.warn(`[ComplianceSubjectReview] could not queue a review of ${KINDS[kind]?.noun || kind} ${subjectId}: ${e.message}`);
    }
}

/**
 * Queue a compliance review of one automation. Returns immediately, always.
 *
 * `orgId` is the organisation whose checks can see this automation — the
 * automation's own organisation, falling back to its OWNER's, which is the
 * COALESCE the checks themselves scope by. Without one there is no per-source
 * check that could match it, so there is nothing to do.
 */
function reviewAutomation(orgId, automationId, opts = {}) {
    _queue('automation', orgId, automationId, opts);
}

/**
 * Queue a compliance review of one collaborative project — its members, a
 * chat's AI mode or its files changed (compliance/events.js PROJECT_CHANGED).
 * Returns immediately, always; never touches the request that caused it.
 */
function reviewProject(orgId, projectId, opts = {}) {
    _queue('project', orgId, projectId, opts);
}

/** Test-only: run everything currently armed, now, and wait for it. */
async function _drain() {
    const entries = [..._armed.values()];
    _armed.clear();
    for (const e of entries) {
        clearTimeout(e.timer);
        await _run(_key(e.kind, e.orgId, e.subjectId), e.kind, e.orgId, e.subjectId, e.reason);
    }
}

/** Test-only: forget everything armed without running it. */
function _reset() {
    for (const e of _armed.values()) clearTimeout(e.timer);
    _armed.clear();
    _running.clear();
    _again.clear();
}

/** Test-only: how many distinct reviews are waiting. */
function _armedCount() { return _armed.size; }

module.exports = {
    reviewAutomation,
    reviewProject,
    subjectSpellings,
    projectSpellings,
    DEBOUNCE_MS,
    _drain, _reset, _armedCount,
};

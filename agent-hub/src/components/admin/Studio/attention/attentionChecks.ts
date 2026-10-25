// "Needs attention" on Studio's Start screen — the CLIENT half.
//
// ── The rules are not restated here ─────────────────────────────────────────
//
// The six sources (an app with validation problems, a published agent with no
// knowledge base, an empty knowledge base something reads, an automation failing
// in a row, a blocked Solution, a knowledge source that could not refresh)
// live in server/routes/studio/attention.js + attentionChecks.js, each behind
// the same gate and the same scoping as its own list route. This module does
// NOT re-derive any of them from the product's list endpoints: a second
// implementation of "empty knowledge base in use" is two products that will
// eventually disagree, and the client's copy would be the one that cannot see
// what the caller is not allowed to list.
//
// So the register below has ONE entry, and what it evaluates is the
// aggregate's answer. What it keeps from onboarding/actionChecks.js is the
// MODEL, because that is the shape this data needs:
//
//   - the NETWORK LIVES ONLY IN fetchState;
//   - `evaluate` is pure (data in → verdict out) and exported, so every rule
//     below is testable as a plain object;
//   - every entry runs inside its own catch, so one source falling over names
//     its own gap instead of taking the list down;
//   - gates are resolved BEFORE a check runs, by `checkAvailability`, and an
//     unresolvable gate narrows (see below).
//
// ── The three values, and why they are three ────────────────────────────────
//
// runActionCheck flattens a run into `{ passes, allPassed, error }`: a check
// that could not run reads exactly like a check that found nothing. On this
// screen that is the whole bug, and the endpoint is built so a client cannot
// make it by accident. Its answer carries `complete`, `unavailable[]` and
// `gated[]`, and this module carries all three through:
//
//   findings + complete:true    we looked everywhere and this is all of it
//   findings + complete:false   what is here is real, but there is a hole
//   capped                      a source that ran over the first N of a bigger
//                               organisation: nothing broke, and it is still
//                               not the whole picture
//   skipped                     a source that is not this caller's to see —
//                               NOT a hole; a Community organisation has no
//                               Solutions to block, and telling every member
//                               "some checks could not run" on every load is
//                               how a warning is taught to be ignored
//
// ── Gates ───────────────────────────────────────────────────────────────────
//
// The single entry declares NO gate, on purpose: the endpoint gates each of
// its six sources itself, with that source's own rule, and reports which ones
// it closed. A client-side second opinion on rights is how a screen ends up
// hiding a source from somebody who does have it (RunsStudio's scope switch
// keeps the same rule: the server is the authority and refuses in words).
// `checkAvailability` stays because it is the register's contract and the one
// place where "unknown narrows" is enforced for whatever entry comes next.

import { API_BASE } from '../../../../utils/helpers';
import { kindOf, type KindKey } from '../../../shared/kindColors';
import { studioAppForKind, studioSectionLabel } from '../studioNav';
import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { LessonUser, HasFeature } from '../../../../api/lessons.types';
import type { AttentionFinding, RawAttentionRow, AttentionBody, AttentionVerdict, AttentionRun, AttentionCtx, AttentionCheck, AttentionItem } from './attentionChecks.types';
import { request, RefusedError } from '../../../../api/mutate';
import { SEVERITY_RANK, SOURCE_ORDER, SOURCE_LABELS, AVAILABILITY, EMPTY_ATTENTION } from './attentionChecks.constants';
import { runCheck } from './attentionChecks.helpers';
export { checkAvailability, runCheck } from './attentionChecks.helpers';
export {  SOURCE_ORDER, SOURCE_LABELS, AVAILABILITY,  } from './attentionChecks.constants';
export type { AttentionFinding, AttentionRun, AttentionItem } from './attentionChecks.types';

/** The same helper actionChecks.js keeps private; the Studio chunk gets its own. */
async function getJson(path: string) {
    let res: Response;
    try {
        res = await request(`${API_BASE}${path}`);
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        throw new Error(`GET ${path} → ${err.status}`);
    }
    return res.json();
}

/* ── Findings ────────────────────────────────────────────────────────────── */

const sourceRank = (source: string) => {
    const i = SOURCE_ORDER.indexOf(source);
    return i === -1 ? SOURCE_ORDER.length : i;
};

/**
 * SEVERITY DECIDES THE ORDER, THE SOURCE DOES NOT.
 *
 * A blocked Solution stands above an empty knowledge base whichever source
 * answered first — grouping by source is how a list ends up asking somebody to
 * read six rows before reaching the one that is actually broken. Source order
 * survives only as a tie-break between equal severities (and the sentence
 * after that), so the list cannot shuffle between two renders of the same data.
 *
 * The server sorts by severity too. This is not a second opinion but the same
 * one: the guarantee belongs to the screen that makes the promise, and a row
 * that reaches it from anywhere else still lands in the right place.
 */
export function sortFindings(findings: unknown) {
    return [...(Array.isArray(findings) ? findings : [])].sort((a, b) => {
        const rank = (SEVERITY_RANK[a?.severity] ?? 9) - (SEVERITY_RANK[b?.severity] ?? 9);
        if (rank !== 0) return rank;
        const src = sourceRank(a?.source) - sourceRank(b?.source);
        if (src !== 0) return src;
        return String(a?.message || '').localeCompare(String(b?.message || ''));
    });
}

/**
 * Source keys → the NAMES of the sections they cover, for the line that says
 * which checks could not run.
 *
 * "Some checks could not run" without saying which is a sentence a person sees
 * every day and cannot act on — they cannot tell whether it is the same source
 * falling over every time or a different one. The Solution's control panel
 * already names its gaps under the same kind of strip
 * (Solutions/SolutionControlPanel.jsx), so this list does too.
 *
 * The names come from the STUDIO REGISTRY through the source's kind, not from
 * six new strings: "Agents" here has to be the same word as on the rail, and
 * two sources sharing a kind (both knowledge ones) name that section once.
 * A key this build has never heard of falls back to the key itself rather than
 * disappearing — an unnamed gap is still a gap.
 */
export function attentionSourceNames(keys: string[] | null, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, locale: string | undefined = undefined) {
    const out: string[] = [];
    for (const key of Array.isArray(keys) ? keys : []) {
        if (typeof key !== 'string' || !key) continue;
        // A gap from runCheck is prefixed with the check that hit it
        // ("studio:kbSourceError"); a key from `gated`/`capped` is bare. Both
        // name the same source, so both resolve.
        const bare = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
        const meta = SOURCE_LABELS[key] || SOURCE_LABELS[bare];
        const app = meta ? studioAppForKind(meta.kind) : null;
        const name = app ? studioSectionLabel(app, t, locale) : bare;
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}

/**
 * One row from GET /api/studio/attention → the shape the screen draws from.
 *
 * The endpoint's row is `{ source, code, severity, kind, targetId, message,
 * deepLink, remediation? }` (routes/studio/attention.js toRow). It is read
 * defensively — a row missing a code or a severity is a row this client cannot
 * place, and `null` here means the caller COUNTS it rather than drawing it.
 */
/** A non-blank string, or null. Blank text is no text, on every field. */
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

export function normaliseAttentionRow(row: RawAttentionRow | null | undefined): AttentionFinding | null {
    if (!row || typeof row !== 'object') return null;
    const code = text(row.code);
    const severity = SEVERITY_RANK[row.severity] === undefined ? null : row.severity;
    if (!code || !severity) return null;
    const id = row.targetId;
    return {
        source: text(row.source),
        code,
        severity,
        kind: text(row.kind),
        targetId: id === null || id === undefined ? null : String(id),
        message: text(row.message),
        remediation: text(row.remediation),
        deepLink: text(row.deepLink),
    };
}

/* ── The pure evaluator ──────────────────────────────────────────────────── */

/**
 * The aggregate's body → `{ findings, unavailable, capped, skipped, truncated, complete }`.
 *
 * `unavailable` and `gated` are the endpoint's own source keys and are carried
 * through unchanged: this module does not decide which gaps matter, it decides
 * that a gap must reach the screen. `complete` is likewise the server's
 * verdict, read rather than recomputed — the endpoint knows about six sources
 * and this client knows only about the answer it was sent.
 *
 * `truncated` is what the endpoint FOUND minus what it sent: each source caps
 * its rows (MAX_ROWS_PER_SOURCE) and reports the true `total` beside them, so
 * a screen can say "20 of 23" instead of quietly becoming a smaller problem.
 *
 * `capped` is the endpoint's third word, and it is neither of the other two: a
 * source that RAN but only over the first N of a bigger organisation (25 apps,
 * 12 Solutions…). It is not a breakdown — nothing is wrong — and it is not a
 * clean answer either, so it travels separately and the server has already
 * cleared `complete` for it. The screen says "this covers the busiest part",
 * not "something went wrong".
 *
 * A body with no `rows` array at all is not an empty organisation: it is an
 * answer this client cannot read, and it comes back as a gap.
 */
export function evaluateStudioAttention(data: AttentionBody | null | undefined): AttentionVerdict {
    if (!data || typeof data !== 'object' || !Array.isArray(data.rows)) {
        return { findings: [], unavailable: ['body'], capped: [], skipped: [], truncated: 0, complete: false };
    }
    const findings: AttentionFinding[] = [];
    let unreadable = 0;
    for (const row of data.rows) {
        const finding = normaliseAttentionRow(row);
        if (finding) findings.push(finding);
        else unreadable += 1;
    }
    const unavailable = (Array.isArray(data.unavailable) ? data.unavailable : [])
        .filter((key) => typeof key === 'string' && key);
    const skipped = (Array.isArray(data.gated) ? data.gated : [])
        .filter((key) => typeof key === 'string' && key);
    const capped = (Array.isArray(data.capped) ? data.capped : [])
        .filter((key) => typeof key === 'string' && key);

    // What was found, before the per-source cap. Never below what we hold: a
    // total smaller than the rows it came with is a body to distrust, not a
    // reason to claim fewer problems than are on the screen.
    const total = Number(data.total);
    const found = Number.isFinite(total) ? Math.max(total, data.rows.length) : data.rows.length;
    return {
        findings,
        unavailable,
        capped,
        skipped,
        // Rows found but not sent, plus rows sent that could not be read: both
        // are things needing a person that this list does not show.
        truncated: (found - data.rows.length) + unreadable,
        // `complete` is the server's word, and only an explicit true counts —
        // an answer from a build that predates the field is unknown, and
        // unknown narrows (ProjectFlowTab keeps the same rule).
        complete: data.complete === true,
    };
}

/* ── The register ────────────────────────────────────────────────────────────
 * id         — the source; also the prefix on every gap it names
 * gate       — { permission?, feature? }, resolved by checkAvailability BEFORE
 *              the check runs. None today; see the module header
 * fetchState — the only network in this module; receives ctx = { user, hasFeature }
 * evaluate   — pure: data → { findings, unavailable, skipped, truncated, complete }
 * ────────────────────────────────────────────────────────────────────────── */
export const ATTENTION_CHECKS: Record<string, AttentionCheck> = {
    studio: {
        async fetchState() {
            return getJson('/api/studio/attention');
        },
        evaluate: evaluateStudioAttention,
    },
};

/* ── Gates ───────────────────────────────────────────────────────────────── */

/* ── The runner ──────────────────────────────────────────────────────────── */

/**
 * Run every check. Resolves to
 *
 *   { findings, unavailable, complete, checked, skipped, truncated }
 *
 * `findings`    everything found, sorted by severity (never by source)
 * `unavailable` every gap: a source the endpoint could not read, a check that
 *               threw (`<check>`), or a gate that could not be resolved
 *               (`<check>:gate`)
 * `complete`    no gaps AND every check that ran said its own answer was
 *               whole — the ONLY licence to say "nothing needs attention"
 * `checked`     the checks that answered
 * `skipped`     sources a gate closed: not this person's to see
 * `truncated`   found but not shown — see evaluateStudioAttention
 *
 * Each check runs through `runCheck`, which never throws, so a failed fetch
 * names its own gap instead of taking the list down (routes/studio/search.js's
 * errors[], applied per source).
 *
 * `checks` defaults to the register and is a parameter only so the tests can
 * drive a fixture entry — the register has one entry today, and the rules that
 * matter (a gate that closes, a body without `complete`) cannot be exercised
 * through it otherwise.
 */
export async function runAttentionChecks(ctx: AttentionCtx = {}, checks: Record<string, AttentionCheck> = ATTENTION_CHECKS): Promise<AttentionRun> {
    const results = await Promise.all(
        Object.entries(checks).map(([id, check]) => runCheck(id, check, ctx)),
    );
    const findings = sortFindings(results.flatMap((r) => r.findings));
    const unavailable = [...new Set(results.flatMap((r) => r.gaps))];
    const ran = results.filter((r) => r.availability === AVAILABILITY.READY);
    return {
        findings,
        unavailable,
        // Two ways to be incomplete and both count: a gap of our own, and a
        // check that answered but said its own answer was not whole.
        complete: unavailable.length === 0 && results.every((r) => r.whole),
        checked: ran.map((r) => r.id),
        // Sources that ran but only over part of a big organisation. Not a
        // gap; `complete` is already false because the server said so.
        capped: [...new Set(results.flatMap((r) => r.capped || []))].sort(),
        skipped: [...new Set(results.flatMap((r) => r.skipped))].sort(),
        truncated: results.reduce((n, r) => n + r.truncated, 0),
    };
}

/* ── What the screen may draw ────────────────────────────────────────────── */

/**
 * Split a run into rows this client can actually draw, and a COUNT of the ones
 * it cannot. Pure, so the rule is testable without a screen.
 *
 * A row needs two things: a kind the palette knows (kindColors KIND_KEYS —
 * that is what gives it its glyph and its colour), and a sentence, which is
 * either the producer's own `message` or this client's line for that source. A
 * finding with neither is NOT dropped quietly: it is counted in `hidden`, and
 * the screen says there is more than what it lists.
 *
 * This is not hypothetical. FINDING_KINDS on the server and KIND_KEYS here are
 * two hand-kept lists (finding.js says so in its own header); the server
 * already folds `notebook` onto another kind because it has no tile of its
 * own; and a remotely installed module can add a Studio section this build has
 * never heard of. Every one of those arrives as a finding whose kind resolves
 * to null, and the number of things that need a person is not something a
 * client version may quietly revise downwards.
 */
export function summarizeAttention(state: Readonly<AttentionRun> | null | undefined) {
    const run = state || EMPTY_ATTENTION;
    const all = sortFindings(run.findings);
    const truncated = Number.isFinite(run.truncated) ? Math.max(0, run.truncated) : 0;
    const items: AttentionItem[] = [];
    let hidden = 0;
    all.forEach((f, i) => {
        const kind = kindOf(f?.kind);
        const label = SOURCE_LABELS[f?.source] || null;
        if (!kind || (!f.message && !label)) { hidden += 1; return; }
        items.push({
            key: `${f.code}:${f.targetId ?? ''}:${i}`,
            finding: f,
            kind,
            severity: f.severity,
            // The producer's own words when it sent any; this client's line for
            // that source when it did not.
            message: f.message,
            labelKey: label?.key || null,
            labelFallback: label?.fallback || null,
            remediation: f.remediation,
            deepLink: f.deepLink,
        });
    });

    return {
        items,
        hidden,
        truncated,
        total: items.length + hidden + truncated,
        complete: run.complete === true,
        unavailable: Array.isArray(run.unavailable) ? run.unavailable : [],
        capped: Array.isArray(run.capped) ? run.capped : [],
        skipped: Array.isArray(run.skipped) ? run.skipped : [],
    };
}


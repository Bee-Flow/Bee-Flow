import type { AttentionRun, SourceLabel } from './attentionChecks.types';

/**
 * Errors first, then warnings, then advice. Mirrors SEVERITY_RANK in
 * server/core/findings/finding.js, so the client and the server cannot
 * disagree about what is worse.
 */
export const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ error: 0, warning: 1, info: 2 });

/**
 * The six source keys the endpoint answers with, in the artboard's order.
 * Used ONLY to break a tie between two findings of equal severity.
 */
export const SOURCE_ORDER = Object.freeze([
    'appValidation', 'agentNoKb', 'kbEmptyInUse',
    'automationFailing', 'solutionBlocked', 'kbSourceError',
]);

/* ── Copy ────────────────────────────────────────────────────────────────────
 * One translated line per SOURCE — the fallback sentence for a row that
 * arrives without one of its own.
 *
 * Normally a row shows the producer's OWN sentence, which is what the
 * endpoint sends and what a Solution's "To check" list shows for the same
 * finding (Solutions/SolutionControlPanel.jsx renders `finding.message`
 * verbatim). That sentence has the object's name folded into it ("Handbook
 * has 2 sources that could not refresh…") and the aggregate sends no separate
 * title, so swapping in a translated generic line would cost the name — a
 * worse row, not a better one. These lines exist for the row that has no
 * sentence at all, which would otherwise be a finding nobody can see.
 * ────────────────────────────────────────────────────────────────────────── */
export const SOURCE_LABELS: Readonly<Record<string, SourceLabel>> = Object.freeze({
    appValidation: { kind: 'app', key: 'studio.attention.src_app_validation', fallback: 'App has validation problems' },
    agentNoKb: { kind: 'agent', key: 'studio.attention.src_agent_no_kb', fallback: 'Agent has no knowledge base' },
    kbEmptyInUse: { kind: 'kb', key: 'studio.attention.src_kb_empty_in_use', fallback: 'Knowledge base is used but holds no documents' },
    automationFailing: { kind: 'automation', key: 'studio.attention.src_automation_failing', fallback: 'Automation failed several times in a row' },
    solutionBlocked: { kind: 'solution', key: 'studio.attention.src_solution_blocked', fallback: 'Solution has blocking findings' },
    kbSourceError: { kind: 'kb', key: 'studio.attention.src_kb_source_error', fallback: 'Knowledge source could not refresh' },
});

/** The three answers a gate can give. */
export const AVAILABILITY = Object.freeze({ READY: 'ready', GATED: 'gated', UNKNOWN: 'unknown' });

/** A run with nothing in it — and no licence to say anything is fine. */
export const EMPTY_ATTENTION: Readonly<AttentionRun> = Object.freeze({
    findings: [], unavailable: [], capped: [], complete: false, checked: [], skipped: [], truncated: 0,
});

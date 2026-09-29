/**
 * statusTone — the Compliance Center's two status vocabularies mapped onto the
 * theme's tone tokens (Compliance Center redesign, Sep 2026).
 *
 * `statusOf.js` next door speaks the PUBLISH vocabulary (live · paused · draft
 * · published · stale · unknown) — the words a thing you MAKE can be in. A
 * compliance check is not published or live: it PASSES, needs attention or
 * FAILS, and a deadline is ok, urgent or overdue. Bolting those onto the six
 * publish words would have given `StatusActionPill` an error tone it was
 * deliberately built without, so the conformance and clock words live here.
 *
 * One rule, stated once: a status colour is a PAIR. The raw token
 * (`--success` / `--warning` / `--error`) draws borders, dots, bars and the
 * arc of a score ring; the ink token (`--success-ink` …) is the TEXT on a
 * tinted chip — the raw colour as text on its own 14–16 % tint measures
 * 2.7–3.8:1 on a light card (see the ink docblock in src/index.css). Every
 * compliance surface reads the pair from `TONES` so the hub, the settings
 * badge and Studio Home cannot disagree about which red is text and which is
 * a border. `neutral` is the "nothing to say" tone: bg-tertiary bar, tertiary
 * text — never a status colour.
 *
 * Pure and React-free on purpose: the rail meta, the header pill, the table
 * rows and the mobile cards all import it, and a leaf cannot create a cycle.
 */
import {
    CircleCheck, CircleDashed, CircleMinus, CircleX, TriangleAlert,
} from 'lucide-react';

export const TONES = Object.freeze({
    success: Object.freeze({ raw: 'var(--success)', ink: 'var(--success-ink)' }),
    warning: Object.freeze({ raw: 'var(--warning)', ink: 'var(--warning-ink)' }),
    error: Object.freeze({ raw: 'var(--error)', ink: 'var(--error-ink)' }),
    neutral: Object.freeze({ raw: 'var(--bg-tertiary)', ink: 'var(--text-tertiary)' }),
});

export const TONE_KEYS = Object.freeze(Object.keys(TONES));

/** A check row's `status` (registry.js): pass · warn · fail · not_applicable · pending. */
export function toneOfCheckStatus(status) {
    switch (status) {
        case 'pass': return 'success';
        case 'warn': return 'warning';
        case 'fail': return 'error';
        default: return 'neutral'; // not_applicable, pending, unknown
    }
}

/**
 * A 0–100 score. The thresholds are the ones `ScoreRing` and the overview
 * headline have used since the hub shipped (≥ 85 good, ≥ 60 attention).
 * A missing score is `neutral` — the placeholder ring, never a red one.
 */
export function toneOfScore(score) {
    const n = Number(score);
    if (score === null || score === undefined || Number.isNaN(n)) return 'neutral';
    if (n >= 85) return 'success';
    if (n >= 60) return 'warning';
    return 'error';
}

/** A deadline clock's `state` (deadlineMath.js / GET /deadlines): ok · urgent · overdue · done · none. */
export function toneOfClock(state) {
    switch (state) {
        case 'ok': return 'success';
        case 'urgent': return 'warning';
        case 'overdue': return 'error';
        default: return 'neutral'; // done, none, unknown
    }
}

/**
 * A check's `severity` — the weight it carries in the score, not its result.
 * Only the ink is meant to be used (the severity TAG is text); a row's stripe
 * always follows the STATUS, never the severity (design rule 5: severity
 * appears only on open rows, and only as a word).
 */
export function toneOfSeverity(severity) {
    switch (severity) {
        case 'critical':
        case 'high': return 'error';
        case 'medium': return 'warning';
        default: return 'neutral'; // low, unknown
    }
}

/** The lucide glyph a check row leads with, by status. */
export function glyphOfCheckStatus(status) {
    switch (status) {
        case 'pass': return CircleCheck;
        case 'warn': return TriangleAlert;
        case 'fail': return CircleX;
        case 'not_applicable': return CircleMinus;
        default: return CircleDashed; // pending / not yet run
    }
}

/**
 * The overview headline for a score — three sentences, same thresholds as
 * `toneOfScore`. Returns the i18n KEY; the caller passes it to t() with the
 * English fallback (the keys live in the compliance.* dictionary).
 */
export function headlineKeyOfScore(score) {
    switch (toneOfScore(score)) {
        case 'success': return 'compliance.ovw_headline_good';
        case 'warning': return 'compliance.ovw_headline_attention';
        case 'error': return 'compliance.ovw_headline_gaps';
        default: return 'compliance.ovw_headline_pending';
    }
}

export const HEADLINE_FALLBACK = Object.freeze({
    'compliance.ovw_headline_good': 'You are in good shape',
    'compliance.ovw_headline_attention': 'A few items need attention',
    'compliance.ovw_headline_gaps': 'Clear gaps',
    'compliance.ovw_headline_pending': 'Score after the first run',
});

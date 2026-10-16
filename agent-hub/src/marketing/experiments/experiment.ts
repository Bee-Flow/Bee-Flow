/**
 * A/B experiments on a CMS block, drawn in the visitor's browser and stored
 * nowhere.
 *
 * Privacy design (the reason this looks the way it does):
 *  - The variant is drawn from `crypto.getRandomValues` once per page view and
 *    kept in memory (a module-level Map) for the life of that page. Nothing is
 *    written to cookies, localStorage, sessionStorage or the URL, and there is
 *    no visitor id, so there is nothing to consent to and nothing that
 *    identifies anyone.
 *  - The price: a visitor who reloads or opens another page is drawn again, so
 *    results count page views, not people. That is the honest unit for a
 *    cookieless split, and it is what the Umami events (`ab_view`, and the goal
 *    event) report.
 *  - The server renders the control for crawlers; the draw happens in React.
 *
 * Content fields on the block (server/cmsBuilder/experiments.js validates them):
 *   abKey    experiment name        abAlt    content that differs in B
 *   abShare  % of views that get B (1-99, default 50)
 *   abGoal   goal event name (default 'ab_goal')
 */

import { sanitizeAlternative, supportsExperiment } from './altPolicy';

export { supportsExperiment };

export type Variant = 'a' | 'b';

export interface Experiment {
    key: string;
    share: number;
    goal: string;
    alt: Record<string, unknown>;
}

export const DEFAULT_GOAL = 'ab_goal';
export const VIEW_EVENT = 'ab_view';
export const AB_KEYS = ['abKey', 'abAlt', 'abShare', 'abGoal'] as const;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const isPlain = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);

/** The block's experiment, or null when it is not one (or is half-configured). */
export function readExperiment(content: Record<string, unknown> | undefined): Experiment | null {
    if (!content) return null;
    const { abKey, abAlt, abShare, abGoal } = content;
    if (typeof abKey !== 'string' || !NAME_RE.test(abKey)) return null;
    if (!isPlain(abAlt) || Object.keys(abAlt).length === 0) return null;
    const share = typeof abShare === 'number' && abShare >= 1 && abShare <= 99 ? abShare : 50;
    const goal = typeof abGoal === 'string' && NAME_RE.test(abGoal) ? abGoal : DEFAULT_GOAL;
    return { key: abKey, share, goal, alt: abAlt };
}

/** The content with the experiment fields removed. */
export function stripExperiment(content: Record<string, unknown>): Record<string, unknown> {
    const out = { ...content };
    for (const k of AB_KEYS) delete out[k];
    return out;
}

/** B's content: the block's own fields, with the alternative's fields on top. */
export function applyAlternative(content: Record<string, unknown>, alt: Record<string, unknown>, type?: string): Record<string, unknown> {
    return { ...stripExperiment(content), ...sanitizeAlternative(stripExperiment(alt), type) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `next` that differ from `base`: what an alternative has to hold. */
export function diffAlternative(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
    const b = stripExperiment(base);
    const n = stripExperiment(next);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(n)) if (!same(n[k], b[k])) out[k] = n[k];
    return out;
}

/** Uniform number in [0, 1) from the browser's CSPRNG (Math.random where it is missing). */
export function secureRandom(): number {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (c && typeof c.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        c.getRandomValues(buf);
        return buf[0] / 0x100000000;
    }
    return Math.random();
}

const drawn = new Map<string, Variant>();

/** Variant of an experiment for this page view: drawn on first ask, then stable. */
export function variantFor(exp: Experiment, random: () => number = secureRandom): Variant {
    const known = drawn.get(exp.key);
    if (known) return known;
    const v: Variant = random() * 100 < exp.share ? 'b' : 'a';
    drawn.set(exp.key, v);
    return v;
}

/** Forget every draw (tests only; a real page view starts with an empty Map anyway). */
export function resetDraws(): void {
    drawn.clear();
}

export interface ResolvedBlock {
    content: Record<string, unknown>;
    /** Present only while an experiment is live for this view. */
    experiment: { key: string; variant: Variant; goal: string } | null;
}

/**
 * What to render for a block. In the editor preview the control is always
 * shown and nothing is drawn, so the author edits the real content.
 */
export function resolveBlock(
    content: Record<string, unknown> | undefined,
    opts: { preview?: boolean; random?: () => number; type?: string } = {},
): ResolvedBlock {
    const base = content || {};
    const exp = opts.preview || !supportsExperiment(opts.type) ? null : readExperiment(base);
    if (!exp) return { content: supportsExperiment(opts.type) ? base : stripExperiment(base), experiment: null };
    const variant = variantFor(exp, opts.random);
    return {
        content: variant === 'b' ? applyAlternative(base, exp.alt, opts.type) : stripExperiment(base),
        experiment: { key: exp.key, variant, goal: exp.goal },
    };
}

/** The data attributes the block wrapper carries for the goal listener (track.ts), or none. */
export function experimentAttrs(
    content: Record<string, unknown> | undefined,
    opts: { preview?: boolean; random?: () => number; type?: string } = {},
): Record<string, string> {
    const { experiment } = resolveBlock(content, opts);
    if (!experiment) return {};
    return {
        'data-cms-experiment': experiment.key,
        'data-cms-variant': experiment.variant,
        'data-cms-goal': experiment.goal,
    };
}

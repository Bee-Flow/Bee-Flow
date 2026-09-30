/**
 * "Describe it — AI picks the building blocks", the pure half: the web's
 * Studio/studioAi (routeApi.js's error codes, DescribeItPanel.jsx's words and
 * noKindCode, handoff.js's destinationForKind) on the phone's registry.
 * describeIt.lockstep.test.ts holds the codes and words to the web's and the
 * route's contract to the server's.
 *
 * ── Where "Make this" goes ──────────────────────────────────────────────────
 *
 * Through the SAME door as the kind's New-menu item: the section that IS the
 * kind (links.sectionForKind), its `create.target` (plainTarget), as this
 * person resolves it (the New menu's sections). No second kind→screen table.
 * A locked kind is a notice, not a door; so is one absent from the sections
 * (a permission hides it) or missing from the server's own `available`.
 *
 * ── What does NOT travel ────────────────────────────────────────────────────
 *
 * The card promises a name and a brief. No native create screen reads either
 * today (the `app/` routes behind the create targets read only `new`,
 * `create`, `kind` and `from` — describeIt.lockstep.test.ts checks), so the
 * card says so for every kind, as the web does for its builders that do not
 * read them (handoff.js SEED_SUPPORT / NAME_SUPPORT), and offers the brief to
 * copy. Passing `?name=` to a screen that ignores it would be a promise, not a
 * hand-over.
 */

import type { LockReason } from '@/core/access';
import { ApiError, OfflineError } from '@/core/api/client';
import type { TranslateFn } from '@/core/i18n';
import type { KindKey } from '@/shared/ui';

import type { DescribeItAnswer } from './api';
import { plainTarget, sectionForKind, type OpenTarget } from './links';
import type { ResolvedSection } from './types';

/** The codes POST /api/studio/ai/route answers with (routeApi.js ROUTE_ERROR_CODES). */
export const ROUTE_ERROR_CODES = ['no_text', 'no_model', 'ai_unusable', 'rate_limited', 'failed'] as const;
type RouteErrorCode = (typeof ROUTE_ERROR_CODES)[number];

/** The route's status contract, for a body that names no code (routeApi.js CODE_BY_STATUS). */
const CODE_BY_STATUS: Readonly<Record<number, RouteErrorCode>> = {
    400: 'no_text',
    429: 'rate_limited',
    502: 'ai_unusable',
    503: 'no_model',
};

/**
 * Why there is no plan: the route's codes, the two "no kind" answers that are
 * NOT "the AI chose nothing", and `offline`, which a phone meets far more
 * often than a browser does.
 */
export type DescribeItProblem = RouteErrorCode | 'none_available' | 'gates_unreadable' | 'offline';

/** DescribeItPanel.jsx ERROR_TEXT, plus the phone's own offline line. */
export const DESCRIBE_IT_WORDS: Readonly<Record<DescribeItProblem, readonly [key: string, fallback: string]>> = {
    no_text: ['studio.ai.err_no_text', 'Type a short description first.'],
    no_model: ['studio.ai.err_no_model', 'No AI model is set up yet, so nothing can be picked for you.'],
    ai_unusable: ['studio.ai.err_ai_unusable', 'That was not clear enough to pick a building block — describe it a little more concretely.'],
    rate_limited: ['studio.ai.err_rate_limited', 'That is a lot of requests in a row — wait a moment and try again.'],
    failed: ['studio.ai.err_failed', 'Could not read that just now. Try again.'],
    none_available: ['studio.ai.err_none_available', 'There is nothing here you can build yet — ask an admin what your workspace has switched on.'],
    gates_unreadable: ['studio.ai.err_gates_unreadable', 'We could not work out what you may build right now. Try again in a moment.'],
    offline: ['mobile.error.offline_title', 'You are offline'],
};

/** A failed request, as one of the codes: the body's own code first, then the status, else `failed`. */
export function routeProblem(err: unknown): DescribeItProblem {
    if (err instanceof OfflineError) return 'offline';
    if (!(err instanceof ApiError)) return 'failed';
    const claimed = err.code;
    if (claimed && (ROUTE_ERROR_CODES as readonly string[]).includes(claimed)) return claimed as RouteErrorCode;
    return CODE_BY_STATUS[err.status ?? 0] ?? 'failed';
}

/**
 * Why an answer came back without a kind. An empty `available` with an empty
 * `undecided` is "you may build nothing here"; with a filled one it is "we
 * could not find out" — and a filled `available` means the model gave nothing
 * usable. Three sentences, never one.
 */
export function noKindProblem(answer: Pick<DescribeItAnswer, 'available' | 'undecided'>): DescribeItProblem {
    if (answer.available && answer.available.length === 0) {
        return answer.undecided.length ? 'gates_unreadable' : 'none_available';
    }
    return 'ai_unusable';
}

/** The sentence for a problem; "no model" adds the way out the web adds. */
export function problemText(problem: DescribeItProblem, t: TranslateFn): string {
    const [key, fallback] = DESCRIBE_IT_WORDS[problem];
    const line = t(key, fallback);
    if (problem !== 'no_model') return line;
    return `${line} ${t('studio.ai.err_no_model_way_out', 'Pick a building block from New in the meantime.')}`;
}

/**
 * A kind in one word: its New-menu label (handoff.js kindLabel), so an app is
 * called the same thing on the card as in the menu. The bare key for a kind
 * no section makes.
 */
export function kindWord(kind: KindKey, t: TranslateFn): string {
    const create = sectionForKind(kind)?.create;
    return create ? t(create.labelKey, create.labelFallback) : kind;
}

/** An answer that named a kind: what the card draws. */
export type DescribeItPlan = DescribeItAnswer & { kind: KindKey };

/**
 * The plan in an answer, or null when it named no kind (then `noKindProblem`
 * says why). A plan without a brief carries the person's own words, as on the web.
 */
export function planOf(answer: DescribeItAnswer, text: string): DescribeItPlan | null {
    if (!answer.kind) return null;
    return { ...answer, kind: answer.kind, seed: answer.seed || text.trim() };
}

/** Where "Make this" leads: a native create flow, a lock with its reason, or nowhere this person may go. */
export type DescribeItDoor =
    | { state: 'open'; target: OpenTarget }
    | { state: 'locked'; reason: LockReason }
    | { state: 'unavailable' };

const NO_DOOR: DescribeItDoor = { state: 'unavailable' };

/**
 * The door for a kind, for this person. `sections` is what the New menu is
 * built from (gate-passing plus locked); `available` the server's list, or
 * null when it sent none — then the sections alone decide.
 */
export function doorForKind(
    kind: KindKey,
    sections: readonly ResolvedSection[],
    available: readonly KindKey[] | null,
): DescribeItDoor {
    const section = sectionForKind(kind);
    if (!section?.create) return NO_DOOR;
    const row = sections.find((s) => s.id === section.id);
    if (row?.locked) return { state: 'locked', reason: row.locked };
    if (!row?.create) return NO_DOOR;
    if (available && !available.includes(kind)) return NO_DOOR;
    return { state: 'open', target: plainTarget(row.create.target) };
}

import type { RouteResult } from './routeApi';
import type { destinationForKind, NavRow } from './handoff';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type React from 'react';

/**
  * "Describe it — AI picks the building blocks" (Track H4, v1).
  *
  * One component, two wrappers: `variant='inline'` is the card in the header of
  * the Start screen (replacing the placeholder), `variant='modal'` the same card
  * in a dialog, opened from the AI line of the "New" menu. Two entrances, one
  * screen: otherwise there will soon be two AI fields that answer differently.
  *
  * Three states and nothing in between:
  *
  *   1. EMPTY   the field with the example sentence from the artboard; the send
  *              button is off as long as nothing is typed.
  *   2. BUSY    the field stays READABLE (you must be able to reread what you
  *              asked), the button is off, and cancel really aborts the request
  *              (AbortController) instead of discarding the answer.
  *   3. SCHEMA  "I'm making a <kind>: <name>" with the kind icon and the kind
  *              colour, the chosen building blocks below it.
  *
  * ── What this screen does NOT do ────────────────────────────────────────────
  *
  * The companions are SHOWN and NOT CREATED. Several kinds in one go (the linked
  * empty shells) is H4b and waits for K8; a row that says "and also a knowledge
  * base" while nothing is created is a lie, so it says so literally.
  *
  * It also never silently falls back to a kind. An unusable answer
  * (`undecided`) is an ERROR with a request to describe it more concretely,
  * not
  * "well, then an automation".
  *
  * ── Honesty about what is left of the card ──────────────────────────────────
  *
  * The heading promises two things, "a <kind>" and "named <name>", and the brief
  * below it promises a third. None of the three travels along by itself, and the
  * screen says per promise separately whether it arrives (handoff.js keeps the
  * two tables):
  *
  *   `dest.seedable === false`   → the brief is visible below, with a copy
  *                                 button and one sentence about where to paste
  *                                 it. Today that is EVERY kind.
  *   `dest.carriesName === false`→ one sentence that the name does not travel
  *                                 yet. That is no detail: for form, skill and
  *                                 kb a row IS CREATED, under "Untitled form" /
  *                                 "Untitled skill" / "New knowledge base",
  *                                 right after this card named something else.
  *
  * One flag for both was the first version of this, and it lied: automation
  * carried the name, so it was `seedable: true`, so the brief block vanished
  * exactly there, on the most likely route of this screen.
  *
  * ── What could not be read is on the card ───────────────────────────────────
  *
  * `undecided` are the kinds whose gate the server could NOT read. Those kinds
  * were not in the model's vocabulary, so the answer was chosen from a narrower
  * list than normal, and without a word about that, a malfunction looks like a
  * confident plan. So the card says it, just as AttentionList
  * ("Not checked: …")
  * and RecentWorkList do.
  *
  * ── The second brake ────────────────────────────────────────────────────────
  *
  * If the chosen kind is locked for this reader or absent from `sections`, the
  * card shows the lock hint and there is no active button. The server should
  * not return such a kind anyway; this brake exists because "should not"
  * and "cannot"
  * are two different things.
 */

/** A router answer that picked a kind, with the brief filled in. */
export type RoutePlan = Omit<Extract<RouteResult, { ok: true }>, 'kind'> & { kind: string };

/** Where a kind leads: a door that opens, or a sign that says why not. */
export type Destination = ReturnType<typeof destinationForKind>;

export interface BlockRowProps {
    t: TranslateFn;
    kind: string;
    name: string;
    note: string | null;
}

/**
  * The caveats under the building blocks: what does NOT travel along from this
  * card, and what the server could not check. Separate from PlanCard because
  * they are three independent sentences that each have their own condition, and
  * because a reader who comes to check "what does this screen over-promise" finds
  * them together here.
 */
export interface PlanCaveatsProps {
    plan: RoutePlan;
    dest: Destination | null;
    t: TranslateFn;
    blocked: boolean;
    copied: boolean;
    onCopy: React.MouseEventHandler<HTMLButtonElement>;
}

/**
  * The schema card: "I'm making a <kind>: <name>", the chosen building blocks and
  * the two buttons. Separate from the input field because it is a different screen
  * with a different question ("is this right?" instead of "what do you want?").
 */
export interface PlanCardProps {
    plan: RoutePlan;
    dest: Destination | null;
    blocked: boolean;
    busyRun: boolean;
    copied: boolean;
    errorLine: string | null;
    onConfirm: () => Promise<void>;
    onBack: () => void;
    onCopy: () => Promise<void>;
    t: TranslateFn;
}

export interface PanelBodyProps {
    sections: NavRow[] | null | undefined;
    onNavigate?: ((target: string) => void) | null;
    user?: unknown;
    onClose?: (() => void) | null;
}

export interface DescribeItPanelProps {
    sections: NavRow[] | null | undefined;
    onNavigate?: ((target: string) => void) | null;
    user?: unknown;
    onClose?: (() => void) | null;
    variant?: string;
    open?: boolean;
}

/**
 * One card for everything that waits for the owner of a task, on the home's "Needs you" list now and inside the
 * opened task (`solo`). The kinds (./coworkNeedsModel.ts builds them from what the server says):
 *
 *   check        the steps are ready and tested: check them (home), or approve them / try them now (in the task)
 *   first_test   added from a template or a package and never tested: test it now, or remove it
 *   fix          the steps or the last run went wrong: Cowork's fix of the order of the steps ("Fix it for me",
 *                POST /:id/plan/fix-wiring), check the steps, run it again, or let the AI do it each time
 *   repair       a fix Cowork worked out after the steps kept failing: approve it, or not now
 *   sign_in      an app's sign-in ran out: sign in again, then turn the task back on
 *   send         a message waits for the owner's OK: send it or not, then "always allow this recipient?"
 *   review       the agent asks to look at something: approve, or ask for changes with a note
 *   hand_off     a colleague's task asks for the result of this one: allow it, or not now
 *   invitation   a colleague invited the task to their desk: accept or decline
 *
 * Each card says ONE plain sentence and has ONE primary action that resolves it and a secondary way out
 * (./CoworkNeedFrame.tsx); the per-kind cards are ./CoworkNeedKinds.tsx and ./CoworkNeedAsks.tsx.
 */
import type { ComponentType } from 'react';
import { RepairCard, ReviewCard, SendCard } from './CoworkNeedAsks';
import type { NeedKindProps, TaskFocus } from './CoworkNeedFrame';
import { CheckCard, FirstTestCard, FixCard, HandOffCard, InvitationCard, SignInCard } from './CoworkNeedKinds';
import type { NeedCardData, NeedCardKind } from './coworkNeedsModel';

const CARDS: Readonly<Record<NeedCardKind, ComponentType<NeedKindProps>>> = {
    check: CheckCard,
    first_test: FirstTestCard,
    fix: FixCard,
    repair: RepairCard,
    sign_in: SignInCard,
    send: SendCard,
    review: ReviewCard,
    hand_off: HandOffCard,
    invitation: InvitationCard,
};

export interface CoworkNeedCardProps {
    need: NeedCardData;
    /** Inside the opened task: no task name, a tinted card, and the in-task actions (approve the steps there). */
    solo?: boolean;
    /** Open the task the card is about, at its steps for a plan to check or fix. */
    onOpenTask?: (itemId: string, focus?: TaskFocus) => void;
    /** After an action worked: one sentence that says what happened. */
    onDone?: (message: string) => void;
}

const nothing = () => {};

export default function CoworkNeedCard({ need, solo = false, onOpenTask = nothing, onDone = nothing }: CoworkNeedCardProps) {
    const Card = CARDS[need.kind];
    return <Card need={need} solo={solo} onOpenTask={onOpenTask} onDone={onDone} />;
}

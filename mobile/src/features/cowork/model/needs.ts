/**
 * What one "Waiting for you" entry says, and where a tap goes: a decision of a plan run is made in the approvals
 * inbox, anything else opens its item. The keys are the server catalogue's (cowork_needs.*), shared with the web.
 */

import type { TranslateFn } from '@/core/i18n';

import type { CoworkNeed } from './types';

type Sentence = readonly [string, string];

const FIRST_PLAN: Sentence = ['cowork_needs.plan.first', 'Its plan waits for your approval.'];

/** [catalogue key, English], by kind; a plan by where it stands. */
const SENTENCES: Readonly<Record<string, Sentence>> = {
    decision: ['cowork_needs.decision', 'A step waits for your decision.'],
    review: ['cowork_needs.review', 'The agent asks you to look at something.'],
    sign_in: ['cowork_needs.sign_in', 'An app needs you to sign in again. It paused itself.'],
    incomplete: ['cowork_resolver.need.incomplete', 'Did not do its work last time: a step found nothing to work on.'],
    ai_failed: ['cowork_resolver.need.ai_failed', 'The AI said its last run failed.'],
    // The same sentences the morning mail uses (server/jobs/coworkDailyMail.mts).
    repair: ['cowork_proposals.need.mail', 'Cowork worked out a fix for its plan. It changes nothing until you approve it.'],
    setup: ['cowork_home.mail.setup', 'Cowork could not set up its steps. It waits until you choose what to do.'],
    failed: ['cowork_home.mail.failed', 'Its last run failed. Open it to see what is wrong.'],
    'plan:first': FIRST_PLAN,
    'plan:changed': ['cowork_needs.plan.changed', 'The plan changed and may do more than you approved. Approve it again.'],
    'plan:blocked': ['cowork_needs.plan.blocked', 'The plan cannot run as it is.'],
    'plan:gone': ['cowork_needs.plan.gone', 'The automation of its plan is gone.'],
};

export function needSentence(need: CoworkNeed, t: TranslateFn): string {
    const key = need.kind === 'plan' ? `plan:${need.plan ?? 'first'}` : need.kind;
    const [k, en] = SENTENCES[key] ?? FIRST_PLAN;
    return t(k, en);
}

/** The screen a tap opens. */
export function needRoute(need: CoworkNeed): string {
    return need.kind === 'decision' ? '/approvals' : `/cowork/${encodeURIComponent(need.itemId)}`;
}

// The words of one "Needs you" entry (./CoworkNeedsYou.tsx): what waits, and where the owner acts on it.
import type { TranslateFn } from '../../hooks/useTranslation';
import type { CoworkNeed } from '../../api/coworkNeedsYou';

/** Where the entry's button goes: the item itself, or Approvals for a decision of a plan run. */
type NeedAction = 'open' | 'approvals';

export interface NeedWords {
    line: string;
    detail: string | null;
    action: NeedAction;
    button: string;
}

const APPROVALS_LINK = '/app/studio/approvals';
export const approvalsLink = (): string => APPROVALS_LINK;

function planLine(need: CoworkNeed, t: TranslateFn): string {
    switch (need.plan) {
        case 'changed': return t('cowork_needs.plan.changed', 'The plan changed and may do more than you approved. Approve it again.');
        case 'blocked': return t('cowork_needs.plan.blocked', 'The plan cannot run as it is.');
        case 'gone': return t('cowork_needs.plan.gone', 'The automation of its plan is gone.');
        default: return t('cowork_needs.plan.first', 'Its plan waits for your approval.');
    }
}

/** The sentence, the detail (a reason, when there is one) and the button of one entry. */
export function needWords(need: CoworkNeed, t: TranslateFn): NeedWords {
    const open = t('cowork_needs.open', 'Open');
    switch (need.kind) {
        case 'decision':
            return { line: t('cowork_needs.decision', 'A step waits for your decision.'), detail: null, action: 'approvals', button: t('cowork_needs.to_approvals', 'Decide in Approvals') };
        case 'review':
            return { line: t('cowork_needs.review', 'The agent asks you to look at something.'), detail: need.reason, action: 'open', button: open };
        case 'sign_in':
            return { line: t('cowork_needs.sign_in', 'An app needs you to sign in again. It paused itself.'), detail: null, action: 'open', button: open };
        default:
            return { line: planLine(need, t), detail: need.reason, action: 'open', button: t('cowork_needs.see_plan', 'See the plan') };
    }
}

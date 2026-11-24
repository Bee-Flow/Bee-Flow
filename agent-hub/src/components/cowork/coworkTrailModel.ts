/**
 * How one entry of an item's trail reads: "You changed the schedule", "Someone else switched it off". Pure.
 */
import type { TranslateFn } from '../../hooks/useTranslation';
import type { TrailEntry } from '../../api/coworkTrail';

const ACTION_FALLBACK: Record<string, string> = {
    'cowork.created': 'created this work',
    'cowork.updated': 'changed {what}',
    'cowork.toggled': 'switched it {state}',
    'cowork.deleted': 'deleted it',
    'cowork.plan_attached': 'chose the automation of its plan',
    'cowork.plan_approved': 'approved the plan',
    'cowork.plan_removed': 'took the plan off',
    'cowork.plan_made': 'had Cowork make a plan',
    'cowork.review_handled': 'handled a review',
    'cowork.independence_set': 'chose how independent it may be: {level}',
    'cowork.handed_over': 'handed it over to a colleague',
    'cowork.start_set': 'changed how it starts',
    'cowork.trust_set': 'changed what may go on its own',
    'cowork.shares_set': 'changed who it is shared with',
    'cowork.goal_set': 'set its goal',
    'cowork.goal_check_approved': 'approved the check of its goal',
    'cowork.goal_removed': 'took its goal off',
    'cowork.desk_joined': 'put it on a desk',
    'cowork.desk_accepted': 'accepted it on a desk',
    'cowork.desk_role_set': 'chose which desk role decides its questions',
    'cowork.desk_left': 'took it off a desk',
    'cowork.desk_hand_off_allowed': 'let it receive the result of the cowork it starts after',
    'cowork.desk_hand_off_withdrawn': 'stopped sending it the result of the cowork it starts after',
};

const FIELD_FALLBACK: Record<string, string> = {
    title: 'the title', prompt: 'the brief', isActive: 'whether it runs', repeatInterval: 'the schedule', daysOfWeek: 'the schedule',
    timeOfDay: 'the schedule', timezone: 'the time zone', nextRunAt: 'the next run', modelTier: 'the model', agentId: 'the agent',
    enabledApps: 'the apps', triggerKind: 'what starts it', trigger: 'what starts it', monthlyBudget: 'the budget',
    automationId: 'the automation', fingerprint: 'the plan', version: 'the plan version', action: 'how the review was handled',
    level: 'how independent it may be', toUserId: 'who it belongs to', kind: 'what starts it', stepId: 'a step',
    trusted: 'what may go on its own', answer: 'the answer', sentence: 'the goal', targetPercent: 'the target of the goal',
    deskRole: 'the desk role', shares: 'who it is shared with',
};

const LEVEL_FALLBACK: Record<string, string> = {
    asks_everything: 'asks about everything', asks_before_sending: 'asks before sending', on_its_own: 'on its own',
};

/** The fields a change touched, in words, each once. */
export function changedWords(changed: string[], t: TranslateFn): string {
    const words: string[] = [];
    for (const field of changed) {
        const word = t(`cowork_trail.field.${field}`, FIELD_FALLBACK[field] ?? field);
        if (!words.includes(word)) words.push(word);
    }
    return words.length > 0 ? words.join(', ') : t('cowork_trail.field.something', 'something');
}

/** One entry as a sentence. */
export function trailLine(entry: TrailEntry, t: TranslateFn): string {
    const who = entry.byYou ? t('cowork_trail.you', 'You') : t('cowork_trail.someone', 'Someone else');
    const fallback = ACTION_FALLBACK[entry.action] ?? entry.action.replace(/^cowork\./, '').replaceAll('_', ' ');
    const state = entry.values.isActive === false ? t('cowork_trail.off', 'off') : t('cowork_trail.on', 'on');
    const level = typeof entry.values.level === 'string' ? t(`cowork_trail.level.${entry.values.level}`, LEVEL_FALLBACK[entry.values.level] ?? entry.values.level) : '';
    const what = t(`cowork_trail.action.${entry.action.replace(/^cowork\./, '')}`, fallback, { what: changedWords(entry.changed, t), state, level });
    return `${who} ${what}`;
}

/**
 * How one entry of a task's change history reads: "You changed the schedule", "Someone else switched it off". Pure.
 */
import type { TranslateFn } from '../../hooks/useTranslation';
import type { TrailEntry } from '../../api/coworkTrail';

const ACTION_FALLBACK: Record<string, string> = {
    'cowork.created': 'created this task',
    'cowork.deleted': 'deleted it',
    'cowork.desk_accepted': 'accepted it for working together',
    'cowork.desk_hand_off_allowed': 'let it receive each result of the task it starts after',
    'cowork.desk_hand_off_withdrawn': 'stopped sending it each result of the task it starts after',
    'cowork.desk_joined': 'added it to working together',
    'cowork.desk_left': 'took it out of working together',
    'cowork.desk_role_set': 'chose who decides its questions',
    'cowork.goal_check_approved': 'approved the check of its target',
    'cowork.goal_removed': 'removed its target',
    'cowork.goal_set': 'set its target',
    'cowork.handed_over': 'gave it away to a colleague',
    'cowork.independence_set': 'chose when it asks first: {level}',
    'cowork.plan_approved': 'approved the steps',
    'cowork.plan_attached': 'chose existing steps for it',
    'cowork.plan_auto_fixed': 'fixed a step that was reading the wrong field (Cowork did this by itself; it can be undone)',
    'cowork.plan_made': 'had Cowork work out the steps',
    'cowork.plan_removed': 'took the fixed steps off',
    'cowork.plan_wiring_fixed': 'fixed the order of the steps (Cowork did this by itself; it can be undone)',
    'cowork.review_handled': 'answered a question',
    'cowork.shares_set': 'changed who it is shared with',
    'cowork.start_set': 'changed when it starts',
    'cowork.toggled': 'switched it {state}',
    'cowork.trust_set': 'changed what may be sent without asking',
    'cowork.updated': 'changed {what}',
};

const FIELD_FALLBACK: Record<string, string> = {
    action: 'how the question was answered',
    agentId: 'the agent',
    answer: 'the answer',
    automationId: 'the steps',
    daysOfWeek: 'the schedule',
    deskRole: 'who decides its questions',
    enabledApps: 'the apps',
    fingerprint: 'the steps',
    isActive: 'whether it runs',
    kind: 'what starts it',
    level: 'when it asks first',
    modelTier: 'the model',
    monthlyBudget: 'the spending limit',
    nextRunAt: 'the next run',
    prompt: 'the sentence',
    proof: 'how it was tested',
    repeatInterval: 'the schedule',
    sentence: 'the target',
    shares: 'who it is shared with',
    stepId: 'a step',
    targetPercent: 'the percentage of the target',
    timeOfDay: 'the schedule',
    timezone: 'the time zone',
    title: 'the name',
    toUserId: 'who it belongs to',
    trigger: 'what starts it',
    triggerKind: 'what starts it',
    trusted: 'what may be sent without asking',
    version: 'the version of the steps',
    wiring: 'the order of the steps',
};

const LEVEL_FALLBACK: Record<string, string> = {
    asks_before_sending: 'shows each message first',
    asks_everything: 'asks before every change or message',
    on_its_own: 'does not ask',
};

/** The fields a change touched, in words, each once. */
export function changedWords(changed: string[], t: TranslateFn): string {
    const words: string[] = [];
    for (const field of changed) {
        const word = t(`cowork_trail.part.${field}`, FIELD_FALLBACK[field] ?? field);
        if (!words.includes(word)) words.push(word);
    }
    return words.length > 0 ? words.join(', ') : t('cowork_trail.part.something', 'something');
}

/** One entry as a sentence. */
export function trailLine(entry: TrailEntry, t: TranslateFn): string {
    const who = entry.byCowork ? t('cowork_trail.cowork', 'Cowork') : entry.byYou ? t('cowork_trail.you', 'You') : t('cowork_trail.someone', 'Someone else');
    const fallback = ACTION_FALLBACK[entry.action] ?? entry.action.replace(/^cowork\./, '').replaceAll('_', ' ');
    const state = entry.values.isActive === false ? t('cowork_trail.off', 'off') : t('cowork_trail.on', 'on');
    const level = typeof entry.values.level === 'string' ? t(`cowork_trail.asks.${entry.values.level}`, LEVEL_FALLBACK[entry.values.level] ?? entry.values.level) : '';
    // A switch recorded without where it ended (the request that flips it carries no state): say so, rather than "on" for a pause.
    if (entry.action === 'cowork.toggled' && typeof entry.values.isActive !== 'boolean') return `${who} ${t('cowork_trail.did.toggled_either', 'paused or resumed it')}`;
    const what = t(`cowork_trail.did.${entry.action.replace(/^cowork\./, '')}`, fallback, { what: changedWords(entry.changed, t), state, level });
    return `${who} ${what}`;
}

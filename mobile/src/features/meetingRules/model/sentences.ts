/**
 * The rule card's sentences, in the web's words (agent-hub RulesPanel.jsx:
 * conditionSentence, consequenceParts, runLabel, licenceMessage and the
 * state chip). The facts come from rules.ts; this only phrases them.
 */

import type { TranslateFn } from '@/core/i18n';

import { runCountOf, type Consequences, type TriggerCondition } from './rules';

/** "When a meeting tagged sales is finished" — the IF half. */
export function conditionSentence(condition: TriggerCondition | null, t: TranslateFn): string {
    if (!condition) return t('meetings.rules_when_unknown', 'This rule no longer starts on a meeting note');
    if (!condition.onlyProcessed) {
        const events = condition.events.filter(Boolean);
        return events.length
            ? t('meetings.rules_when_event', 'When meeting notes fire {event}', { event: events.join(', ') })
            : t('meetings.rules_when_event_unknown', 'When meeting notes fire an event this card cannot name');
    }
    const tags = condition.tags;
    if (!tags.length) return t('meetings.rules_when_any', 'When any meeting note is finished');
    return tags.length === 1
        ? t('meetings.rules_when_tagged', 'When a meeting tagged {tags} is finished', { tags: tags.join(', '), count: 1 })
        : t('meetings.rules_when_tagged_plural', 'When a meeting tagged any of {tags} is finished', {
              tags: tags.join(', '),
              count: tags.length,
          });
}

function counted(t: TranslateFn, count: number, one: [string, string], many: [string, string]): string {
    return count === 1 ? t(one[0], one[1], { count }) : t(many[0], many[1], { count });
}

/** The THEN half, as parts the card joins with " · ". Never silent about what it cannot name. */
export function consequenceParts(consequences: Consequences, t: TranslateFn): string[] {
    if (!consequences.readable) return [t('meetings.rules_steps_unreadable', 'its steps could not be read')];
    const parts: string[] = [];
    if (consequences.kb) parts.push(t('meetings.rules_does_kb', 'files it in a knowledge base'));
    if (consequences.notify) parts.push(t('meetings.rules_does_notify', 'sends a notification'));
    if (consequences.table) parts.push(t('meetings.rules_does_table', 'writes a row to a datatable'));
    if (consequences.other > 0) {
        parts.push(
            counted(
                t,
                consequences.other,
                ['meetings.rules_does_other', '{count} more step this card cannot describe'],
                ['meetings.rules_does_other_plural', '{count} more steps this card cannot describe'],
            ),
        );
    }
    if (parts.length) return parts;
    if (consequences.steps > 0) {
        return [
            counted(
                t,
                consequences.steps,
                ['meetings.rules_does_internal', '{count} step that only prepares data — nothing leaves the run'],
                ['meetings.rules_does_internal_plural', '{count} steps that only prepare data — nothing leaves the run'],
            ),
        ];
    }
    return [t('meetings.rules_does_nothing', 'nothing yet — this rule has no steps')];
}

/** What narrows the rule beyond its sentence. */
export function narrowingParts(condition: TriggerCondition | null, t: TranslateFn): string[] {
    const parts: string[] = [];
    if (condition?.reprocessed === true) {
        parts.push(t('meetings.trigger_reprocessed_again', 'Only a reprocess or a new summary'));
    } else if (condition?.reprocessed === false) {
        parts.push(t('meetings.trigger_reprocessed_first', 'Only a brand-new note'));
    }
    if (condition?.extra) {
        parts.push(t('meetings.rules_extra_conditions', 'narrowed further by conditions this card cannot show'));
    }
    return parts;
}

/**
 * The run line: the READER's runs over the window, or null when they could
 * not be counted — never a 0 that is really an unknown.
 */
export function runLabel(facets: unknown, automationId: string, hours: number, t: TranslateFn): string | null {
    const n = runCountOf(facets, automationId);
    if (n === null) return null;
    if (n === 0) return t('meetings.rules_runs_none', 'no runs of yours in the last {hours} hours', { hours });
    return n === 1
        ? t('meetings.rules_runs_mine', '{count} run of yours in the last {hours} hours', { count: n, hours })
        : t('meetings.rules_runs_mine_plural', '{count} runs of yours in the last {hours} hours', { count: n, hours });
}

export type RuleState = 'live' | 'draft' | 'paused';

/** Draft wins over active, as the web's shared status vocabulary has it. Null when the row does not say. */
export function ruleState(row: { isActive?: boolean | null; isDraft?: boolean | null }): RuleState | null {
    if (typeof row.isActive !== 'boolean' && typeof row.isDraft !== 'boolean') return null;
    if (row.isDraft) return 'draft';
    return row.isActive ? 'live' : 'paused';
}

const LICENCE_TOKENS = new Set(['feature_locked', 'tier_required', 'license_required', 'licence_required']);

/**
 * The licence gate answers in machine tokens (`feature_locked`), not prose;
 * shown raw they read as a bug. Null when this is not a licence refusal.
 */
export function licenceMessage(error: { message?: string; status?: number; code?: string } | null, t: TranslateFn) {
    if (!error) return null;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- the only regex below, \blicen[cs]e\b|\bforbidden\b, has no nested or overlapping quantifier, so it runs in linear time
    const message = String(error.message ?? '').trim();
    const locked =
        LICENCE_TOKENS.has(message) ||
        LICENCE_TOKENS.has(String(error.code ?? '')) ||
        error.status === 402 ||
        error.status === 403 ||
        /\blicen[cs]e\b|\bforbidden\b/i.test(message);
    return locked
        ? t('meetings.rules_not_licensed', 'Automations are not part of this plan, so a rule cannot be made here.')
        : null;
}

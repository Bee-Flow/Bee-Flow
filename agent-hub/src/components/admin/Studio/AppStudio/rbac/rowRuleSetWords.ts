import { describeRowRule } from './rowRuleModel';
import { draftToRule } from './rowRuleSet';
import type { RuleSet } from './rowRuleSet';
import type { AccessEntry, RuleTable } from './rowRuleModel.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * With a rule per action: what the rules for changing and deleting come to, one
 * sentence each. Seeing is describeAccessOutcome's sentence, fed with the rule
 * for seeing. An action the role may not do at all gets no sentence: there is
 * nothing for a rule to narrow.
 */

const WORDS = {
    update: {
        where: ['studio_apps_rowrules.outcome_update_where', 'They can change only the rows where {summary}.'],
        rule: ['studio_apps_rowrules.outcome_update_rule', 'They can change only the rows matching the rule written for changing.'],
        free: ['studio_apps_rowrules.outcome_update_free', 'No row rule narrows which rows they can change.'],
    },
    delete: {
        where: ['studio_apps_rowrules.outcome_delete_where', 'They can delete only the rows where {summary}.'],
        rule: ['studio_apps_rowrules.outcome_delete_rule', 'They can delete only the rows matching the rule written for deleting.'],
        free: ['studio_apps_rowrules.outcome_delete_free', 'No row rule narrows which rows they can delete.'],
    },
} as const;

export function describeActionRules(ruleSet: RuleSet, entry: AccessEntry, table: RuleTable | null, t: TranslateFn): string[] {
    if (!ruleSet.perAction || entry.read === 'none') return [];
    const lines: string[] = [];
    for (const action of ['update', 'delete'] as const) {
        if (entry[action] === 'none') continue;
        const draft = ruleSet[action];
        const words = WORDS[action];
        if (!draftToRule(draft).trim()) { lines.push(t(words.free[0], words.free[1])); continue; }
        const summary = draft.mode === 'build' ? describeRowRule(draft, table, t) : '';
        lines.push(summary ? t(words.where[0], words.where[1], { summary }) : t(words.rule[0], words.rule[1]));
    }
    return lines;
}

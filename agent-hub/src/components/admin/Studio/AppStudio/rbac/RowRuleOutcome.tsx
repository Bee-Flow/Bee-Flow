import { describeAccessOutcome, describeRowRule } from './rowRuleModel';
import { draftToRule } from './rowRuleSet';
import type { RuleSet } from './rowRuleSet';
import { describeActionRules } from './rowRuleSetWords';
import type { AccessEntry, RuleTable } from './rowRuleModel.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * What the role ends up with, in sentences: which rows it sees (the base access
 * and the rule for seeing), what it may write, and with a rule per action what
 * the rules for changing and deleting come to.
 */

interface RowRuleOutcomeProps {
    t: TranslateFn;
    ruleSet: RuleSet;
    access: AccessEntry;
    table: RuleTable | null;
    roleLabel: string;
    tableName: string;
}

export default function RowRuleOutcome({ t, ruleSet, access, table, roleLabel, tableName }: RowRuleOutcomeProps) {
    // Seeing follows the rule for seeing; changing and deleting get their own sentences.
    const readDraft = ruleSet.perAction ? ruleSet.read : ruleSet.all;
    const outcome = describeAccessOutcome({
        entry: access,
        roleLabel,
        tableName,
        hasRule: ruleSet.kept || !!draftToRule(readDraft).trim(),
        ruleSummary: readDraft.mode === 'build' ? describeRowRule(readDraft, table, t) : '',
        t,
    });
    return (
        <div
            data-testid="row-rule-outcome"
            className="rounded-md border px-3 py-2 text-xs border-[var(--border-subtle)] bg-[var(--bg-tertiary)]"
        >
            <p className="text-[var(--text-primary)]">{outcome.sees}</p>
            {outcome.writes ? (
                <p className="mt-1 text-[var(--text-secondary)]">{outcome.writes}</p>
            ) : null}
            {describeActionRules(ruleSet, access, table, t).map((line) => (
                <p key={line} className="mt-1 text-[var(--text-secondary)]">{line}</p>
            ))}
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">{outcome.owner}</p>
        </div>
    );
}

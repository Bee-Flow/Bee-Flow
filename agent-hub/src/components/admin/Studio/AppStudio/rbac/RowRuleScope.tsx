import SegmentedControl from '@/components/shared/SegmentedControl';
import type { TranslateFn } from '@/hooks/useTranslation';
import { RULE_ACTIONS, draftToRule } from './rowRuleSet';
import type { RuleAction, RuleSet } from './rowRuleSet';

/**
 * Which actions a row rule covers: one rule for seeing, changing and deleting
 * (what a rule has always been), or a rule per action. With a rule per action
 * the second strip picks the action whose rule is on screen.
 */

const ACTION_LABELS: Record<RuleAction, [string, string]> = {
    read: ['studio_apps_rowrules.action_read', 'Seeing'],
    update: ['studio_apps_rowrules.action_update', 'Changing'],
    delete: ['studio_apps_rowrules.action_delete', 'Deleting'],
};

export function ruleActionLabel(action: RuleAction, t: TranslateFn): string {
    return t(ACTION_LABELS[action][0], ACTION_LABELS[action][1]);
}

interface RowRuleScopeProps {
    t: TranslateFn;
    ruleSet: RuleSet;
    action: RuleAction;
    disabled: boolean;
    onPerAction: (perAction: boolean) => void;
    onAction: (action: RuleAction) => void;
}

export default function RowRuleScope({ t, ruleSet, action, disabled, onPerAction, onAction }: RowRuleScopeProps) {
    const appliesLabel = t('studio_apps_rowrules.applies_label', 'The rule applies to');
    const actionLabel = t('studio_apps_rowrules.action_label', 'Rule for');
    return (
        <div data-testid="row-rule-scope" className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-[var(--text-secondary)]">{appliesLabel}</span>
                <SegmentedControl
                    size="sm"
                    ariaLabel={appliesLabel}
                    disabled={disabled}
                    value={ruleSet.perAction ? 'each' : 'all'}
                    onChange={(value) => onPerAction(value === 'each')}
                    options={[
                        { value: 'all', label: t('studio_apps_rowrules.applies_all', 'Seeing, changing and deleting') },
                        { value: 'each', label: t('studio_apps_rowrules.applies_each', 'A rule per action') },
                    ]}
                />
            </div>
            {ruleSet.perAction ? (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-[var(--text-secondary)]">{actionLabel}</span>
                        <SegmentedControl
                            size="sm"
                            ariaLabel={actionLabel}
                            disabled={disabled}
                            value={action}
                            onChange={onAction}
                            options={RULE_ACTIONS.map((a) => ({
                                value: a,
                                label: draftToRule(ruleSet[a]).trim()
                                    ? t('studio_apps_rowrules.action_with_rule', '{action} (rule set)', { action: ruleActionLabel(a, t) })
                                    : ruleActionLabel(a, t),
                            }))}
                        />
                    </div>
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                        {t('studio_apps_rowrules.each_hint', 'Each action can have its own rule. Changing or deleting without one follows the rule for seeing.')}
                    </span>
                </>
            ) : null}
        </div>
    );
}

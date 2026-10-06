/**
 * What Simple mode shows instead of a formula box: a rule the clickable rows
 * cannot show (written by hand in Advanced, or by an older version) reads as
 * a card naming the FIELDS it reads, never its code, with a way back to
 * clicking. The formula itself is edited in Advanced only.
 */
import { formatPath, parsePath } from '@shared/expr/path.mjs';
import { useMemo } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { humanizeFieldTail } from '../flow/displayHelpers';
import { cardClass, INLINE_LINK } from '../flow/settings/formStyles';
import { listPathLabel } from './listPathLabel';
import { scanExprPaths } from './refTokens';
import { useVariablePickerContext } from './VariablePickerContext';

const ROOTS = ['item', 'steps', 'trigger', 'loop'];

type StepLabels = Pick<Map<string, string>, 'get'> | null | undefined;

/**
 * A field of the current item the way the rows and the canvas name it, from
 * the path after `item` (`fields["Story Points"]` → its tail, as the pills
 * read it); anything else by its list label.
 */
function fieldName(path: string, stepLabelById: StepLabels, stepTypeById: StepLabels): string {
    const tokens = parsePath(path) as Array<{ key?: unknown }> | null;
    if (tokens?.[0]?.key === 'item') {
        return tokens.length > 1 ? humanizeFieldTail(formatPath(tokens.slice(1))) : '';
    }
    return listPathLabel(path, stepLabelById, null, { stepTypeById });
}

/** The distinct field names an expression reads, in the order it reads them. */
export function customRuleFieldNames(expr: string, stepLabelById: StepLabels = null, stepTypeById: StepLabels = null): string[] {
    const names: string[] = [];
    for (const part of scanExprPaths(expr, ROOTS) as Array<{ path?: string }>) {
        const name = part.path ? fieldName(part.path, stepLabelById, stepTypeById) : '';
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

interface CustomRuleCardProps {
    expr: string;
    onRebuild: () => void;
}

export default function CustomRuleCard({ expr, onRebuild }: CustomRuleCardProps) {
    const { t } = useTranslation();
    const { stepLabelById, stepTypeById } = useVariablePickerContext() as { stepLabelById?: StepLabels; stepTypeById?: StepLabels };
    const fields = useMemo(() => customRuleFieldNames(expr, stepLabelById, stepTypeById), [expr, stepLabelById, stepTypeById]);
    return (
        <div className={cardClass()} data-testid="custom-rule-card">
            <div className="text-[11px] font-medium text-[var(--text-primary)]">
                {t('condition_node.custom.title', 'Custom rule')}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
                {t('condition_node.custom.body', 'This rule is written as a formula, so it can’t be shown as clickable rows here.')}
            </div>
            {fields.length > 0 && (
                <div className="text-[11px] text-[var(--text-secondary)]">
                    {t('condition_node.custom.reads', 'It reads: {fields}', { fields: fields.join(', ') })}
                </div>
            )}
            <button type="button" onClick={onRebuild} className={`text-[11px] ${INLINE_LINK}`}>
                {t('condition_node.custom.rebuild', 'Build it again by clicking')}
            </button>
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('condition_node.custom.advanced', 'To change the formula itself, switch to Advanced.')}
            </div>
        </div>
    );
}

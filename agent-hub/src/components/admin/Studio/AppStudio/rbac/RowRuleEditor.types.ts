import type { RuleCondition, RuleTable } from './rowRuleModel.types';

/** The picker's working copy of one rule: built from pickers, or kept as raw text. */
export interface RuleDraft {
    mode: 'build' | 'raw';
    join: string;
    conditions: RuleCondition[];
    raw: string;
}

/**
 * @param {{
 *   appId?: string | null,
 *   onDirtyChange?: ((dirty: boolean) => void) | null,
 * }} props Every prop may be left out; without an appId nothing is loaded.
 */
export interface RowRuleEditorProps {
    appId: string;
    onDirtyChange?: ((dirty: boolean) => void) | null;
}

/**
 * "Write it myself" — the expression itself. The chips insert a column or a
 * runtime value at the cursor so the exact spelling never has to be remembered.
 */
export interface RawRuleBoxProps {
    table: RuleTable | null;
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
    error: string | null | undefined;
}

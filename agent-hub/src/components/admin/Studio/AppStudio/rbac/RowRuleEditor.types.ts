import type { AccessEntry, RuleCondition } from './rowRuleModel';
import type { ModelTable } from '../tables/tablesManagerModel';

/** The editor's working copy: pickers (build) or the raw expression text. */
export interface RuleDraft {
    mode: 'build' | 'raw';
    join: string;
    conditions: RuleCondition[];
    raw: string;
}

/** What was last saved, to tell whether the editor has unsaved work. */
export interface SavedState {
    access: AccessEntry;
    rule: string;
}

/** A table or role switch the owner asked for. */
export interface SwitchPatch {
    tableId?: string;
    roleKey?: string;
}

export interface RowRuleEditorProps {
    appId: string | null;
    onDirtyChange?: ((dirty: boolean) => void) | null;
}

export interface RawRuleBoxProps {
    table: ModelTable | null;
    value: string;
    onChange: (raw: string) => void;
    disabled: boolean;
    error: string | null;
}

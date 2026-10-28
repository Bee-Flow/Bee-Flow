import type { RowFilterTable } from './rowFilterSubset';
import type { TranslateFn } from '@/hooks/useTranslation';

/** What one access action (read / create / update / delete) allows: a scope, or a yes/no for adding. */
export type AccessPerm = boolean | string;

/** The access a role has on a table, per action. */
export type AccessEntry = Record<string, AccessPerm>;

/** A table field as the rule pickers read it. */
interface RuleTableField {
    key: string;
    name?: string;
    type?: string;
    options?: Array<string | number | boolean>;
    computed?: { stored?: boolean } | null;
}

/** The data-model table a rule is written against. */
export interface RuleTable extends RowFilterTable {
    fields?: RuleTableField[];
    access?: { default?: string; roles?: Record<string, Record<string, AccessPerm>> };
}

/** One column a rule may name. */
export interface RuleField {
    key: string;
    name: string;
    type?: string;
    options?: Array<string | number | boolean>;
}

/** One pickable condition of a row rule. */
export interface RuleCondition {
    id: string;
    field: string;
    op: string;
    source: string;
    value: string | number | boolean;
    valueType: string;
}

/** A rule as the picker holds it: conditions joined by and / or. */
export interface RowRule {
    join?: string;
    conditions?: RuleCondition[];
}

export interface ParsedRowRule {
    ok: boolean;
    join: 'and' | 'or';
    conditions: RuleCondition[];
}

/** What describeAccessOutcome reads; every part is optional. */
export interface AccessOutcomeArgs {
    entry?: AccessEntry | null;
    t?: TranslateFn | null;
    roleLabel?: string;
    tableName?: string;
    hasRule?: boolean;
    ruleSummary?: string;
}

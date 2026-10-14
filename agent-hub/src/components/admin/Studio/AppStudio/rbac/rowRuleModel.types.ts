/** What a role may do with one table's rows: none, its own rows, or every row. */
export type Perm = 'none' | 'own' | 'all';

/** The four actions of one access entry. `create` is a plain yes/no. */
export interface AccessEntry {
    read: Perm;
    create: boolean;
    update: Perm;
    delete: Perm;
}

/** A column a rule may name. */
export interface RuleField {
    key: string;
    name: string;
    type?: string;
    options?: string[];
}

/** One picker condition: `field op source-or-value`. */
export interface RuleCondition {
    id: string;
    field: string;
    op: string;
    source: string;
    value: string | boolean;
    valueType: 'string' | 'number' | 'bool';
}

/** A rule read back into pickers. ok:false means "keep it as text". */
export interface ParsedRule {
    ok: boolean;
    join: 'and' | 'or';
    conditions: RuleCondition[];
}

/** A table as far as the rule model reads it. */
export interface RuleTable {
    fields?: RawField[];
    access?: unknown;
    name?: string;
    key?: string;
    id?: string;
}

/** A table field as stored: anything the rule model may need to check. */
export interface RawField {
    key?: unknown;
    name?: string;
    type?: string;
    options?: string[];
    computed?: { stored?: unknown } | null;
}

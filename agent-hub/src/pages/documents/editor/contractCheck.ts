// What the server refuses in a document's fields and rules
// (server/core/documents/documentContract.js normalizeContract), checked
// before saving, so a half-made field is shown next to itself instead of
// failing the whole save with one English sentence.

export type KeyProblem = 'missing' | 'unsafe' | 'duplicate';

interface FieldLike { key?: string; fields?: FieldLike[] }
interface RuleLike { all?: RuleLike[]; any?: RuleLike[]; parameter?: string }
interface ContractLike { parameters?: FieldLike[]; sections?: { condition?: RuleLike | null }[] }

const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The server's safePath: letters, digits, _ . and -, not starting with . or -, no empty or reserved part. */
export function isSafeKey(key: string): boolean {
    return SAFE.test(key) && key.split('.').every((part) => part && !RESERVED.has(part));
}

/** Per field (by position), what is wrong with its key; null when nothing. */
export function keyProblems(fields: readonly FieldLike[]): (KeyProblem | null)[] {
    const counts = new Map<string, number>();
    for (const f of fields) counts.set(f.key || '', (counts.get(f.key || '') || 0) + 1);
    return fields.map((f) => {
        const key = f.key || '';
        if (!key) return 'missing';
        if (!isSafeKey(key)) return 'unsafe';
        return (counts.get(key) || 0) > 1 ? 'duplicate' : null;
    });
}

/** True when a rule (or a rule in its group) does not say which value it checks. */
export function ruleIncomplete(rule: RuleLike | null | undefined): boolean {
    if (!rule) return false;
    const group = rule.all || rule.any;
    if (group) return group.some(ruleIncomplete);
    return !isSafeKey(rule.parameter || '');
}

/** True when the server would accept these fields and rules. */
export function contractSavable(contract: ContractLike): boolean {
    const fields = contract.parameters || [];
    if (keyProblems(fields).some(Boolean)) return false;
    if (fields.some((f) => keyProblems(f.fields || []).some(Boolean))) return false;
    return !(contract.sections || []).some((s) => ruleIncomplete(s.condition));
}

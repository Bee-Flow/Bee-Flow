/**
 * Customer values and contract edits — the pure half of the Customer preview
 * and Parameters tabs (the web's ValueInput, Parameter and Rule in
 * DocumentWorkspacePanel.jsx).
 */

import type { Condition, ContractParameter, ParamType, Rule } from './types';

type Row = Record<string, unknown>;

/** What a text input means for a parameter of this type; '' clears the value. */
export function coerceInput(type: ParamType, text: string): unknown {
    if (text === '') return undefined;
    if (type === 'number') {
        const n = Number(text.replace(',', '.'));
        return Number.isFinite(n) ? n : text;
    }
    return text;
}

/** A stored value as the text an input shows. */
export function inputText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/** A list parameter's rows, whatever was stored. */
export function listRows(value: unknown): Row[] {
    return Array.isArray(value) ? value.map((row) => (row && typeof row === 'object' ? (row as Row) : {})) : [];
}

export function setRowField(rows: readonly Row[], index: number, key: string, value: unknown): Row[] {
    return rows.map((row, i) => (i === index ? { ...row, [key]: value } : row));
}

export function removeAt<T>(items: readonly T[], index: number): T[] {
    return items.filter((_, i) => i !== index);
}

export function replaceAt<T>(items: readonly T[], index: number, next: T): T[] {
    return items.map((item, i) => (i === index ? next : item));
}

export interface ColumnTotal {
    key: string;
    label: string;
    total: number;
}

/**
 * The sum of every number field over a list's rows — the line-item totals of
 * an invoice or a quote. A convenience for the person filling it in: the
 * document prints the "total" parameter it was given, never this sum, so a
 * verified figure is always what a customer sees.
 */
export function columnTotals(fields: readonly ContractParameter[], rows: readonly Row[]): ColumnTotal[] {
    return fields
        .filter((f) => f.type === 'number')
        .map((f) => ({
            key: f.key,
            label: f.label || f.key,
            total: rows.reduce((sum, row) => {
                const v = row[f.key];
                return typeof v === 'number' && Number.isFinite(v) ? sum + v : sum;
            }, 0),
        }));
}

/** Round away binary noise (0.1 + 0.2) without deciding a currency. */
export function formatTotal(total: number): string {
    return String(Math.round(total * 1e6) / 1e6);
}

/** A new, empty parameter (the web's "Add parameter"). */
export function newParameter(): ContractParameter {
    return { key: '', type: 'text', label: '', summary: '', instructions: '', required: false };
}

/** Changing a type brings the pieces that type needs, as the web does. */
export function withType(p: ContractParameter, type: ParamType): ContractParameter {
    const next: ContractParameter = { ...p, type };
    if (type === 'choice') next.options = p.options?.length ? p.options : ['Option 1'];
    if (type === 'list') next.fields = p.fields ?? [];
    return next;
}

/** A fresh rule on a parameter, with the value its type starts from. */
export function ruleFor(parameter: ContractParameter | undefined, operator: Rule['operator'] = 'equals'): Rule {
    const value = parameter?.type === 'boolean' ? true : parameter?.type === 'number' ? 0 : '';
    return { parameter: parameter?.key ?? '', operator, value };
}

/** How many rules a condition holds, however it nests. */
export function ruleCount(condition: Condition | null): number {
    if (!condition) return 0;
    if ('parameter' in condition) return 1;
    return ('all' in condition ? condition.all : condition.any).reduce((n, c) => n + ruleCount(c), 0);
}

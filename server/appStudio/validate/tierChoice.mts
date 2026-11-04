/**
 * App Studio validator — modelTier on ai_generate / ai_extract: a tier name as
 * written, or a binding worked out per run ({kind:'formula',expr} /
 * {kind:'static',value}). A value that is not a tier name falls back to the
 * default tier at run time, with a note (actionExecutor/modelTierChoice.mts).
 * A tier name is checked exactly as the plain string field was.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { FORMULA_SCOPE_ROOTS } = nodeRequire('../componentSpecs') as { FORMULA_SCOPE_ROOTS: string[] };
const { validateFormula } = nodeRequire('./formulas') as { validateFormula: (expr: string, path: string, ctx: Ctx, roots: string[]) => void };

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateTierChoice(field: string, fs: { maxLen?: number }, value: unknown, path: string, ctx: Ctx): void {
    const { pushE } = ctx;
    const invalid = () => pushE({
        code: 'action.step_field_invalid', severity: 'error', path,
        message: `\`${field}\` is a tier name or {kind:"formula",expr}.`,
        hint: 'Use "fast", "standard" or "thinking", or a formula such as {"kind":"formula","expr":"params.quick ? \'fast\' : \'thinking\'"}.',
    });
    if (typeof value === 'string') {
        if (fs.maxLen && value.length > fs.maxLen) pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` is ${value.length} chars — the maximum is ${fs.maxLen}.`, hint: 'Shorten it.' });
        return;
    }
    if (!isObject(value)) { invalid(); return; }
    if (value.kind === 'formula') {
        if (typeof value.expr !== 'string' || !value.expr.trim()) { invalid(); return; }
        validateFormula(value.expr, `${path}.expr`, ctx, FORMULA_SCOPE_ROOTS);
        return;
    }
    if (value.kind === 'static' && typeof value.value === 'string') return;
    invalid();
}

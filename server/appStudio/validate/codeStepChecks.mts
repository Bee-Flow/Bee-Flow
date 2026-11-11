/**
 * App Studio validator — the rules of a `code` step (componentSpecs/steps/code.js) beyond its
 * field types: the source fits and parses, holds nothing the sandbox guard stops, names no bridge
 * an app's code step lacks; the inputs are at most MAX_CODE_STEP_INPUTS, each under a name the code
 * can read as inputs.<name>.
 *
 * What the code checker says about the source (a syntax error, a blocked pattern, ctx.http) is an
 * error when publishing and a warning on a draft save (dataRefsAsWarnings), so half-written code
 * still saves while someone types. Past the length ceiling is always an error. The binding of each
 * input is checked by the generic `recordValues` field check.
 */

import { createRequire } from 'node:module';

import { forbiddenBridges, isInputName } from '../codeStepRules.mts';
import type { CodeAnalysisLike } from '../codeStepRules.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; dataRefsAsWarnings?: boolean };
type Analysis = CodeAnalysisLike & { syntaxError?: { line: number; column: number; message: string } | null; findings?: Array<{ severity?: string; message?: string; line?: number }> };

const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as { LIMITS: { MAX_CODE_STEP_CHARS: number; MAX_CODE_STEP_INPUTS: number } };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function analyze(code: string): Analysis {
    const { analyzeCode } = nodeRequire('../../core/automationModel/codeSafety/index.js') as { analyzeCode: (c: string) => Analysis };
    return analyzeCode(code);
}

/** What the code checker objects to, as findings without a severity yet. */
function sourceFindings(code: string, path: string): Omit<Finding, 'severity'>[] {
    const a = analyze(code);
    if (!a.ok && a.syntaxError) {
        const e = a.syntaxError;
        return [{ code: 'action.code_syntax', path, message: `The code has a syntax error at line ${e.line}, column ${e.column}: ${e.message}`, hint: 'Fix the code; it does not run until it parses.' }];
    }
    const out: Omit<Finding, 'severity'>[] = [];
    const block = (a.findings || []).find((f) => f.severity === 'block');
    if (block) out.push({ code: 'action.code_blocked', path, message: `This code would be stopped: ${String(block.message)} (line ${String(block.line)})`, hint: 'Write the logic directly over inputs; no modules, no code built from text.' });
    const bridges = forbiddenBridges(a);
    if (bridges.length) out.push({ code: 'action.code_bridge', path, message: `A code step in an app has no network, integrations or database; this code uses ${bridges.join(', ')}.`, hint: 'Pass data in through inputs and write it with an ordinary step after this one that reads vars.<resultVar>.' });
    return out;
}

function checkSource(step: Obj, path: string, ctx: Ctx): void {
    const code = step.code;
    if (code === undefined || code === null) return; // the required-field check says it
    if (typeof code !== 'string') {
        ctx.pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}.code`, message: '`code` must be a string of JavaScript.', hint: 'Write `function main(inputs, ctx) { … }`.' });
        return;
    }
    if (code.length > LIMITS.MAX_CODE_STEP_CHARS) {
        ctx.pushE({ code: 'action.code_too_long', severity: 'error', path: `${path}.code`, message: `The code is ${code.length} characters; the most a code step holds is ${LIMITS.MAX_CODE_STEP_CHARS}.`, hint: 'Keep the step to one job, or do the simple parts with formulas.' });
        return;
    }
    if (!code.trim()) return;
    for (const f of sourceFindings(code, `${path}.code`)) {
        if (ctx.dataRefsAsWarnings) ctx.pushW({ ...f, severity: 'warning' });
        else ctx.pushE({ ...f, severity: 'error' });
    }
}

function checkInputs(step: Obj, path: string, ctx: Ctx): void {
    if (!isObject(step.inputs)) return; // the field check says what is wrong with a non-object
    const names = Object.keys(step.inputs);
    if (names.length > LIMITS.MAX_CODE_STEP_INPUTS) {
        ctx.pushE({ code: 'action.code_inputs_invalid', severity: 'error', path: `${path}.inputs`, message: `A code step takes at most ${LIMITS.MAX_CODE_STEP_INPUTS} inputs; this one has ${names.length}.`, hint: 'Pass a list or a record as one input instead of many single values.' });
    }
    for (const name of names) {
        if (isInputName(name)) continue;
        ctx.pushE({ code: 'action.code_inputs_invalid', severity: 'error', path: `${path}.inputs`, message: `Input name ${JSON.stringify(name.slice(0, 80))} cannot be read as inputs.<name>.`, hint: 'Use letters, digits and _ (not starting with a digit), at most 60 characters.' });
    }
}

/** The per-kind check of a `code` step (validate/stepKindChecks.js KIND_CHECKS). */
export function checkCodeStep(step: Obj, path: string, ctx: Ctx): void {
    checkSource(step, path, ctx);
    checkInputs(step, path, ctx);
    if (typeof step.resultVar !== 'string' || !step.resultVar) {
        ctx.pushW({ code: 'action.code_no_result', severity: 'warning', path, message: 'This code step has no resultVar, so what it returns is not kept.', hint: 'Set resultVar and read vars.<resultVar> in the steps after it.' });
    }
}

/**
 * App Studio validator: the schema 3 keys of a declared variable (scope, persist, derived;
 * shared/appDefinition/variableScopes.mjs). validate.js calls it after the screens are walked
 * and before the unused-variable check, so the names a derived formula reads count as read.
 *
 *   variable.scope_invalid / persist_invalid / derived_invalid   a value the key does not take
 *   variable.derived_extras / persist_on_screen                   a combination that means nothing
 *   variable.derived_cycle     derived variables that read each other (the error names the ring)
 *   variable.derived_written   a step writes a derived variable: the write changes nothing (warning)
 *
 * The canonicalizer repairs or drops every shape error, so on the save path only the cycle,
 * the formula's own findings and the warning can appear.
 */

import { createRequire } from 'node:module';
import { VARIABLE_SCOPES, VARIABLE_PERSIST_MODES, derivedExprOf, derivedPlan } from '../../shared/appDefinition/variableScopes.mjs';

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Push = (f: Finding) => void;
type Ctx = { pushE: Push; pushW: Push };
type Obj = Record<string, unknown>;

const nodeRequire = createRequire(import.meta.url);
const { validateFormula } = nodeRequire('./formulas.js') as {
    validateFormula: (expr: unknown, path: string, ctx: unknown, roots?: string[]) => void;
};

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkShape(variable: Obj, path: string, ctx: Ctx): void {
    const name = JSON.stringify(variable.name);
    if (variable.scope !== undefined && !(VARIABLE_SCOPES as readonly unknown[]).includes(variable.scope)) {
        ctx.pushE({ code: 'variable.scope_invalid', severity: 'error', path: `${path}.scope`, message: `Variable ${name} has scope ${JSON.stringify(variable.scope)}.`, hint: 'Use "screen", or leave scope out for a value the whole app shares.' });
    }
    if (variable.persist !== undefined && !(VARIABLE_PERSIST_MODES as readonly unknown[]).includes(variable.persist)) {
        ctx.pushE({ code: 'variable.persist_invalid', severity: 'error', path: `${path}.persist`, message: `Variable ${name} has persist ${JSON.stringify(variable.persist)}.`, hint: 'Use "session" or "local", or leave persist out.' });
    }
    if (variable.derived !== undefined && derivedExprOf(variable) === null) {
        ctx.pushE({ code: 'variable.derived_invalid', severity: 'error', path: `${path}.derived`, message: `Variable ${name} has a derived value that is not { expr: "<formula>" }.`, hint: 'Write derived as { expr: "vars.price * vars.quantity" }.' });
    }
    if (variable.derived !== undefined && (variable.scope !== undefined || variable.persist !== undefined)) {
        ctx.pushE({ code: 'variable.derived_extras', severity: 'error', path, message: `Variable ${name} is derived and also has a scope or persist.`, hint: 'A derived value is worked out again each time: remove scope and persist.' });
    } else if (variable.scope === 'screen' && variable.persist !== undefined) {
        ctx.pushE({ code: 'variable.persist_on_screen', severity: 'error', path: `${path}.persist`, message: `Screen variable ${name} also has persist.`, hint: 'A screen variable starts again on every screen: remove persist, or make it an app variable.' });
    }
}

/** The path of each declared variable by name, for the findings that name a variable rather than a place. */
function pathsByName(list: unknown[], declared: Map<string, unknown>): Map<string, string> {
    const out = new Map<string, string>();
    list.forEach((v, i) => {
        if (isObject(v) && typeof v.name === 'string' && declared.get(v.name) === v) out.set(v.name, `variables[${i}]`);
    });
    return out;
}

/**
 * Every schema 3 finding about the declared variables.
 * @param declared the variables validateVariablesAndCollect accepted, by name
 * @param writes   collectVariableWrites(def).names: the names a step or a component writes
 */
export function checkVariableBehaviour(def: Obj, declared: Map<string, unknown>, writes: Set<string>, ctx: Ctx): void {
    if (!Array.isArray(def.variables) || !declared.size) return;
    const paths = pathsByName(def.variables, declared);
    for (const [name, path] of paths) {
        const variable = declared.get(name) as Obj;
        checkShape(variable, path, ctx);
        const expr = derivedExprOf(variable);
        if (expr === null) continue;
        validateFormula(expr, `${path}.derived.expr`, ctx);
        if (writes.has(name)) {
            ctx.pushW({ code: 'variable.derived_written', severity: 'warning', path: `${path}.derived`, message: `Something writes vars.${name}, but "${name}" is derived: the write changes nothing.`, hint: 'Write one of the variables its formula reads instead, or remove derived.' });
        }
    }
    for (const ring of derivedPlan(def.variables).cycles) {
        ctx.pushE({
            code: 'variable.derived_cycle', severity: 'error', path: `${paths.get(ring[0]) || 'variables'}.derived.expr`,
            message: `Derived variables read each other: ${ring.join(' → ')}. None of them can be worked out.`,
            hint: 'Let one of them read a plain variable instead of the other derived one.',
        });
    }
}

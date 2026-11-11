/**
 * App Studio validator — a formula in a SERVER step that reads a scope root only the browser
 * fills (componentSpecs/bindings.js EXTENSION_SCOPE_ROOTS with clientOnly, today `ui`). On the
 * server that root is not in the scope (actionExecutor/shared.js buildServerScope), so the value
 * is nothing and the step writes or sends an empty value without a word. A warning, never an
 * error: no definition that saves today stops saving.
 *
 * Read with formulas.js checkServerFormulas, which walks the step's values and calls this per
 * formula: the same steps the currentUser attribute check covers (the record-writing server
 * kinds, validate/actions.js DATA_MUTATING_STEP_KINDS).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { EXTENSION_SCOPE_ROOTS } = nodeRequire('../componentSpecs/bindings.js') as {
    EXTENSION_SCOPE_ROOTS: Readonly<Record<string, { since: number; clientOnly: boolean }>>;
};
const { compile } = nodeRequire('../../shared/expr/index.mjs') as { compile: (expr: string) => { refs: string[] } };

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushW: (f: Finding) => void };

const CLIENT_ONLY: readonly string[] = Object.freeze(Object.keys(EXTENSION_SCOPE_ROOTS).filter((r) => EXTENSION_SCOPE_ROOTS[r].clientOnly));

/** The client-only roots `expr` names, in its own order. A formula that does not compile names none (validateFormula reports it). */
export function clientOnlyRootsOf(expr: string): string[] {
    let refs: string[];
    try { ({ refs } = compile(expr)); } catch { return []; }
    return refs.filter((r) => CLIENT_ONLY.includes(r));
}

/** One warning per client-only root a server-side formula reads. */
export function checkClientOnlyRoots(expr: string, path: string, ctx: Ctx): void {
    for (const root of clientOnlyRootsOf(expr)) {
        ctx.pushW({
            code: 'formula.server_scope_client_root', severity: 'warning', path,
            message: `This step runs on the server, where "${root}" is empty: only the browser knows what is on screen.`,
            hint: `Copy the value into a variable with a set_variable step before this step and read vars.<name> here.`,
        });
    }
}

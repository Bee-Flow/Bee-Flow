/**
 * App Studio validator: the optional section keys (canonicalize/sectionKeys.mts), called from the
 * screen walk in validate.js with the walk's own context.
 *
 * The canonicalizer already dropped a value of the wrong shape, so this checks only what needs
 * the rest of the definition: a visibleWhen formula by the rules every node condition follows
 * (its `vars.` reads count, so a variable only a section reads is not reported unused), the role
 * keys of visibleToRoles against definition.roles, and a collapsible section without a title
 * (nothing for the viewer to click). A section without these keys gets no finding from here.
 */

import { createRequire } from 'node:module';
import type { Finding } from '../definitionKeyRegistry.mts';

type Obj = Record<string, unknown>;
interface SectionCheckCtx { pushE: (f: Finding) => void; pushW: (f: Finding) => void }

const nodeRequire = createRequire(import.meta.url);
const { validateFormula } = nodeRequire('./formulas.js') as {
    validateFormula: (expr: unknown, path: string, ctx: object, roots: readonly string[]) => void;
};
const { validateRoleRefs } = nodeRequire('./nodes.js') as {
    validateRoleRefs: (refs: unknown, path: string, ctx: object) => void;
};
const { FORMULA_SCOPE_ROOTS } = nodeRequire('../componentSpecs.js') as { FORMULA_SCOPE_ROOTS: readonly string[] };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Findings for one section's optional keys; `ctx` is the validator's walk context. */
export function checkSectionKeys(section: Obj, path: string, ctx: SectionCheckCtx): void {
    const when = section.visibleWhen;
    if (isObject(when) && when.kind === 'formula') validateFormula(when.expr, `${path}.visibleWhen.expr`, ctx, FORMULA_SCOPE_ROOTS);
    if (section.visibleToRoles !== undefined) validateRoleRefs(section.visibleToRoles, `${path}.visibleToRoles`, ctx);
    if (section.collapsible === true && !(typeof section.title === 'string' && section.title.trim())) {
        ctx.pushW({
            code: 'section.collapsible_untitled', severity: 'warning', path: `${path}.collapsible`,
            message: 'A collapsible section folds by clicking its title, and this section has none — it cannot be folded.',
            hint: 'Give the section a title, or remove collapsible.',
        });
    }
}

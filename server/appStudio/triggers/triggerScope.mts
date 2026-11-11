/**
 * The `trigger` scope root: what a formula of an unattended run reads about what started it.
 *
 *   trigger.kind            the kind of the trigger that started the run (`webhook`, …)
 *   trigger.<kind>.…        the values of that kind, under its own name
 *
 * One shape for every kind, so two kinds never claim the same path: a kind that hands its run
 * values puts them under its own name and nothing beside it. A kind that hands nothing (a
 * schedule) starts its run without the root. The root is filled by the server only, for a run a
 * trigger started; in a click, a public page or a dry run `trigger` is not in the scope and reads
 * as nothing. It stays the same in every action the run calls and through a pause.
 *
 * Everything under `trigger.<kind>` that came from outside (a webhook body) is untrusted input,
 * like a form a visitor filled in: steps validate it as they validate form input, and nothing in
 * it selects the app, the action, a table or a role.
 */

import type { RunScopeInput } from '../backgroundRunParts.mts';

type Obj = Record<string, unknown>;

/** The run scope of a fire of `kind` with `values` as `trigger.<kind>`. */
export function triggerScope(kind: string, values: Obj): RunScopeInput {
    return { trigger: { kind, [kind]: values } };
}

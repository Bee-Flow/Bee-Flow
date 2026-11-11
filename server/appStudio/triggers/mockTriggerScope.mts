/**
 * A mocked `trigger` root for a dry run or a saved test (app_run_action / app_save_test
 * `scope.trigger`): an action that a trigger starts reads what started it as `trigger`
 * (triggerScope.mts), and without this a test of it reads that root as nothing.
 *
 *   { kind: "record", record: { event, row, before, changed, … } }
 *   { kind: "webhook", webhook: { body, headers, … } }
 *
 * The same shape the server hands a real trigger run, and nothing beside it: `kind` names a
 * registered trigger kind, and the only other key is that kind's own name. What is inside is the
 * caller's test data, read by the action's formulas like any other scope value. It changes no
 * identity: the run is still the owner's test run, and its record writes still name no origin,
 * so a test never starts a record trigger whatever it mocks (recordTriggerRule.mts rule 1).
 */

import { triggerKind } from './triggerKinds.mts';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The mocked root, undefined when none was given, or the reason it cannot be used. */
export function readMockTrigger(raw: unknown): Obj | undefined | { error: string } {
    if (raw === undefined || raw === null) return undefined;
    const shape = 'scope.trigger is { kind: "<trigger kind>", <kind>: { … } }, e.g. { kind: "record", record: { event: "update", row: { … } } }';
    if (!isObject(raw) || typeof raw.kind !== 'string' || !triggerKind(raw.kind)) return { error: `${shape}; kind must be a trigger kind of the app.` };
    const kind = raw.kind;
    const extra = Object.keys(raw).filter((k) => k !== 'kind' && k !== kind);
    if (extra.length) return { error: `${shape}; it holds nothing else (found ${extra.slice(0, 5).join(', ')}).` };
    if (raw[kind] !== undefined && !isObject(raw[kind])) return { error: `${shape}; trigger.${kind} must be an object.` };
    return { kind, ...(raw[kind] !== undefined ? { [kind]: raw[kind] } : {}) };
}

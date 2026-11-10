/**
 * The App Studio definition gate (appStudio/definitionGate.mts) as the project
 * writers use it: Blueprint install, Solution upgrade, stage prepare and stage
 * compensate all reach it through this one module.
 *
 * Stage prepare asks it for every app a release carries, BEFORE it writes
 * anything.
 *
 * An app whose definition this installation must not store (not an object is
 * left to the write that follows, as before; a NEWER schema is refused here) is
 * a blocking finding, `app.schema_newer`. Validator errors are findings with
 * severity `warning`: the deployment goes on and carries them in
 * `prepared.findings`. The commit publishes what prepare gated and does not ask
 * again.
 */

import { gateDefinition } from '../appStudio/definitionGate.mts';

export { gateDefinition };

interface Finding { code: string; severity: string; ref: string; [key: string]: unknown }
interface ReleaseEntity { ref: string; kind: string; entity?: { definition?: unknown } | null }

export function gateReleaseApps(entities: Iterable<ReleaseEntity>): { blocking: Finding[]; warnings: Finding[] } {
    const blocking: Finding[] = [];
    const warnings: Finding[] = [];
    for (const e of entities) {
        if (!e || e.kind !== 'app') continue;
        // What prepare writes for a part without a definition.
        const gate = gateDefinition((e.entity && e.entity.definition) || {});
        if (gate.refused === 'schema_newer') {
            blocking.push({ code: 'app.schema_newer', severity: 'blocking', ref: e.ref });
            continue;
        }
        for (const f of gate.errors) {
            warnings.push({ code: `app.${f.code}`, severity: 'warning', ref: e.ref, path: f.path || '' });
        }
    }
    return { blocking, warnings };
}

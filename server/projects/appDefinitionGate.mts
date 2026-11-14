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

import { createRequire } from 'node:module';

type DefinitionGate = typeof import('../appStudio/definitionGate.mts');
type AppAssets = typeof import('../appStudio/appAssets.mts');
type PortabilityReport = typeof import('../appStudio/portabilityReport.mts');

const nodeRequire = createRequire(import.meta.url);
// appStudio/ is a feature; its modules are looked up by name (core/featureModules.js,
// registered in boot/featureModules.js), on first use.
const appStudio = <T,>(name: string): T =>
    (nodeRequire('../core/featureModules') as { featureModule: (n: string) => unknown }).featureModule(name) as T;

export function gateDefinition(...args: Parameters<DefinitionGate['gateDefinition']>): ReturnType<DefinitionGate['gateDefinition']> {
    return appStudio<DefinitionGate>('appStudio/definitionGate').gateDefinition(...args);
}
const collectAssetRefs = (definition: unknown): ReturnType<AppAssets['collectAssetRefs']> =>
    appStudio<AppAssets>('appStudio/appAssets').collectAssetRefs(definition);
const triggerCounts = (definition: unknown): ReturnType<PortabilityReport['triggerCounts']> =>
    appStudio<PortabilityReport>('appStudio/portabilityReport').triggerCounts(definition);

/**
 * What a Blueprint, a Solution upgrade or a stage deploy does NOT carry of an app, said to
 * whoever installs it. The uploaded files of an app (pictures, logo, fonts) belong to the app
 * they were uploaded to and do not travel in a package: the definition keeps its references,
 * which show the neutral placeholder until the files are uploaded again. Triggers travel and are
 * armed only by a publish or a stage deploy; a webhook's address and secret never travel.
 */
export function appCopyNotes(given: unknown, definition: unknown): string[] {
    const name = typeof given === 'string' && given ? given : 'Untitled app';
    const notes: string[] = [];
    const files = collectAssetRefs(definition).size;
    if (files) notes.push(`"${name}" uses ${files} uploaded file(s) (pictures, logo, fonts). They do not travel in a Blueprint or a release: upload them again in the installed app.`);
    const { count, webhooks } = triggerCounts(definition);
    if (count) {
        notes.push(`"${name}" has ${count} trigger(s); they start only once the app is published.`
            + (webhooks ? ` ${webhooks} webhook trigger(s) get a new address and secret at that publish.` : ''));
    }
    return notes;
}

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
        const files = collectAssetRefs((e.entity && e.entity.definition) || {}).size;
        if (files) {
            warnings.push({
                code: 'app.assets_not_carried', severity: 'warning', ref: e.ref, count: files,
                message: `An app uses ${files} uploaded file(s) (pictures, logo, fonts). They are not part of a release: upload them in this stage's app.`,
            });
        }
    }
    return { blocking, warnings };
}

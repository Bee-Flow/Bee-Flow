/**
 * Windmill importer: the public API of the converter (PLAN B0, B2, B3).
 * Pure: no database, no network, no AI, nothing written to disk.
 *
 *   const { toIntermediate, toBeeFlow } = require('./automation/importers/windmill/index.mts');
 *
 *   const bundle = await toIntermediate(input, limits?)
 *       input  = { kind: 'zip', data: Buffer }                 a `wmill sync pull` folder, zipped (primary)
 *              | { kind: 'files', files: { [path]: text } }     the same tree, already read
 *              | { kind: 'text', text, name? }                  one flow (or a list) as JSON or YAML
 *              | { kind: 'object', value, name? }               one flow (or a list), already parsed
 *       limits = { maxEntries, maxTotalBytes, maxFileBytes }   0 = unlimited (DEFAULT_LIMITS otherwise)
 *       throws BundleError { code } for an unreadable or oversized input, PathRefused for a name
 *       that leaves the export, YamlError for broken YAML or an alias bomb.
 *
 *   const result = toBeeFlow(bundle, { capabilities?, skipValidation? })
 *       result.flows[]   one FlowConversion per flow:
 *                          envelope    the `beeflow.automation` export envelope, for portability.sanitizeImport
 *                          definition  the automation definition (always an inactive draft once imported)
 *                          trigger     the primary trigger
 *                          report      modules[] (mapped | pattern | shim | ai | unsupported | dropped, with
 *                                      confidence and reason), aiChecklist[] (scrubbed source, read-only for
 *                                      the builder), warnings[] (secret_removed, connection_needed,
 *                                      outbound_host, identity_change, …), connections[], outboundHosts[],
 *                                      suggestedRunPolicy, suggestedWebhookAuth, validation (draft codes)
 *                          payload     what `flow_input` is at run time ({ kind, event }), for remapRunInput
 *       result.notMigrated[]  Windmill apps and triggers that have no flow here
 *       result.readWarnings[] problems reading the export (a file that did not parse)
 *
 *   remapRunInput(kind, event, input)   a Windmill run's `flow_input` as the draft's trigger payload
 *   scrubValue(value, counter)           secret-shaped values replaced (scrub.mts)
 *
 * `capabilities` switches off targets an installation does not have yet
 * (capabilities.mts): those become AI checklist items instead. The Bee Flow
 * names that are new in this round are in targetNames.mts.
 *
 * Secret values never travel: a resource file keeps only its path and type,
 * `$res:` / `$var:` inputs become connection hints, and every source that ends
 * up in a note, a code step or the checklist went through scrub.mts first.
 */

import type { WmBundle } from './ir.mts';
import type { ConvertOptions, FlowConversion } from './convert.mts';
import { convertFlow } from './convert.mts';

export { toIntermediate, BundleError, DEFAULT_LIMITS } from './bundle.mts';
export type { WindmillInput, BundleLimits } from './bundle.mts';
export { PathRefused } from './paths.mts';
export { YamlError } from './yaml.mts';
export { remapRunInput } from './payload.mts';
export { scrubValue } from './scrub.mts';
export type { ConvertOptions, FlowConversion } from './convert.mts';

export interface ConversionResult {
    flows: FlowConversion[];
    notMigrated: string[];
    readWarnings: string[];
}

export function toBeeFlow(bundle: WmBundle, opts: ConvertOptions = {}): ConversionResult {
    const flowPaths = new Set(bundle.flows.map((f) => f.path));
    const notMigrated: string[] = bundle.apps.map((a) => `The Windmill app ${a} is not migrated (build it in App Studio).`);
    for (const t of [...bundle.schedules, ...bundle.nativeTriggers, ...bundle.otherTriggers]) {
        if (!flowPaths.has(t.scriptPath)) notMigrated.push(`${t.file} starts ${t.scriptPath}, which is not a flow in this export.`);
    }
    for (const s of bundle.scripts.values()) {
        if (!bundle.flows.some((f) => usesScript(f.nodes, s.path))) notMigrated.push(`The script ${s.path} is not used by a flow here; scripts on their own are not migrated.`);
    }
    return { flows: bundle.flows.map((f) => convertFlow(f, bundle, opts)), notMigrated, readWarnings: bundle.readWarnings };
}

function usesScript(nodes: WmBundle['flows'][number]['nodes'], path: string): boolean {
    return nodes.some((n) => n.scriptPath === path || usesScript(n.children ?? [], path) || (n.branches ?? []).some((b) => usesScript(b.nodes, path)) || usesScript(n.defaultBranch ?? [], path));
}

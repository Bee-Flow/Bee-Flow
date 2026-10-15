/**
 * The web's `agent-hub/src/components/automation/Builder/mapping/upstream/sampleFields.ts`, generated into mirror/ by
 * scripts/gen-shared-mirror.mjs (npm run gen:shared; npm run lint:shared-mirror
 * fails on a stale copy). Change the web file, never the mirror; this path stays
 * so the phone's importers did not change.
 */
import type { VariableField, VariableGroup } from '../types';
import { sampleToFields } from '../mirror/mapping/upstream/sampleFields';

export * from '../mirror/mapping/upstream/sampleFields';

/** A group's name and kind. */
export interface GroupHead {
    label: string;
    kind: string;
}

/** A describer's group for a step whose output lives at `steps.<id>.output`. */
export function stepGroup(node: { id: string }, head: GroupHead, sample: unknown, fields?: VariableField[]): VariableGroup {
    const basePath = `steps.${node.id}.output`;
    return { id: node.id, ...head, basePath, sample, fields: fields ?? sampleToFields(sample, basePath) };
}

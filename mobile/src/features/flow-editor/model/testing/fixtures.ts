/**
 * Definitions the model's lockstep tests run through both the web modules and
 * their ports. Each one exercises a shape the builder must get right
 * (definitions.json beside this file, which is what a definition is — JSON):
 *
 *   branchy  a condition's then/else merging again, a coloured edge
 *   switchy  a switch with all three case-edge spellings, a default and an
 *            on_error port, every node placed
 *   loopy    a loop whose body holds a condition, a rule switch, a plain step
 *   multi    secondary triggers, AI steps with and without tools, a filter, a
 *            four-way switch, a note, a form page
 *   tangled  a cycle, a dangling edge, a duplicate id, a step nothing reaches
 *   layered  flowlets: one well-formed, one without a trigger
 *   chain    (built below) a long straight line, long enough to wrap into rows
 *
 * The server's own templates are added by the tests (templateDefinitions).
 * Test data only: nothing in the app imports this.
 */

import type { FlowDefinition, FlowStep } from '../types';
import DEFINITIONS from './definitions.json';

const chainStep = (i: number): FlowStep =>
    i % 3 === 0 ? { id: `c${i}`, type: 'ai_step', tools: ['web_search'] } : { id: `c${i}`, type: 'set' };

export const chain: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: Array.from({ length: 12 }, (_, i) => chainStep(i)),
    edges: [{ from: 'trg', to: 'c0' }, ...Array.from({ length: 11 }, (_, i) => ({ from: `c${i}`, to: `c${i + 1}` }))],
};

const json = DEFINITIONS as unknown as Record<string, FlowDefinition>;

/** Every hand-made fixture, by name. */
export const FIXTURES: Record<string, FlowDefinition> = { ...json, chain };

export const branchy = json.branchy as FlowDefinition;
export const switchy = json.switchy as FlowDefinition;
export const loopy = json.loopy as FlowDefinition;
export const multi = json.multi as FlowDefinition;

/** A deep copy, so a test can never mutate a shared fixture. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * The server's templates, by id: the ids are read from the source text (the
 * module's `listTemplates` pulls in modules the mobile job does not install),
 * the definitions from its `getTemplate`.
 */
export function templateDefinitions(
    source: string,
    getTemplate: (id: string) => { definition?: unknown } | null,
): Record<string, FlowDefinition> {
    const ids = [...source.matchAll(/^ {8}id: '([a-z0-9-]+)',$/gm)].map((m) => m[1] as string);
    return Object.fromEntries(ids.map((id) => [id, clone(getTemplate(id)?.definition as FlowDefinition)]));
}

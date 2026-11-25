/**
 * The order a plan's steps run in, as a person should read them: the topological order of the plan's edges, not the
 * order they happen to be written down in. A step listed early that waits for a later one is shown after it.
 *
 * Only the top level has edges; the steps inside a loop run in the order of its body, right after the loop itself.
 * Where the edges leave a choice (two steps that wait for nothing in between), the order of the definition decides,
 * so the list is stable. A cycle cannot run (./planWiring.mts says so); its steps are put after the rest, in the order
 * of the definition, so the list still holds every step once.
 *
 * Pure: the definition in, step ids out.
 */

import type { Definition } from './planTypes.mts';
import { isAnnotation } from './coworkStepList.mts';
import { stepsOf, type WalkedStep } from './planWalk.mts';

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The edges between two top-level steps of the plan (an edge from the trigger orders nothing among the steps). */
function stepEdges(definition: Definition | null | undefined, top: ReadonlySet<string>): Array<[string, string]> {
    const raw = Array.isArray(definition?.edges) ? (definition.edges as unknown[]) : [];
    const out: Array<[string, string]> = [];
    for (const e of raw) {
        if (!isPlain(e) || typeof e.from !== 'string' || typeof e.to !== 'string') continue;
        if (e.from !== e.to && top.has(e.from) && top.has(e.to)) out.push([e.from, e.to]);
    }
    return out;
}

/** Kahn's algorithm over the top-level steps; among the steps that are free to run, the first in the definition goes first. */
function topOrder(ids: string[], edges: Array<[string, string]>): string[] {
    const position = new Map(ids.map((id, i) => [id, i]));
    const waitsFor = new Map(ids.map((id) => [id, 0]));
    const next = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const [from, to] of edges) {
        next.get(from)?.push(to);
        waitsFor.set(to, (waitsFor.get(to) ?? 0) + 1);
    }
    const free = ids.filter((id) => waitsFor.get(id) === 0);
    const out: string[] = [];
    while (free.length > 0) {
        free.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
        const id = free.shift() as string;
        out.push(id);
        for (const to of next.get(id) ?? []) {
            const left = (waitsFor.get(to) ?? 0) - 1;
            waitsFor.set(to, left);
            if (left === 0) free.push(to);
        }
    }
    const placed = new Set(out);
    return [...out, ...ids.filter((id) => !placed.has(id))];
}

/** Every step id of the plan in the order it runs: the top level by its edges, each loop's body right after the loop. */
export function runOrderOf(definition: Definition | null | undefined): string[] {
    const walked = stepsOf(definition).filter((w) => !isAnnotation(w.type));
    const children = new Map<string, WalkedStep[]>();
    for (const w of walked) {
        if (w.parentId !== null) children.set(w.parentId, [...(children.get(w.parentId) ?? []), w]);
    }
    const topIds = walked.filter((w) => w.parentId === null).map((w) => w.id);
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string): void => {
        if (seen.has(id)) return;
        seen.add(id);
        out.push(id);
        for (const child of children.get(id) ?? []) visit(child.id);
    };
    for (const id of topOrder(topIds, stepEdges(definition, new Set(topIds)))) visit(id);
    // A step whose loop is not in the plan's graph still belongs in the list.
    for (const w of walked) visit(w.id);
    return out;
}

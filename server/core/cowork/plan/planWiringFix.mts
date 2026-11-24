/**
 * The fixes of ./planWiring.mts applied, and the proof that a fixed plan reaches exactly what the plan before it
 * reached (decision 0050: the narrow exception covers the order between a plan's own steps too).
 *
 *   - `fixWiring` applies the deterministic fixes one at a time, judging the plan again after each, until none is
 *     left that has a fix. A fix changes REFERENCES (which step a field reads, the braces around a path, the reference
 *     an AI step gets in its prompt) and EDGES (a step waits for another; its own edge from the trigger goes).
 *   - `sameWiringReach` is what the resolver asks before it applies one by itself: the same steps with the same types,
 *     tools and inputs once the references are taken out, the rest of the definition equal, edges only between steps of
 *     the plan (and only an edge from the trigger taken away), and exactly the same permissions.
 *   - `wiringChangesOf` says what changed, as step ids: "now waits for", "now reads from". The note on the item and
 *     the trail entry are made of it.
 *
 * Pure: a definition in, a new one out; the one handed in is never changed.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, ToolLookups } from './planTypes.mts';
import { stepsOf } from './planWalk.mts';
import { permissionsOf, planFingerprint } from './planPermissions.mts';
import { WIRING_BLOCKING, graphOf, stepRefsOf, wiringFindings, type WiringFinding, type WiringFix, type WiringOptions } from './planWiring.mts';

const nodeRequire = createRequire(import.meta.url);
const { canonicalJson } = nodeRequire('../../../utils/stableJson.js') as { canonicalJson: (v: unknown) => string };

/** What a fix changed about one step. */
export interface WiringChange { kind: 'waits' | 'reads'; stepId: string; otherId: string }

const MAX_FIXES = 12;
const CHILD_FIELDS: ReadonlySet<string> = new Set(['body', 'branches']);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every string in a value, rewritten; objects and lists are copied. */
function mapStrings(value: unknown, fn: (s: string) => string, depth = 0): unknown {
    if (typeof value === 'string') return fn(value);
    if (!value || typeof value !== 'object' || depth > 12) return value;
    if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, depth + 1)]));
}

/** The step's own fields rewritten (its children are steps of their own). */
function rewriteOwn(step: DefStep, fn: (s: string) => string): void {
    for (const [key, value] of Object.entries(step)) {
        if (CHILD_FIELDS.has(key) && Array.isArray(value)) continue;
        step[key] = mapStrings(value, fn);
    }
}

const unwrap = (s: string): string => {
    const t = s.trim();
    return t.startsWith('{{') && t.endsWith('}}') ? t.slice(2, -2).trim() : s;
};

function edgeList(def: Definition): Array<Record<string, unknown>> {
    if (!Array.isArray(def.edges)) def.edges = [];
    return def.edges as Array<Record<string, unknown>>;
}

function applyWait(def: Definition, step: DefStep, fix: Extract<WiringFix, { kind: 'wait' }>): void {
    const edges = edgeList(def);
    for (const from of fix.after) {
        if (!edges.some((e) => e.from === from && e.to === fix.stepId)) edges.push({ from, to: fix.stepId });
    }
    // It waits now: its own edge from the trigger would start it right away beside them.
    const triggerId = typeof def.trigger?.id === 'string' ? def.trigger.id : null;
    def.edges = edges.filter((e) => !(e.from === triggerId && e.to === fix.stepId && !e.label && !e.caseName));
    if (fix.addRefs.length === 0 || typeof step.prompt !== 'string') return;
    const missing = fix.addRefs.filter((id) => !stepRefsOf(step).some((r) => r.sourceId === id));
    if (missing.length > 0) step.prompt = `${step.prompt.trimEnd()}\n\n${missing.map((id) => `{{steps.${id}.output}}`).join('\n')}`;
}

/** One fix applied to a copy of the plan. */
export function applyWiringFix(definition: Definition, fix: WiringFix): Definition {
    const def = structuredClone(definition);
    const step = stepsOf(def).find((w) => w.id === fix.stepId)?.step;
    if (!step) return def;
    if (fix.kind === 'reread') {
        const from = `steps.${fix.from}.output`;
        rewriteOwn(step, (s) => (s.includes(from) ? s.split(from).join(`steps.${fix.to}.output`) : s));
    } else if (fix.kind === 'unbrace') {
        if (fix.field === 'forEach.overRef' && isPlain(step.forEach) && typeof step.forEach.overRef === 'string') step.forEach = { ...step.forEach, overRef: unwrap(step.forEach.overRef) };
        else if (typeof step[fix.field] === 'string') step[fix.field] = unwrap(step[fix.field] as string);
    } else {
        applyWait(def, step, fix);
    }
    return def;
}

function changesOfFix(fix: WiringFix, sourceId: string | null): WiringChange[] {
    if (fix.kind === 'reread') return [{ kind: 'reads', stepId: fix.stepId, otherId: fix.to }];
    if (fix.kind === 'wait') return fix.after.map((otherId) => ({ kind: 'waits' as const, stepId: fix.stepId, otherId }));
    return sourceId ? [{ kind: 'reads', stepId: fix.stepId, otherId: sourceId }] : [];
}

export interface FixedWiring {
    definition: Definition;
    changes: WiringChange[];
    /** The findings that stop an approval and that no fix answers. */
    remaining: WiringFinding[];
}

const blocking = (def: Definition, lookups: ToolLookups, opts: WiringOptions): WiringFinding[] => wiringFindings(def, lookups, opts).filter((f) => WIRING_BLOCKING.has(f.code));

/** The plan with every deterministic wiring fix applied; null when there was nothing to fix. */
export function fixWiring(definition: Definition, lookups: ToolLookups, opts: WiringOptions = {}): FixedWiring | null {
    let def = definition;
    const changes: WiringChange[] = [];
    const seen = new Set([planFingerprint(def)]);
    for (let i = 0; i < MAX_FIXES; i++) {
        const next = blocking(def, lookups, opts).find((f) => f.fix);
        if (!next?.fix) break;
        const fixed = applyWiringFix(def, next.fix);
        const print = planFingerprint(fixed);
        if (seen.has(print)) break;
        seen.add(print);
        changes.push(...changesOfFix(next.fix, next.sourceId));
        def = fixed;
    }
    if (changes.length === 0) return null;
    // One change per pair of steps: a step that now reads from another also waits for it, and "reads from" says both.
    const unique = [...new Map(changes.map((c) => [`${c.stepId}|${c.otherId}`, c])).values()];
    return { definition: def, changes: unique, remaining: blocking(def, lookups, opts) };
}

/** A text with its references taken out: placeholders gone, a bare path as one mark, the spacing evened out. */
export function withoutRefs(text: string): string {
    let out = '';
    let at = 0;
    while (at < text.length) {
        const open = text.indexOf('{{', at);
        const close = open < 0 ? -1 : text.indexOf('}}', open + 2);
        if (open < 0 || close < 0) { out += text.slice(at); break; }
        out += text.slice(at, open);
        at = close + 2;
    }
    const plain = out.split(/\s+/).filter(Boolean).join(' ');
    // A field that is one reference, in braces or bare, reads the same as any other one reference.
    if (plain === '' && text.includes('{{')) return '<ref>';
    return plain.startsWith('steps.') && !plain.includes(' ') ? '<ref>' : plain;
}

/** A step without its references, to compare everything else. */
const stepWithoutRefs = (step: DefStep): string => {
    const own: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step)) own[key] = CHILD_FIELDS.has(key) && Array.isArray(value) ? value.length : mapStrings(value, withoutRefs);
    return canonicalJson(own);
};

const edgeKey = (e: Record<string, unknown>): string => canonicalJson({ from: e.from, to: e.to, label: e.label ?? null, caseName: e.caseName ?? null });

function edgesOk(before: Definition, after: Definition): boolean {
    const nodes = new Set([...graphOf(after).top.keys(), typeof after.trigger?.id === 'string' ? after.trigger.id : '']);
    const was = (Array.isArray(before.edges) ? before.edges : []).filter(isPlain);
    const now = (Array.isArray(after.edges) ? after.edges : []).filter(isPlain);
    const nowKeys = new Set(now.map(edgeKey));
    const triggerId = before.trigger?.id;
    // Taken away: only an edge from the trigger. Added: only between steps of the plan, with no branch label.
    if (was.some((e) => !nowKeys.has(edgeKey(e)) && e.from !== triggerId)) return false;
    const wasKeys = new Set(was.map(edgeKey));
    return now.filter((e) => !wasKeys.has(edgeKey(e))).every((e) => nodes.has(String(e.from)) && nodes.has(String(e.to)) && !e.label && !e.caseName);
}

/**
 * Does the fixed plan reach exactly what the plan before it reached? The same steps in the same order, equal once
 * their references are taken out; the rest of the definition equal; edges as `edgesOk` allows; every reference reads a
 * step of the plan; exactly equal permissions.
 */
export function sameWiringReach(before: Definition, after: Definition, lookups: ToolLookups): boolean {
    const a = stepsOf(before);
    const b = stepsOf(after);
    if (a.length !== b.length || a.some((w, i) => w.id !== b[i]?.id || w.type !== b[i]?.type || stepWithoutRefs(w.step) !== stepWithoutRefs((b[i] as typeof w).step))) return false;
    const { steps: _s1, edges: _e1, ...restBefore } = before;
    const { steps: _s2, edges: _e2, ...restAfter } = after;
    if (canonicalJson(restBefore) !== canonicalJson(restAfter) || !edgesOk(before, after)) return false;
    const ids = new Set(b.map((w) => w.id));
    if (b.some((w) => stepRefsOf(w.step).some((r) => !ids.has(r.sourceId)))) return false;
    return canonicalJson(permissionsOf(before, lookups)) === canonicalJson(permissionsOf(after, lookups));
}

const ID_MAX = 120;

/** Changes of the wiring as kept (a trail entry, a try-out record): `[{ kind, stepId, otherId }]`, step ids only, at most `max`. */
export function wiringChangesShape(value: unknown, max = 20): WiringChange[] {
    const out: WiringChange[] = [];
    const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;
    for (const entry of Array.isArray(value) ? value : []) {
        if (out.length >= max) break;
        const { kind, stepId, otherId } = (isPlain(entry) ? entry : {}) as Record<string, unknown>;
        if ((kind === 'waits' || kind === 'reads') && id(stepId) && id(otherId)) out.push({ kind, stepId, otherId });
    }
    return out;
}

/** Why Cowork may not fix a plan's wiring by itself: nothing to fix, a finding no fix answers, or a fix that reaches more. */
export type WiringFixRefusal = 'nothing' | 'no_fix' | 'reach_differs';

/**
 * The fix of the wiring Cowork may apply by itself: every blocking wiring finding answered, and the fixed plan reaches
 * exactly what the plan before it reached. Otherwise why not.
 */
export function selfFixOf(definition: Definition, lookups: ToolLookups, opts: WiringOptions = {}): { fixed: FixedWiring } | { refused: WiringFixRefusal } {
    const fixed = fixWiring(definition, lookups, opts);
    if (!fixed) return { refused: 'nothing' };
    if (fixed.remaining.length > 0) return { refused: 'no_fix' };
    return sameWiringReach(definition, fixed.definition, lookups) ? { fixed } : { refused: 'reach_differs' };
}

/** What changed between two versions of a plan, in the wiring: who waits for whom now, who reads from whom now. */
export function wiringChangesOf(before: Definition | null | undefined, after: Definition | null | undefined): WiringChange[] {
    if (!before || !after) return [];
    const out: WiringChange[] = [];
    const has = (stepId: string, otherId: string): boolean => out.some((c) => c.stepId === stepId && c.otherId === otherId);
    const readBefore = new Map(stepsOf(before).map((w) => [w.id, new Set(stepRefsOf(w.step).map((r) => r.sourceId))]));
    for (const w of stepsOf(after)) {
        for (const id of new Set(stepRefsOf(w.step).map((r) => r.sourceId))) if (!readBefore.get(w.id)?.has(id) && !has(w.id, id)) out.push({ kind: 'reads', stepId: w.id, otherId: id });
    }
    const was = new Set((Array.isArray(before.edges) ? before.edges : []).filter(isPlain).map((e) => `${String(e.from)}>${String(e.to)}`));
    const steps = new Set(stepsOf(after).map((w) => w.id));
    for (const e of (Array.isArray(after.edges) ? after.edges : []).filter(isPlain)) {
        const [from, to] = [String(e.from), String(e.to)];
        if (!was.has(`${from}>${to}`) && steps.has(from) && !has(to, from)) out.push({ kind: 'waits', stepId: to, otherId: from });
    }
    return out;
}

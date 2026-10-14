/**
 * resolveTarget — the ONE deep-link resolver behind every "Show me".
 *
 * A finding names WHERE it is in one of two ways: a validator PATH into the
 * definition (`screens[0].sections[1].children[2].props.title`), or the ID of
 * the node that was actually executed (the app dry run only has an id). Those
 * are the two directions of one walk — path → node and node → label — and
 * they used to live in two files that each described themselves as half of
 * the job (PublishModal.resolveIssueTarget, dryRunIssues.nodeLabel). This is
 * the whole job, once, so the App Studio publish modal, the dry-run panel,
 * a Solution's "Te controleren" list and Studio Home's "Vraagt aandacht"
 * cannot resolve the same finding to different places.
 *
 *   resolveTarget(definition, { path?, nodeId?, kind? })
 *     → { kind, screenId, screenName, nodeId, label, labelIsText } | null
 *
 * `path` is tried first; when it addresses nothing the `nodeId` is tried;
 * null when neither lands. `label` is what to call the node in a sentence:
 * its own text (label/title/text/heading, ≤30 chars) when it has one — then
 * `labelIsText` is true so a caller can quote it — else its type, else its
 * id. A hit on a screen alone carries the screen's name as the label.
 *
 * Per-kind walkers, chosen from the definition's shape (or forced with
 * `kind`):
 *   'app'        — screens → sections → children (recursive). The server's
 *                  walkObjects (appStudio/templateCapture.js) is the same
 *                  descent for a different purpose.
 *   'automation' — the root graph and every layer: trigger, triggers[], steps
 *                  with loop bodies and parallel branches (the shapes
 *                  automation/portability.js walkAllSteps walks). Here the
 *                  "screen" is the LAYER the step sits on: `screenId` is the
 *                  layer key (null on the root graph), `screenName` its title.
 *                  Paths come in the validator's mixed addressing — a
 *                  top-level step by index or id, a nested step by id, a
 *                  trigger by id — and the deepest addressed node wins.
 *
 * Leaf module: no imports, so shared/, the Studio sections and the builders
 * can all read it without a cycle.
 */

const LABEL_MAX = 30;
const APP_STEP_RE = /^(screens|sections|children)\[(\d+)\]$/;
const FLOW_STEP_RE = /^(trigger|triggers|steps)(?:\[(.+)\])?$/;

export type TargetKind = 'app' | 'automation';

export interface ResolvedTarget {
    kind: TargetKind;
    screenId: string | null;
    screenName: string | null;
    nodeId: string | null;
    label: string | null;
    labelIsText: boolean;
}

export interface TargetRef {
    path?: string;
    nodeId?: string | number | null;
    kind?: TargetKind;
}

type Dict = Record<string, unknown>;

function isObject(v: unknown): v is Dict { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function idOf(node: unknown): string | null {
    const id = isObject(node) ? node.id : undefined;
    return id != null && id !== '' ? String(id) : null;
}

/** The kind of definition this is, from its shape; null when it is neither. */
export function detectKind(definition: unknown): TargetKind | null {
    if (!isObject(definition)) return null;
    if (Array.isArray(definition.screens)) return 'app';
    if (Array.isArray(definition.steps) || isObject(definition.trigger) || isObject(definition.layers)) return 'automation';
    return null;
}

/** The node's own words, trimmed and capped, or null. */
function ownText(...candidates: unknown[]): string | null {
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim().slice(0, LABEL_MAX);
    }
    return null;
}

function display(text: string | null, type: unknown, id: string | null): { label: string | null; labelIsText: boolean } {
    if (text) return { label: text, labelIsText: true };
    if (typeof type === 'string' && type) return { label: type, labelIsText: false };
    return { label: id, labelIsText: false };
}

function appNodeDisplay(node: unknown) {
    const props: Dict = isObject(node) && isObject(node.props) ? node.props : {};
    return display(ownText(props.label, props.title, props.text, props.heading), isObject(node) ? node.type : undefined, idOf(node));
}

function flowNodeDisplay(node: unknown) {
    // A step has a `type`; a trigger has a `kind` (schedule, form, …).
    const n: Dict = isObject(node) ? node : {};
    return display(ownText(n.title, n.name, n.label), n.type ?? n.kind, idOf(node));
}

// ── App: screens → sections → children ──────────────────────────────────────

function appHit(screen: unknown, node: unknown): ResolvedTarget {
    const screenId = idOf(screen);
    const screenObj: Dict = isObject(screen) ? screen : {};
    const rawName = screenObj.name;
    const named = node
        ? appNodeDisplay(node)
        : { label: ownText(rawName) || screenId, labelIsText: !!ownText(rawName) };
    return {
        kind: 'app',
        screenId,
        screenName: typeof rawName === 'string' && rawName ? rawName : null,
        nodeId: idOf(node),
        ...named,
    };
}

/**
 * Walk a validator path down to the deepest section/element it addresses,
 * plus the screen it sits on. Trailing segments that are not a
 * screen/section/child step (`props`, `filters`, …) stop the walk — they
 * address a field inside the node already found; so does an index that no
 * longer exists, keeping what was found so far. Null when the path does not
 * start at a real screen.
 */
function resolveAppPath(definition: Dict, path: string): ResolvedTarget | null {
    let screen: Dict | null = null;
    let cursor: unknown = null;
    let node: Dict | null = null;
    for (const part of path.split('.')) {
        const m = APP_STEP_RE.exec(part);
        if (!m) break;
        const list = m[1] === 'screens' ? definition.screens : (isObject(cursor) ? cursor[m[1]] : undefined);
        cursor = Array.isArray(list) ? list[Number(m[2])] : null;
        if (!isObject(cursor)) break;
        if (m[1] === 'screens') screen = cursor;
        else if (idOf(cursor)) node = cursor;
    }
    return screen ? appHit(screen, node) : null;
}

function resolveAppNode(definition: Dict, nodeId: string): ResolvedTarget | null {
    const screens: unknown[] = Array.isArray(definition.screens) ? definition.screens : [];
    for (const screen of screens) {
        if (!isObject(screen)) continue;
        let found: unknown = null;
        const walk = (nodes: unknown): void => {
            for (const n of Array.isArray(nodes) ? nodes : []) {
                if (found) return;
                if (idOf(n) === nodeId) { found = n; return; }
                if (isObject(n) && Array.isArray(n.children)) walk(n.children);
            }
        };
        const sections: unknown[] = Array.isArray(screen.sections) ? screen.sections : [];
        for (const section of sections) {
            if (found) break;
            if (idOf(section) === nodeId) { found = section; break; }
            walk(isObject(section) ? section.children : undefined);
        }
        if (found) return appHit(screen, found);
    }
    return null;
}

// ── Automation: root graph + layers, triggers + nested steps ────────────────

function walkFlowSteps(steps: unknown, fn: (s: Dict) => boolean): boolean {
    for (const s of Array.isArray(steps) ? steps : []) {
        if (!isObject(s)) continue;
        if (fn(s)) return true;
        if (s.type === 'loop' && walkFlowSteps(s.body, fn)) return true;
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) if (walkFlowSteps(branch, fn)) return true;
        }
    }
    return false;
}

function graphsOf(definition: Dict): { key: string | null; graph: Dict }[] {
    const out: { key: string | null; graph: Dict }[] = [{ key: null, graph: definition }];
    if (isObject(definition.layers)) {
        for (const [key, layer] of Object.entries(definition.layers)) {
            if (isObject(layer)) out.push({ key, graph: layer });
        }
    }
    return out;
}

function flowHit(layerKey: string | null, graph: Dict, node: unknown): ResolvedTarget {
    return {
        kind: 'automation',
        screenId: layerKey,
        screenName: layerKey ? (ownText(graph?.title) || null) : null,
        nodeId: idOf(node),
        ...flowNodeDisplay(node),
    };
}

/** One `steps[…]` / `triggers[…]` token against a list: an id, or an index. */
function byToken(list: unknown, tok: string): unknown {
    const items: unknown[] = Array.isArray(list) ? list : [];
    const hit = items.find((s) => isObject(s) && idOf(s) === tok);
    if (hit) return hit;
    if (!/^\d+$/.test(tok)) return null;
    const at = items[Number(tok)];
    return isObject(at) && idOf(at) ? at : null;
}

/** The step with this id anywhere in `steps` — loop bodies and branches included. */
function findNested(steps: unknown, id: string): unknown {
    let nested: unknown = null;
    walkFlowSteps(steps, (s) => { if (idOf(s) === id) { nested = s; return true; } return false; });
    return nested;
}

/** Enter the layer a path names (`layers.<key>.…`), or stay on the root graph. */
function graphForPath(definition: Dict, parts: string[]): { layerKey: string | null; graph: Dict | null; parts: string[] } {
    if (parts[0] !== 'layers') return { layerKey: null, graph: definition, parts };
    const layerKey = parts[1] || null;
    const graph: unknown = layerKey && isObject(definition.layers) ? definition.layers[layerKey] : null;
    return { layerKey, graph: isObject(graph) ? graph : null, parts: parts.slice(2) };
}

/**
 * One path segment against the graph: the node it addresses, or null. The
 * first `steps[…]` is the top-level list (index or id); anything after it is
 * a loop body / parallel branch, always addressed by id.
 */
function flowSegmentNode(graph: Dict, seg: string, tok: string | undefined, topLevel: boolean): unknown {
    if (seg === 'trigger') return !tok && idOf(graph.trigger) ? graph.trigger : null;
    if (seg === 'triggers') return tok ? byToken(graph.triggers, tok) : null;
    if (!tok || tok === '?') return null;
    return topLevel ? byToken(graph.steps, tok) : findNested(graph.steps, tok);
}

function resolveFlowPath(definition: Dict, path: string): ResolvedTarget | null {
    const { layerKey, graph, parts } = graphForPath(definition, path.split('.'));
    if (!graph) return null;
    let found: unknown = null;
    let topLevel = true;
    for (const part of parts) {
        const m = FLOW_STEP_RE.exec(part);
        if (!m) continue;
        const [, seg, tok] = m;
        found = flowSegmentNode(graph, seg, tok, topLevel) ?? found;
        if (seg === 'steps' && tok) topLevel = false;
    }
    return found ? flowHit(layerKey, graph, found) : null;
}

function resolveFlowNode(definition: Dict, nodeId: string): ResolvedTarget | null {
    for (const { key, graph } of graphsOf(definition)) {
        if (idOf(graph.trigger) === nodeId) return flowHit(key, graph, graph.trigger);
        const triggers: unknown[] = Array.isArray(graph.triggers) ? graph.triggers : [];
        const trigger = triggers.find((t) => idOf(t) === nodeId);
        if (trigger) return flowHit(key, graph, trigger);
        const step = findNested(graph.steps, nodeId);
        if (step) return flowHit(key, graph, step);
    }
    return null;
}

// ── The one entry point ─────────────────────────────────────────────────────

type Walker = {
    byPath: (definition: Dict, path: string) => ResolvedTarget | null;
    byId: (definition: Dict, nodeId: string) => ResolvedTarget | null;
};

const WALKERS: Record<TargetKind, Walker> = {
    app: { byPath: resolveAppPath, byId: resolveAppNode },
    automation: { byPath: resolveFlowPath, byId: resolveFlowNode },
};

/**
 * @param {object} definition  an app or automation definition
 * @param {{ path?: string, nodeId?: string, kind?: 'app'|'automation' }} ref
 * @returns {{ kind, screenId, screenName, nodeId, label, labelIsText } | null}
 */
export function resolveTarget(definition: unknown, ref: TargetRef = {}): ResolvedTarget | null {
    if (!isObject(definition) || typeof ref !== 'object' || ref === null || Array.isArray(ref)) return null;
    const kind = ref.kind || detectKind(definition);
    const walker = kind ? WALKERS[kind] : undefined;
    if (!walker) return null;
    if (typeof ref.path === 'string' && ref.path) {
        const hit = walker.byPath(definition, ref.path);
        if (hit) return hit;
    }
    if (ref.nodeId != null && ref.nodeId !== '') {
        return walker.byId(definition, String(ref.nodeId));
    }
    return null;
}

export default resolveTarget;

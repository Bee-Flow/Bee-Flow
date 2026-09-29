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

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function idOf(node) { return node?.id != null && node.id !== '' ? String(node.id) : null; }

/** The kind of definition this is, from its shape; null when it is neither. */
export function detectKind(definition) {
    if (!isObject(definition)) return null;
    if (Array.isArray(definition.screens)) return 'app';
    if (Array.isArray(definition.steps) || isObject(definition.trigger) || isObject(definition.layers)) return 'automation';
    return null;
}

/** The node's own words, trimmed and capped, or null. */
function ownText(...candidates) {
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim().slice(0, LABEL_MAX);
    }
    return null;
}

function display(text, type, id) {
    if (text) return { label: text, labelIsText: true };
    if (typeof type === 'string' && type) return { label: type, labelIsText: false };
    return { label: id, labelIsText: false };
}

function appNodeDisplay(node) {
    const props = isObject(node?.props) ? node.props : {};
    return display(ownText(props.label, props.title, props.text, props.heading), node?.type, idOf(node));
}

function flowNodeDisplay(node) {
    // A step has a `type`; a trigger has a `kind` (schedule, form, …).
    return display(ownText(node?.title, node?.name, node?.label), node?.type ?? node?.kind, idOf(node));
}

// ── App: screens → sections → children ──────────────────────────────────────

function appHit(screen, node) {
    const screenId = idOf(screen);
    const named = node
        ? appNodeDisplay(node)
        : { label: ownText(screen?.name) || screenId, labelIsText: !!ownText(screen?.name) };
    return {
        kind: 'app',
        screenId,
        screenName: screen?.name || null,
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
function resolveAppPath(definition, path) {
    let screen = null;
    let cursor = null;
    let node = null;
    for (const part of path.split('.')) {
        const m = APP_STEP_RE.exec(part);
        if (!m) break;
        const list = m[1] === 'screens' ? definition.screens : cursor?.[m[1]];
        cursor = Array.isArray(list) ? list[Number(m[2])] : null;
        if (!isObject(cursor)) break;
        if (m[1] === 'screens') screen = cursor;
        else if (idOf(cursor)) node = cursor;
    }
    return screen ? appHit(screen, node) : null;
}

function resolveAppNode(definition, nodeId) {
    for (const screen of definition.screens) {
        if (!isObject(screen)) continue;
        let found = null;
        const walk = (nodes) => {
            for (const n of Array.isArray(nodes) ? nodes : []) {
                if (found) return;
                if (idOf(n) === nodeId) { found = n; return; }
                if (isObject(n) && Array.isArray(n.children)) walk(n.children);
            }
        };
        for (const section of Array.isArray(screen.sections) ? screen.sections : []) {
            if (found) break;
            if (idOf(section) === nodeId) { found = section; break; }
            walk(section?.children);
        }
        if (found) return appHit(screen, found);
    }
    return null;
}

// ── Automation: root graph + layers, triggers + nested steps ────────────────

function walkFlowSteps(steps, fn) {
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

function graphsOf(definition) {
    const out = [{ key: null, graph: definition }];
    if (isObject(definition.layers)) {
        for (const [key, layer] of Object.entries(definition.layers)) {
            if (isObject(layer)) out.push({ key, graph: layer });
        }
    }
    return out;
}

function flowHit(layerKey, graph, node) {
    return {
        kind: 'automation',
        screenId: layerKey,
        screenName: layerKey ? (ownText(graph?.title) || null) : null,
        nodeId: idOf(node),
        ...flowNodeDisplay(node),
    };
}

/** One `steps[…]` / `triggers[…]` token against a list: an id, or an index. */
function byToken(list, tok) {
    if (!Array.isArray(list)) return null;
    const hit = list.find((s) => isObject(s) && idOf(s) === tok);
    if (hit) return hit;
    if (!/^\d+$/.test(tok)) return null;
    const at = list[Number(tok)];
    return isObject(at) && idOf(at) ? at : null;
}

/** The step with this id anywhere in `steps` — loop bodies and branches included. */
function findNested(steps, id) {
    let nested = null;
    walkFlowSteps(steps, (s) => { if (idOf(s) === id) { nested = s; return true; } return false; });
    return nested;
}

/** Enter the layer a path names (`layers.<key>.…`), or stay on the root graph. */
function graphForPath(definition, parts) {
    if (parts[0] !== 'layers') return { layerKey: null, graph: definition, parts };
    const layerKey = parts[1] || null;
    const graph = layerKey && isObject(definition.layers) ? definition.layers[layerKey] : null;
    return { layerKey, graph: isObject(graph) ? graph : null, parts: parts.slice(2) };
}

/**
 * One path segment against the graph: the node it addresses, or null. The
 * first `steps[…]` is the top-level list (index or id); anything after it is
 * a loop body / parallel branch, always addressed by id.
 */
function flowSegmentNode(graph, seg, tok, topLevel) {
    if (seg === 'trigger') return !tok && idOf(graph.trigger) ? graph.trigger : null;
    if (seg === 'triggers') return tok ? byToken(graph.triggers, tok) : null;
    if (!tok || tok === '?') return null;
    return topLevel ? byToken(graph.steps, tok) : findNested(graph.steps, tok);
}

function resolveFlowPath(definition, path) {
    const { layerKey, graph, parts } = graphForPath(definition, path.split('.'));
    if (!graph) return null;
    let found = null;
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

function resolveFlowNode(definition, nodeId) {
    for (const { key, graph } of graphsOf(definition)) {
        if (idOf(graph.trigger) === nodeId) return flowHit(key, graph, graph.trigger);
        const trigger = (Array.isArray(graph.triggers) ? graph.triggers : []).find((t) => idOf(t) === nodeId);
        if (trigger) return flowHit(key, graph, trigger);
        const step = findNested(graph.steps, nodeId);
        if (step) return flowHit(key, graph, step);
    }
    return null;
}

// ── The one entry point ─────────────────────────────────────────────────────

const WALKERS = {
    app: { byPath: resolveAppPath, byId: resolveAppNode },
    automation: { byPath: resolveFlowPath, byId: resolveFlowNode },
};

/**
 * @param {object} definition  an app or automation definition
 * @param {{ path?: string, nodeId?: string, kind?: 'app'|'automation' }} ref
 * @returns {{ kind, screenId, screenName, nodeId, label, labelIsText } | null}
 */
export function resolveTarget(definition, ref = {}) {
    if (!isObject(definition) || !isObject(ref)) return null;
    const walker = WALKERS[ref.kind || detectKind(definition)];
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

/**
 * Field-level diff between two automation definitions, and the plain-language
 * description of it (Studio → Automations handoff 5, artboard 5d).
 *
 *   fieldDiff(prev, next, opts)   → [{ stepId, stepNumber, stepLabel, change,
 *                                      setting, settingLabel, path, before, after }]
 *   describeChange(changes, opts) → { entries: [{ code, params }], text }
 *   describeVersion(prev, next)   → { layoutOnly, changes, entries, text }
 *   isLayoutOnlyChange(prev, next)
 *
 * `change` is 'added' | 'removed' | 'changed' | 'moved'. `setting` is a short
 * code ('prompt', 'folder', 'schedule'), `settingLabel` its English label and
 * `path` the dotted key inside the step ('inputs.folder'). Values come back as
 * short readable strings: a binding reads "Read invoice › files", a tool reads
 * "Nextcloud · Upload file", a long prompt is cut at 140 characters. An id is
 * turned into a name when the caller hands one in (`opts.names`).
 *
 * LAYOUT is what moves on the canvas without changing what the routine does:
 * node positions and sizes, colours and icons, edge colours and the PII line
 * colours. Those never show up in the diff, and a save that changes nothing
 * else is "layout only": it does not create a version (stores/automationStore/
 * automations.js), the next real save carries the positions.
 *
 * Descriptions are CODES plus params so the UI can translate them
 * (agent-hub versions/versionText.ts); `text` is the English fallback.
 *
 * Pure: no store, no network.
 */

'use strict';

const { isPick, isCompose, describeSource } = require('../shared/mapping/index.mjs');

// ── Layout ───────────────────────────────────────────────────────────────

const LAYOUT_NODE_KEYS = Object.freeze(['position', 'size', 'width', 'height', 'color', 'icon', 'iconManual', 'labelManual']);
const LAYOUT_EDGE_KEYS = Object.freeze(['color']);
const LAYOUT_GRAPH_KEYS = Object.freeze(['piiLineColors']);
// Keys of a definition (or a flowlet) that hold the graph itself.
const GRAPH_KEYS = new Set(['trigger', 'triggers', 'steps', 'edges', 'layers']);
// A step's children are compared as nodes of their own, not as a setting.
const CHILD_KEYS = new Set(['body', 'branches']);

const MAX_TEXT = 140;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function asArray(v) { return Array.isArray(v) ? v : []; }

function stable(v) {
    const sort = (x) => {
        if (Array.isArray(x)) return x.map(sort);
        if (isObject(x)) {
            const out = {};
            for (const k of Object.keys(x).sort()) if (x[k] !== undefined) out[k] = sort(x[k]);
            return out;
        }
        return x;
    };
    return JSON.stringify(sort(v ?? null));
}

function clone(v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v));
}

/** Visit every node of one graph: its triggers and its steps, nested ones too. */
function forEachNode(graph, fn) {
    if (!isObject(graph)) return;
    if (isObject(graph.trigger)) fn(graph.trigger, { isTrigger: true, parentId: null });
    for (const t of asArray(graph.triggers)) if (isObject(t)) fn(t, { isTrigger: true, parentId: null });
    const walk = (steps, parentId) => {
        for (const s of asArray(steps)) {
            if (!isObject(s)) continue;
            fn(s, { isTrigger: false, parentId });
            if (s.type === 'loop') walk(s.body, s.id ?? null);
            if (s.type === 'parallel') for (const b of asArray(s.branches)) walk(b, s.id ?? null);
        }
    };
    walk(graph.steps, null);
}

/** The root graph and every flowlet, as [layerKey|null, graph]. */
function graphsOf(def) {
    const out = [[null, isObject(def) ? def : {}]];
    if (isObject(def) && isObject(def.layers)) {
        for (const [k, g] of Object.entries(def.layers)) if (isObject(g)) out.push([k, g]);
    }
    return out;
}

/** A copy of the definition without anything that is only layout. */
function stripLayout(def) {
    const out = clone(isObject(def) ? def : {}) || {};
    for (const [, graph] of graphsOf(out)) {
        for (const k of LAYOUT_GRAPH_KEYS) delete graph[k];
        forEachNode(graph, (node) => { for (const k of LAYOUT_NODE_KEYS) delete node[k]; });
        for (const e of asArray(graph.edges)) if (isObject(e)) for (const k of LAYOUT_EDGE_KEYS) delete e[k];
    }
    return out;
}

/** True when the two definitions differ in layout only (or not at all). */
function isLayoutOnlyChange(prevDef, nextDef) {
    return stable(stripLayout(prevDef)) === stable(stripLayout(nextDef));
}

// ── Run order and step numbers (mirrors agent-hub Builder/flow/flowOrder.js) ──

/** The node ids of one graph in the order they run; see flowOrder.js. */
function flowOrder(graph) {
    const steps = asArray(graph?.steps).filter(Boolean);
    const roots = [graph?.trigger, ...asArray(graph?.triggers)].filter((t) => t && t.id);
    const index = new Map();
    [...roots, ...steps].forEach((n, i) => { if (n?.id != null && !index.has(n.id)) index.set(n.id, i); });
    if (!index.size) return [];
    const edges = asArray(graph?.edges).filter((e) => e && index.has(e.from) && index.has(e.to));
    const outgoing = new Map();
    const indegree = new Map([...index.keys()].map((id) => [id, 0]));
    edges.forEach((e, order) => {
        if (!outgoing.has(e.from)) outgoing.set(e.from, []);
        outgoing.get(e.from).push({ to: e.to, order });
        indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
    });
    const byIndex = (a, b) => index.get(a) - index.get(b);
    const ready = [...index.keys()].filter((id) => (indegree.get(id) || 0) === 0).sort(byIndex);
    const out = [];
    const seen = new Set();
    while (ready.length) {
        const id = ready.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        for (const { to } of (outgoing.get(id) || []).slice().sort((a, b) => a.order - b.order)) {
            const left = (indegree.get(to) || 0) - 1;
            indegree.set(to, left);
            if (left <= 0 && !seen.has(to)) { ready.push(to); ready.sort(byIndex); }
        }
    }
    for (const id of index.keys()) if (!seen.has(id)) out.push(id);
    return out;
}

/** id → the number the canvas shows (1, 2, 3… in run order, notes skipped). */
function stepNumbers(graph) {
    const typeOf = new Map();
    for (const t of [graph?.trigger, ...asArray(graph?.triggers)]) if (t?.id) typeOf.set(t.id, 'trigger');
    for (const s of asArray(graph?.steps)) if (s?.id) typeOf.set(s.id, s.type);
    const out = new Map();
    let n = 0;
    for (const id of flowOrder(graph)) {
        if (typeOf.get(id) === 'note') continue;
        n += 1;
        out.set(id, n);
    }
    return out;
}

// ── Labels ───────────────────────────────────────────────────────────────

const APP_NAMES = {
    nextcloud: 'Nextcloud', gmail: 'Gmail', gcal: 'Google Calendar', calendar: 'Calendar', drive: 'Google Drive',
    msgraph: 'Microsoft 365', outlook: 'Outlook', teams: 'Teams', slack: 'Slack', github: 'GitHub',
    webpage: 'Web page', knowledge: 'Knowledge base', support: 'Support', talk: 'Talk', deck: 'Deck',
};

function sentence(s) {
    const words = String(s || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .trim()
        .toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** 'nextcloud_upload_file' → 'Nextcloud · Upload file'. */
function toolLabel(tool) {
    if (typeof tool !== 'string' || !tool) return null;
    const [head, ...rest] = tool.split('_');
    const app = APP_NAMES[head];
    if (!app || !rest.length) return sentence(tool);
    return `${app} · ${sentence(rest.join('_'))}`;
}

const TRIGGER_LABELS = {
    manual: 'Start manually', schedule: 'On a schedule', webhook: 'Webhook', form: 'Form filled in',
    app_event: 'Something in an app', agent_call: 'Called by an agent', layer_input: 'Flowlet input',
    email: 'E-mail received', file: 'New file',
};

const STEP_TYPE_LABELS = {
    ai_step: 'AI step', ai_tool: 'AI tool', data_extraction: 'Extract data', condition: 'Condition', switch: 'Switch',
    loop: 'For each', parallel: 'In parallel', code: 'Code', notification: 'Notification', approval: 'Approval',
    form_page: 'Form page', wait: 'Wait', set: 'Set fields', datatable: 'Datatable', generate_document: 'Document',
    fill_document: 'Fill a document', presentation: 'Presentation', slide: 'Slide', knowledge_write: 'Save to knowledge base',
    parse_json: 'Read fields', guard: 'Privacy check', tokenize: 'Hide personal data', call_layer: 'Flowlet',
    call_block: 'Building block', layer_output: 'Flowlet result', http_request: 'Web request', datetime: 'Date and time',
    filter: 'Filter', limit: 'Limit', dedupe: 'Remove duplicates', aggregate: 'Combine', summarize: 'Summarise',
    stop_error: 'Stop with an error', return_to_app: 'Back to the app', note: 'Note',
};

/** What kind of node this is, in words. */
function kindLabel(node, isTrigger) {
    if (isTrigger || node?.type === 'trigger') {
        const base = TRIGGER_LABELS[node?.kind] || 'Start';
        const provider = node?.appEvent?.provider || node?.provider;
        return node?.kind === 'app_event' && provider ? `${APP_NAMES[provider] || sentence(provider)} event` : base;
    }
    if (node?.type === 'integration_action' || (node?.tool && !STEP_TYPE_LABELS[node?.type])) return toolLabel(node.tool) || 'Action';
    return STEP_TYPE_LABELS[node?.type] || sentence(node?.type) || 'Step';
}

/** The name a person sees on the card. */
function nodeLabel(node, isTrigger) {
    if (typeof node?.label === 'string' && node.label.trim()) return node.label.trim();
    if (typeof node?.title === 'string' && node.title.trim() && node.type === 'note') return node.title.trim();
    return kindLabel(node, isTrigger);
}

// Setting codes and English labels. Key = the dotted path inside the step;
// the code defaults to the last segment.
const SETTING_LABELS = {
    type: 'Step type', label: 'Name', prompt: 'Instruction', instructions: 'Instructions', tool: 'Action',
    modelTier: 'Model', model: 'Model', agentId: 'Agent', skillIds: 'Skills', disabledAgentSkillIds: 'Agent skills',
    agentPermissions: 'What the agent may do', expr: 'Condition', cases: 'Cases', defaultBranch: 'Otherwise',
    overRef: 'List to go through', itemVar: 'Item name', maxIterations: 'Maximum rounds', channels: 'Channels',
    title: 'Title', message: 'Message', text: 'Text', code: 'Code', seconds: 'Wait time', datatableId: 'Table',
    knowledgeBaseId: 'Knowledge base', knowledgeBaseIds: 'Knowledge bases', documentId: 'Document', format: 'Format',
    fileName: 'File name', content: 'Content', outputSchema: 'Output fields', fields: 'Fields', where: 'Filter',
    op: 'Operation', approval: 'Approval', form: 'Form', onError: 'When it fails', forEach: 'For each item',
    schedule: 'Schedule', cron: 'Schedule', tz: 'Time zone', appEvent: 'Event', event: 'Event', provider: 'App',
    filter: 'Filter', url: 'Address', method: 'Method', headers: 'Headers', categories: 'Categories',
    sourceRef: 'Source', source: 'Source', timeoutMs: 'Time limit', values: 'Values', matchColumn: 'Match on',
    folder: 'Folder', path: 'Path', to: 'Recipient', recipient: 'Recipient', subject: 'Subject',
    description: 'Description', runPolicy: 'Run settings', retry: 'If a step fails', maxDurationMin: 'Maximum duration',
    concurrency: 'Running at the same time', retentionDays: 'Keep runs', notificationSettings: 'Notifications',
    appButtons: 'App buttons', manualTriggerPayload: 'Test input', skipHolidays: 'Skip public holidays',
    pinnedOutput: 'Pinned sample', assignee: 'Approver', approvers: 'Approvers',
};
// Input names that mean "a folder", whatever the tool calls them.
const FOLDER_KEYS = new Set(['folder', 'folderPath', 'dir', 'directory', 'targetFolder', 'destinationFolder', 'parentPath']);

function settingOf(pathParts) {
    const last = pathParts[pathParts.length - 1];
    const code = FOLDER_KEYS.has(last) ? 'folder' : last;
    const label = SETTING_LABELS[pathParts.join('.')] || SETTING_LABELS[code] || sentence(last);
    return { setting: code, settingLabel: label, path: pathParts.join('.') };
}

// ── Values as short readable text ──────────────────────────────────────

function cut(s) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);
// A pick or a compose (the v2 mapping) is one value too: compared and shown
// whole, never as its from/take/as parts.
function isBinding(v) { return (isObject(v) && BINDING_KINDS.has(v.kind) && ('value' in v || 'path' in v)) || isPick(v) || isCompose(v); }

function makeRenderer({ labels = new Map(), names = {} } = {}) {
    const refText = (raw) => {
        const p = String(raw || '').trim();
        let m = /^trigger\.output\.?(.*)$/.exec(p);
        if (m) return m[1] ? `Start › ${m[1]}` : 'Start';
        m = /^steps\.([^.]+)\.output\.?(.*)$/.exec(p) || /^steps\.([^.]+)\.?(.*)$/.exec(p);
        if (m) {
            const who = labels.get(m[1]) || m[1];
            return m[2] ? `${who} › ${m[2]}` : who;
        }
        m = /^loop\.[^.]+\.?(.*)$/.exec(p);
        if (m) return m[1] ? `Current item › ${m[1]}` : 'Current item';
        return p;
    };
    const templateText = (s) => String(s).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, inner) => `‹${refText(inner)}›`);

    const render = (v, key) => {
        if (v === undefined || v === null || v === '') return null;
        if (typeof v === 'boolean') return v ? 'on' : 'off';
        if (typeof v === 'number') return String(v);
        if (typeof v === 'string') {
            if (key === 'tool') return toolLabel(v);
            if (key === 'agentId' && names.agent?.[v]) return names.agent[v];
            if (key === 'datatableId' && names.datatable?.[v]) return names.datatable[v];
            if (key === 'knowledgeBaseId' && names.knowledgeBase?.[v]) return names.knowledgeBase[v];
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored alternation, no repeat: linear
            if ((key === 'overRef' || key === 'sourceRef' || key === 'arrayRef') && /^(trigger|steps|loop)\./.test(v)) return cut(refText(v));
            return cut(templateText(v));
        }
        // The v2 mapping: a pick by its label (else its path, read the way a
        // ref is), a compose as its text with each value in ‹ ›.
        if (isPick(v)) return cut(v.label || refText(describeSource(v.from)));
        if (isCompose(v)) {
            return cut(v.parts.map((p) => (typeof p === 'string' ? p : `‹${p.label || refText(describeSource(p.from))}›`)).join(''));
        }
        if (isBinding(v)) {
            if (v.kind === 'ref') return cut(refText(v.path));
            if (v.kind === 'template') return render(typeof v.value === 'string' ? v.value : '', key);
            if (v.kind === 'expr') return cut(String(v.value ?? ''));
            return render(v.value, key);
        }
        if (Array.isArray(v)) {
            if (!v.length) return null;
            if (v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x) || isBinding(x))) {
                return cut(v.map((x) => render(x, key)).filter(Boolean).join(', '));
            }
            const named = v.map((x) => (isObject(x) ? (x.label || x.name || x.title) : null)).filter((x) => typeof x === 'string' && x);
            if (named.length === v.length) return cut(named.join(', '));
            return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
        }
        if (isObject(v)) {
            for (const k of ['label', 'name', 'title']) if (typeof v[k] === 'string' && v[k].trim()) return cut(v[k]);
            const entries = Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== '');
            if (!entries.length) return null;
            if (entries.every(([, x]) => ['string', 'number', 'boolean'].includes(typeof x) || isBinding(x))) {
                return cut(entries.map(([k, x]) => `${sentence(k)}: ${render(x, k)}`).join(', '));
            }
            return `${entries.length} ${entries.length === 1 ? 'setting' : 'settings'}`;
        }
        return cut(String(v));
    };
    return { render, refText };
}

// ── The diff ─────────────────────────────────────────────────────────────

/** Every node of a definition, keyed so flowlet steps never collide with root ones. */
function indexNodes(def) {
    const nodes = new Map();
    const labels = new Map();
    for (const [layer, graph] of graphsOf(def)) {
        const numbers = layer === null ? stepNumbers(graph) : new Map();
        const incoming = new Map();
        for (const e of asArray(graph.edges)) {
            if (!isObject(e) || e.to == null) continue;
            const list = incoming.get(String(e.to)) || [];
            list.push({ from: String(e.from), label: e.label || null, caseName: e.caseName ?? null });
            incoming.set(String(e.to), list);
        }
        forEachNode(graph, (node, { isTrigger, parentId }) => {
            if (node.id == null) return;
            const id = String(node.id);
            const key = `${layer ?? ''}::${id}`;
            if (nodes.has(key)) return;
            const label = nodeLabel(node, isTrigger);
            if (layer === null) labels.set(id, label);
            nodes.set(key, {
                id, layer, node, isTrigger, parentId,
                label,
                layerTitle: layer === null ? null : (typeof graph.title === 'string' && graph.title.trim() ? graph.title.trim() : layer),
                number: parentId === null ? (numbers.get(id) ?? null) : null,
                incoming: (incoming.get(id) || []).sort((a, b) => stable(a).localeCompare(stable(b))),
            });
        });
    }
    return { nodes, labels };
}

/** Plain objects are compared one level deeper; anything else is one setting. */
function diffSettings(a, b, parts, out, depth) {
    if (stable(a) === stable(b)) return;
    if (depth < 2 && isObject(a) && isObject(b) && !isBinding(a) && !isBinding(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffSettings(a[k], b[k], [...parts, k], out, depth + 1);
        return;
    }
    // One side missing: its keys are the settings that appeared or went.
    if (depth < 2 && ((isObject(a) && !isBinding(a) && b == null) || (isObject(b) && !isBinding(b) && a == null))) {
        const obj = a ?? b;
        for (const k of Object.keys(obj)) diffSettings(a?.[k], b?.[k], [...parts, k], out, depth + 1);
        return;
    }
    out.push({ parts, before: a, after: b });
}

function stepText(n) {
    return n.layerTitle ? `${n.layerTitle} › ${n.label}` : n.label;
}

function incomingText(list, labels) {
    if (!list.length) return null;
    return cut(list.map((e) => `after ${labels.get(e.from) || e.from}${e.label ? ` (${e.label.replace(/^case:/, '')})` : ''}`).join(', '));
}

/**
 * Per-field changes of `next` relative to `prev`.
 *
 * @param {object} prevDef
 * @param {object} nextDef
 * @param {{ names?: { agent?: Record<string,string>, datatable?: Record<string,string>, knowledgeBase?: Record<string,string> } }} [opts]
 */
function fieldDiff(prevDef, nextDef, opts = {}) {
    const prev = stripLayout(prevDef);
    const next = stripLayout(nextDef);
    const P = indexNodes(prev);
    const N = indexNodes(next);
    const before = makeRenderer({ labels: P.labels, names: opts.names });
    const after = makeRenderer({ labels: N.labels, names: opts.names });
    const changes = [];
    const base = (n) => ({
        stepId: n.id, stepNumber: n.number, stepLabel: stepText(n),
        ...(n.layer ? { layer: n.layer } : {}),
        ...(n.isTrigger ? { isTrigger: true } : {}),
    });

    for (const [key, n] of N.nodes) {
        const p = P.nodes.get(key);
        if (!p) {
            changes.push({ ...base(n), change: 'added', setting: null, settingLabel: null, path: null, before: null, after: kindLabel(n.node, n.isTrigger) });
            continue;
        }
        const diffs = [];
        const keys = new Set([...Object.keys(p.node), ...Object.keys(n.node)]);
        for (const k of keys) {
            if (k === 'id' || (CHILD_KEYS.has(k) && (n.node.type === 'loop' || n.node.type === 'parallel'))) continue;
            diffSettings(p.node[k], n.node[k], [k], diffs, 0);
        }
        for (const d of diffs) {
            const last = d.parts[d.parts.length - 1];
            changes.push({
                ...base(n), change: 'changed', ...settingOf(d.parts),
                before: before.render(d.before, last), after: after.render(d.after, last),
            });
        }
        if (!n.isTrigger && stable(p.incoming) !== stable(n.incoming)) {
            changes.push({
                ...base(n), change: 'moved', setting: 'flowPosition', settingLabel: 'Position in the flow', path: null,
                before: incomingText(p.incoming, P.labels), after: incomingText(n.incoming, N.labels),
            });
        }
    }
    for (const [key, p] of P.nodes) {
        if (N.nodes.has(key)) continue;
        changes.push({ ...base(p), change: 'removed', setting: null, settingLabel: null, path: null, before: kindLabel(p.node, p.isTrigger), after: null });
    }

    // Routine-level settings (outside the graph), then each flowlet's own.
    const routineDiffs = [];
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (GRAPH_KEYS.has(k)) continue;
        diffSettings(prev[k], next[k], [k], routineDiffs, 0);
    }
    for (const d of routineDiffs) {
        const last = d.parts[d.parts.length - 1];
        changes.push({
            stepId: null, stepNumber: null, stepLabel: 'Routine', change: 'changed', ...settingOf(d.parts),
            before: before.render(d.before, last), after: after.render(d.after, last),
        });
    }
    const layerKeys = new Set([...Object.keys(isObject(prev.layers) ? prev.layers : {}), ...Object.keys(isObject(next.layers) ? next.layers : {})]);
    for (const lk of layerKeys) {
        const pl = isObject(prev.layers?.[lk]) ? prev.layers[lk] : {};
        const nl = isObject(next.layers?.[lk]) ? next.layers[lk] : {};
        const ld = [];
        for (const k of new Set([...Object.keys(pl), ...Object.keys(nl)])) if (!GRAPH_KEYS.has(k)) diffSettings(pl[k], nl[k], [k], ld, 0);
        const title = (typeof nl.title === 'string' && nl.title.trim()) || (typeof pl.title === 'string' && pl.title.trim()) || lk;
        for (const d of ld) {
            const last = d.parts[d.parts.length - 1];
            changes.push({
                stepId: `layer:${lk}`, stepNumber: null, stepLabel: `Flowlet ${title}`, layer: lk, change: 'changed', ...settingOf(d.parts),
                before: before.render(d.before, last), after: after.render(d.after, last),
            });
        }
    }

    const ORDER = { added: 0, removed: 1, changed: 2, moved: 3 };
    return changes.sort((a, b) => {
        const na = a.stepNumber ?? Number.MAX_SAFE_INTEGER;
        const nb = b.stepNumber ?? Number.MAX_SAFE_INTEGER;
        if (na !== nb) return na - nb;
        if ((a.stepId === null) !== (b.stepId === null)) return a.stepId === null ? 1 : -1;
        return ORDER[a.change] - ORDER[b.change];
    });
}

/** Step ids per kind of change, for the mini canvas badges. `moved` counts as changed. */
function stepIdsOf(changes) {
    const added = new Set();
    const removed = new Set();
    const changed = new Set();
    for (const c of changes) {
        if (!c.stepId || c.stepId.startsWith('layer:')) continue;
        if (c.change === 'added') added.add(c.stepId);
        else if (c.change === 'removed') removed.add(c.stepId);
        else changed.add(c.stepId);
    }
    for (const id of added) changed.delete(id);
    return { added: [...added], removed: [...removed], changed: [...changed] };
}

// ── Plain-language description ───────────────────────────────────────────

const PHRASES = {
    created: () => 'Created',
    created_from_template: (p) => `Created from template "${p.template}"`,
    duplicated_from: (p) => `Copied from "${p.title}"`,
    step_added: (p) => `Step added: "${p.step}"`,
    step_removed: (p) => `Step removed: "${p.step}"`,
    step_changed: (p) => `Changed "${p.step}"`,
    setting_changed: (p) => `${p.setting} changed in "${p.step}"`,
    step_renamed: (p) => `Step renamed to "${p.step}"`,
    steps_reordered: () => 'Steps reordered',
    connections_changed: () => 'Connections changed',
    trigger_changed: () => 'Start changed',
    settings_changed: () => 'Settings changed',
    description_changed: () => 'Description changed',
    restored: (p) => `Restored from v${p.version}`,
};

/** English text for a list of description entries: the first, and how many more. */
function describeText(entries) {
    const phrases = asArray(entries).map((e) => (PHRASES[e?.code] ? PHRASES[e.code](e.params || {}) : null)).filter(Boolean);
    if (!phrases.length) return null;
    if (phrases.length === 1) return phrases[0];
    return `${phrases[0]} and ${phrases.length - 1} more`;
}

/**
 * Turn field changes into description entries.
 *
 * @param {ReturnType<typeof fieldDiff>} changes
 * @param {{ reordered?: boolean }} [opts] steps or connections only changed ORDER
 * @returns {{ entries: Array<{code: string, params: object}>, text: string|null }}
 */
function describeChange(changes, { reordered = false } = {}) {
    const byStep = new Map();
    const routine = [];
    let moved = false;
    for (const c of asArray(changes)) {
        if (c.stepId === null) { routine.push(c); continue; }
        const k = `${c.layer || ''}::${c.stepId}`;
        if (!byStep.has(k)) byStep.set(k, []);
        byStep.get(k).push(c);
    }
    const added = [];
    const removed = [];
    const trigger = [];
    const changed = [];
    for (const list of byStep.values()) {
        const step = list[0].stepLabel;
        if (list.some((c) => c.change === 'added')) { added.push({ code: 'step_added', params: { step } }); continue; }
        if (list.some((c) => c.change === 'removed')) { removed.push({ code: 'step_removed', params: { step } }); continue; }
        if (list.some((c) => c.change === 'moved')) moved = true;
        const settings = list.filter((c) => c.change === 'changed');
        if (!settings.length) continue;
        if (list[0].isTrigger) { trigger.push({ code: 'trigger_changed', params: { step } }); continue; }
        if (settings.length === 1 && settings[0].setting === 'label') {
            changed.push({ code: 'step_renamed', params: { step: settings[0].after || step, from: settings[0].before || null } });
        } else if (settings.length === 1) {
            changed.push({ code: 'setting_changed', params: { setting: settings[0].settingLabel, settingKey: settings[0].setting, step } });
        } else {
            changed.push({ code: 'step_changed', params: { step, count: settings.length } });
        }
    }
    const entries = [...added, ...removed, ...trigger, ...changed];
    if (moved) entries.push({ code: 'connections_changed', params: {} });
    const seen = new Set();
    let description = false;
    for (const c of routine) {
        const top = (c.path || c.setting || '').split('.')[0];
        if (top === 'description') { description = true; continue; }
        if (seen.has(top)) continue;
        seen.add(top);
        entries.push({ code: 'settings_changed', params: { setting: SETTING_LABELS[top] || sentence(top), settingKey: top } });
    }
    if (description) entries.push({ code: 'description_changed', params: {} });
    if (!entries.length && reordered) entries.push({ code: 'steps_reordered', params: {} });
    return { entries, text: describeText(entries) };
}

/**
 * Everything a version row needs about prev → next: whether it is layout only
 * (then no version is written), the field changes and their description.
 */
function describeVersion(prevDef, nextDef, opts = {}) {
    const layoutOnly = isLayoutOnlyChange(prevDef, nextDef);
    if (layoutOnly) return { layoutOnly: true, changes: [], entries: [], text: null };
    const changes = fieldDiff(prevDef, nextDef, opts);
    // Nothing a person can point at, yet not layout: the order of steps[] or
    // edges[] moved. The routine works the same.
    const reordered = changes.length === 0;
    const { entries, text } = describeChange(changes, { reordered });
    return { layoutOnly: false, changes, entries, text };
}

module.exports = {
    LAYOUT_NODE_KEYS,
    stripLayout,
    isLayoutOnlyChange,
    flowOrder,
    stepNumbers,
    toolLabel,
    fieldDiff,
    stepIdsOf,
    describeChange,
    describeText,
    describeVersion,
};

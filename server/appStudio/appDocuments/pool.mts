/**
 * Which Studio documents an app may show to a viewer: the app's DOCUMENT POOL.
 *
 * An app runs acts-as-owner (fill_document's rule): it reads documents as its
 * owner. But a document component's binding can be steered by the viewer — a
 * formula over a variable, a record field they wrote, an action result — so
 * "the owner can read it" is not enough on its own: that would turn any app
 * with a viewer into a window on the owner's whole library. The pool is what
 * the BUILDER put into the app, as far as this viewer's role reaches:
 *
 *   - a fixed id (static binding) in a document_viewer / document_compare,
 *   - a picker's own allow-list: `documentIds`, and `folderId` (an owner folder),
 *   - a fixed id in a copy_document step (source, templateDocumentId) of an
 *     action this role can reach.
 *
 * Plus, checked by the reader, the copies this app made itself
 * (settings.createdByApp). Screens and nodes the role cannot see add nothing,
 * so a document behind an admin-only screen stays behind it.
 *
 * The role checks are injected (routes/studioAppRunGate: roleAllows,
 * actionRoleAccess) so the routes' one copy of the rule is the one used here.
 * Pure: no I/O.
 */

export const DOCUMENT_COMPONENT_TYPES: readonly string[] = Object.freeze(['document_viewer', 'document_compare', 'input_document']);
/** The props of each document component that hold a document reference. */
const REF_PROPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    document_viewer: ['source'],
    document_compare: ['left', 'right'],
});
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface DocumentRef { documentId: string; versionId: string | null }

/**
 * A document reference as a binding may resolve to it: "id", "id@versionId",
 * { documentId, versionId? } (copy_document's result) or { id }. Anything
 * else is no reference.
 */
export function parseDocumentRef(value: unknown): DocumentRef | null {
    if (typeof value === 'string') {
        const [id, version] = value.trim().split('@');
        if (!id || !ID_RE.test(id)) return null;
        if (version !== undefined && !ID_RE.test(version)) return null;
        return { documentId: id, versionId: version || null };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const o = value as Record<string, unknown>;
        const id = typeof o.documentId === 'string' ? o.documentId : (typeof o.id === 'string' ? o.id : '');
        if (!ID_RE.test(id)) return null;
        const version = typeof o.versionId === 'string' && ID_RE.test(o.versionId) ? o.versionId : null;
        return { documentId: id, versionId: version };
    }
    return null;
}

/** Where a sequence keeps child steps (actionSequence.flattenSteps walks the same slots). */
const CHILD_STEP_SLOTS = ['steps', 'then', 'else', 'default'] as const;

/**
 * Every step of an action of this kind, in any branch. A walk of its own
 * rather than actionSequence.flattenSteps: that module loads the whole
 * executor, and this one only looks for one kind of step.
 */
function stepsOfKind(action: unknown, kind: string, out: Array<Record<string, unknown>> = [], depth = 0): Array<Record<string, unknown>> {
    if (!action || typeof action !== 'object' || depth > 20) return out;
    const step = action as Record<string, unknown>;
    if (step.kind === kind) out.push(step);
    for (const slot of CHILD_STEP_SLOTS) {
        const list = step[slot];
        if (Array.isArray(list)) for (const child of list) stepsOfKind(child, kind, out, depth + 1);
    }
    if (Array.isArray(step.cases)) for (const c of step.cases) stepsOfKind({ steps: (c as { steps?: unknown })?.steps }, kind, out, depth + 1);
    return out;
}

/** The id a STATIC binding pins, or null (a dynamic binding pins nothing). */
function staticId(binding: unknown): string | null {
    if (!binding || typeof binding !== 'object') return null;
    const b = binding as { kind?: unknown; value?: unknown };
    if (b.kind !== 'static') return null;
    return parseDocumentRef(b.value)?.documentId ?? null;
}

export interface PoolChecks {
    /** May this viewer see the screen or node (visibleToRoles)? */
    visible: (nodeOrScreen: unknown) => boolean;
    /** May this viewer reach the action through the UI? */
    actionAllowed: (actionId: string) => boolean;
}

export interface DocumentPool { ids: Set<string>; folderIds: Set<string> }

type AnyNode = { id?: unknown; type?: unknown; props?: Record<string, unknown>; children?: unknown };
type AnyDef = { screens?: unknown; actions?: unknown };

/** Every node the viewer can see, with its screen. */
function* visibleNodes(def: AnyDef, checks: PoolChecks): Generator<AnyNode> {
    function* walk(nodes: unknown): Generator<AnyNode> {
        for (const node of Array.isArray(nodes) ? nodes : []) {
            if (!node || typeof node !== 'object' || !checks.visible(node)) continue;
            yield node as AnyNode;
            yield* walk((node as AnyNode).children);
        }
    }
    for (const screen of Array.isArray(def?.screens) ? def.screens : []) {
        if (!screen || typeof screen !== 'object' || !checks.visible(screen)) continue;
        for (const section of Array.isArray((screen as { sections?: unknown }).sections) ? (screen as { sections: unknown[] }).sections : []) {
            yield* walk((section as { children?: unknown })?.children);
        }
    }
}

/** A picker's own allow-list. */
export function pickerScope(node: AnyNode): { ids: string[]; folderId: string | null; kind: string } {
    const props = node.props || {};
    const ids = (Array.isArray(props.documentIds) ? props.documentIds : [])
        .map((v) => parseDocumentRef(v)?.documentId)
        .filter((v): v is string => !!v);
    const folderId = typeof props.folderId === 'string' && ID_RE.test(props.folderId) ? props.folderId : null;
    const kind = typeof props.kind === 'string' ? props.kind : 'any';
    return { ids: [...new Set(ids)], folderId, kind };
}

export function documentPool(def: AnyDef, checks: PoolChecks): DocumentPool {
    const ids = new Set<string>();
    const folderIds = new Set<string>();
    for (const node of visibleNodes(def, checks)) {
        const type = String(node.type || '');
        for (const prop of REF_PROPS[type] || []) {
            const id = staticId(node.props?.[prop]);
            if (id) ids.add(id);
        }
        if (type === 'input_document') {
            const scope = pickerScope(node);
            for (const id of scope.ids) ids.add(id);
            if (scope.folderId) folderIds.add(scope.folderId);
        }
    }
    const actions = def?.actions && typeof def.actions === 'object' ? def.actions as Record<string, unknown> : {};
    for (const [actionId, action] of Object.entries(actions)) {
        const steps = stepsOfKind(action, 'copy_document');
        if (!steps.length || !checks.actionAllowed(actionId)) continue;
        for (const step of steps) {
            const id = staticId(step.source);
            if (id) ids.add(id);
            const template = typeof step.templateDocumentId === 'string' ? parseDocumentRef(step.templateDocumentId)?.documentId : null;
            if (template) ids.add(template);
        }
    }
    return { ids, folderIds };
}

/** The document component `nodeId`, if this viewer can see it; null otherwise. */
export function findDocumentNode(def: AnyDef, nodeId: string, checks: PoolChecks): AnyNode | null {
    for (const node of visibleNodes(def, checks)) {
        if (node.id === nodeId) return DOCUMENT_COMPONENT_TYPES.includes(String(node.type)) ? node : null;
    }
    return null;
}

/** Is this document in the pool (by id, or by sitting in a pooled folder of the owner)? */
export function inPool(pool: DocumentPool, doc: { id: string; folderId?: string | null; userId?: string }, ownerId: string): boolean {
    if (pool.ids.has(doc.id)) return true;
    return !!doc.folderId && doc.userId === ownerId && pool.folderIds.has(doc.folderId);
}

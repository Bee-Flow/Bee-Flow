/**
 * Contract readers for /api/playbooks, written from the server's own
 * serialisers (see model/types.ts for which file each shape comes from).
 * serverContract.test.ts pins those field lists.
 */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import type {
    AccessPlan,
    AppAccess,
    Artifacts,
    Phase,
    PhaseStatus,
    Playbook,
    PlaybookStatus,
    PlaybookSummary,
    Recipe,
    RecipeField,
    RecipeInput,
    TableChoice,
} from '../model/types';

const PHASE_STATUSES: readonly PhaseStatus[] = ['pending', 'ready', 'running', 'awaiting', 'done', 'failed', 'skipped', 'locked'];
const PLAYBOOK_STATUSES: readonly PlaybookStatus[] = ['active', 'stopped', 'done'];

const artifacts = field.record<Artifacts>({});

export const readPhase: (raw: unknown) => Phase = shapeOf({
    key: field.str(''),
    kind: field.strOrNull,
    label: field.strOrNull,
    // An unknown status reads as `pending`: nothing is offered on it.
    status: field.oneOf(PHASE_STATUSES, 'pending'),
    attempt: field.num(0),
    brief: field.strOrNull,
    artifacts,
    summary: field.strOrNull,
    error: field.strOrNull,
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    requires: field.strOrNull,
});

const phases = (value: unknown) => field.list(readPhase)(value).filter((p) => p.key !== '');

const readPlaybookBody: (raw: unknown) => Playbook = shapeOf({
    id: field.str(''),
    title: field.str(''),
    status: field.oneOf(PLAYBOOK_STATUSES, 'active'),
    recipeId: field.str(''),
    options: field.record<Record<string, unknown>>({}),
    phases,
    currentPhase: field.strOrNull,
    version: field.num(1),
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

/** `{ playbook }` → the entity, or null for a body without one. */
export function readPlaybook(raw: unknown): Playbook | null {
    const pb = nullable(readPlaybookBody)(pick(raw, 'playbook'));
    return pb && pb.id ? pb : null;
}

const readSummary: (raw: unknown) => PlaybookSummary = shapeOf({
    id: field.str(''),
    title: field.str(''),
    recipeLabel: field.strOrNull,
    status: field.oneOf(PLAYBOOK_STATUSES, 'active'),
    currentPhase: field.strOrNull,
    progress: shapeOf({ done: field.num(0), total: field.num(0), locked: field.num(0) }),
    phases: field.list(shapeOf({ key: field.str(''), kind: field.strOrNull, label: field.strOrNull, status: field.oneOf(PHASE_STATUSES, 'pending') })),
    updatedAt: field.strOrNull,
});

export function readPlaybookList(raw: unknown): PlaybookSummary[] {
    return withId(field.list(readSummary)(pick(raw, 'playbooks')));
}

const readInput: (raw: unknown) => RecipeInput = shapeOf({
    key: field.str(''),
    label: field.str(''),
    kind: field.str('text'),
    default: field.strOrNull,
    placeholder: field.strOrNull,
});

const readField: (raw: unknown) => RecipeField = shapeOf({ key: field.str(''), name: field.str(''), type: field.str('text') });

/** The composed recipe document: what the preview reads, plus the document itself to send back. */
export function readRecipe(raw: unknown): Recipe | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const doc = raw as Record<string, unknown>;
    const table = pick(doc, 'table');
    const rawPhases = Array.isArray(doc.phases) ? doc.phases : [];
    return {
        title: field.str('')(doc.title),
        description: field.str('')(doc.description),
        phases: rawPhases.map(shapeOf({ key: field.str(''), label: field.strOrNull })),
        fields: Array.isArray(pick(table, 'fields')) ? field.list(readField)(pick(table, 'fields')) : null,
        inputs: field.list(readInput)(doc.inputs).filter((i) => i.key !== ''),
        needsApprover: rawPhases.some((p) => pick(p, 'requires') === 'approvals'),
        warnings: field.strArray(doc.warnings),
        raw: doc,
    };
}

const readAudience = (value: unknown): AccessPlan['audience'] => {
    const kind = field.oneOfOrNull(['private', 'organisation', 'groups'] as const)(pick(value, 'kind'));
    if (!kind) return null;
    return { kind, groupIds: field.strArray(pick(value, 'groupIds')), groupNames: field.strArray(pick(value, 'groupNames')) };
};

const readStringMap = (value: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
    }
    return out;
};

export const readAccessPlan: (raw: unknown) => AccessPlan = shapeOf({
    note: field.str(''),
    audience: readAudience,
    roles: field.list(shapeOf({ key: field.str(''), label: field.str('') })),
    tableRules: field.list(shapeOf({ tableId: field.str(''), roleKey: field.str(''), expr: field.str('') })),
    defaultRole: field.strOrNull,
    byGroup: readStringMap,
    members: field.list(shapeOf({ userId: field.str(''), roleKey: field.str('app'), name: field.str('') })),
    // Names the assistant could not match ({ kind, name }), kept as the names.
    unresolved: (value: unknown) => field.list((u) => field.str('')(pick(u, 'name')))(value).filter(Boolean),
    empty: field.bool(true),
});

/** GET /api/datatables (routes/datatables/tables.js): the tables an "existing table" playbook may fill. */
export function readTableChoices(raw: unknown): TableChoice[] {
    return withId(field.list(shapeOf({ id: field.str(''), name: field.str(''), rowCount: field.numOrNull, managedKind: field.strOrNull }))(pick(raw, 'datatables')));
}

/** GET /api/studio-apps/:id → just what the access phase shows about where the app stands. */
export function readAppAccess(raw: unknown): AppAccess | null {
    const app = pick(raw, 'app');
    const id = field.str('')(pick(app, 'id'));
    if (!id) return null;
    return {
        id,
        name: field.str('')(pick(app, 'name')),
        isPublished: field.bool(false)(pick(app, 'isPublished')),
        sharedGroups: field.strArray(pick(app, 'sharedGroups')),
    };
}

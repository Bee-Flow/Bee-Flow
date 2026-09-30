/**
 * The lists the skill editor's pickers draw on — a port of the web's
 * useSkillPickerData.js reads: the routines an agent can call, the knowledge
 * bases an agent may use, and the tables.
 *
 * THREE ANSWERS PER LIST: a list that could not be read (a 403, a 500, a body
 * that is not a list) comes back as `null`, never `[]`. A step reference and
 * a "may use" grant are GRANTS, and "you have none" said about a list nobody
 * managed to read costs someone a grant they needed.
 *
 * Routines are filtered to `agent_call` triggers on the way in
 * (skillModel.isAgentCallable): the runtime dispatches nothing else.
 */

import { api } from '@/core/api/client';
import { field, pick, shapeListOf } from '@/core/api/contract';

import { isAgentCallable } from '../model/skillModel';

export interface PickerItem {
    id: string;
    name: string;
}

const readAutomationRows = shapeListOf({
    id: field.str(''),
    title: field.str(''),
    name: field.str(''),
    triggerType: field.optStr,
    triggerKind: field.optStr,
    definition: field.raw,
});
const readNamedRows = shapeListOf({ id: field.str(''), name: field.str(''), title: field.str(''), key: field.str('') });

async function readList<T>(path: string, pickRows: (body: unknown) => unknown, map: (rows: unknown[]) => T[]) {
    try {
        const rows = pickRows(await api.get<unknown>(path, { retry: false }));
        return Array.isArray(rows) ? map(rows) : null;
    } catch {
        return null;
    }
}

export function listCallableRoutines(): Promise<PickerItem[] | null> {
    return readList('/api/automation', (b) => pick(b, 'automations'), (rows) =>
        readAutomationRows(rows)
            .filter((a) => a.id && isAgentCallable(a))
            .map((a) => ({ id: a.id, name: a.title || a.name || a.id })),
    );
}

export function listAgentKnowledgeBases(): Promise<PickerItem[] | null> {
    return readList('/api/kb?context=agent', (b) => (Array.isArray(b) ? b : pick(b, 'knowledgeBases')), (rows) =>
        readNamedRows(rows)
            .filter((k) => k.id)
            .map((k) => ({ id: k.id, name: k.name || k.id })),
    );
}

export function listTables(): Promise<PickerItem[] | null> {
    return readList('/api/datatables', (b) => pick(b, 'datatables'), (rows) =>
        readNamedRows(rows)
            .filter((d) => d.id)
            .map((d) => ({ id: d.id, name: d.name || d.key || d.id })),
    );
}

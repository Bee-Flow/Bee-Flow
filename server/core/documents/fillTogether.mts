/**
 * Filling in a document together, as every writer does it: the form
 * (routes/studioDocuments/templateValues.mts, valueRequests.mts, fieldNotes.mts)
 * and the assistant's tools (integrations/templateFillTools.mts). One place, so
 * a value the assistant stores for someone counts exactly as one typed in the
 * form: it says who filled the field in, closes the requests it answers, tells
 * who asked, and drops the remark the final check had on the old value.
 *
 *   fillAnnotator(who)        the extra settings of a values save
 *   notifyCompleted(...)      a bell for whoever asked, when their request is answered
 *   askColleagues(...)        requests to project members, each with a bell
 *   annotationsOf(doc)        what a reader is shown next to the values
 *
 * The rules themselves are pure (valueRequests.mts, fieldNotes.mts,
 * fillReview.mts); this module adds the saving and the telling. Everything
 * outside it is handed in (`deps`), so the tests run without a database.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { notesOf, type FieldNote } from './fieldNotes.mts';
import { reviewView, withoutFindings } from './fillReview.mts';
import { serverName } from './serverNames.mts';
import { saveSettings, valuesOf, type Annotate, type Settings, type TemplateDoc, type ValuesStore } from './templateValues.mts';
import { addRequest, filledByOf, recordFilled, requestsOf, type FilledBy, type ValueRequest } from './valueRequests.mts';

const nodeRequire = createRequire(import.meta.url);

export type Doc = TemplateDoc & { projectId?: string | null };
export type Notify = (n: { userId: string, category: string, title: string, message: string, link: string }) => Promise<unknown>;
export type TellDeps = { notify?: Notify, name?: typeof serverName };
export type AskDeps = TellDeps & {
    /** The person's role on the project (auth/projectAccess.getProjectRole). */
    projectRole?: (userId: string, projectId: string) => Promise<string | null>,
    /** The document's fields (its contract), for the labels in the bell. */
    contractKeys?: (doc: Doc) => Array<{ key: string, label: string }>,
};

const EDITORS = new Set(['owner', 'editor']);
const refusal = (message: string, status: number, errorClass: string): Error => Object.assign(new Error(message), { status, errorClass });
const warn = (...args: unknown[]): void => (nodeRequire('../../telemetry/log.js') as { warn: (...a: unknown[]) => void }).warn(...args);

/** Where the bell sends the person: the document, opened inside its project. */
export const documentLink = (doc: Doc): string => `/app/projects/${encodeURIComponent(String(doc.projectId))}/documents/${encodeURIComponent(doc.id)}`;

function realNotify(): Notify {
    return (n) => (nodeRequire('../../stores/notificationStore.js') as { createNotification: Notify }).createNotification(n);
}

function realContractKeys(doc: Doc): Array<{ key: string, label: string }> {
    const { getContract } = nodeRequire('./documentContract.js') as { getContract: (d: unknown) => { parameters: Array<{ key: string, label?: string }> } };
    return getContract(doc).parameters.map((p) => ({ key: p.key, label: p.label || p.key }));
}

const realProjectRole = (userId: string, projectId: string): Promise<string | null> => (nodeRequire('../../auth/projectAccess.js') as {
    getProjectRole: (u: string, p: string) => Promise<string | null> }).getProjectRole(userId, projectId);

/**
 * For a values save: record who filled in what (and that the assistant did it
 * for them, `via`), close the requests that are now answered, and drop the
 * final check's remarks on the fields that changed. `completed()` then lists
 * the requests this save answered.
 */
export function fillAnnotator(userId: string, { now = new Date().toISOString(), via }: { now?: string, via?: 'ai' } = {}): { annotate: Annotate, completed: () => ValueRequest[] } {
    let completed: ValueRequest[] = [];
    return {
        annotate: (settings, values, changedKeys) => {
            const out = recordFilled(withoutFindings(settings, changedKeys), values, changedKeys, { userId, now, ...(via ? { via } : {}) });
            completed = out.completed;
            return out.settings;
        },
        completed: () => completed,
    };
}

/** Tell each requester that what they asked for is filled in. Best effort: a failed bell never fails the save. */
export async function notifyCompleted(doc: Doc, completed: ValueRequest[], deps: TellDeps = {}): Promise<void> {
    const notify = deps.notify || realNotify();
    const name = deps.name || serverName;
    for (const r of completed) {
        try {
            await notify({
                userId: r.requestedBy, category: 'info', link: documentLink(doc),
                title: await name(r.requestedBy, 'doc_value_requests.done_title', { document: doc.name || '' }),
                message: await name(r.requestedBy, 'doc_value_requests.done_message', { count: r.fields.length }),
            });
        } catch (e) { warn('[fillTogether] could not tell the requester', { error: (e as Error).message }); }
    }
}

export type AskInput = {
    store: ValuesStore, doc: Doc, me: { id: string, name: string },
    fields: string[], assigneeIds: string[], message?: string,
};

/** The people to ask: not the asker, and only who may edit the project the document is in. */
async function askable(input: AskInput, projectRole: NonNullable<AskDeps['projectRole']>): Promise<string[]> {
    if (!input.doc.projectId) throw refusal('Asking colleagues works for a document in a project.', 400, 'value_request_needs_project');
    const assignees = [...new Set(input.assigneeIds)].filter((id) => id !== input.me.id);
    if (!assignees.length) throw refusal('Pick a colleague to ask (not yourself).', 400, 'value_request_no_one');
    for (const id of assignees) {
        if (!EDITORS.has(String(await projectRole(id, String(input.doc.projectId))))) {
            throw refusal('Only people who may edit this project can be asked.', 400, 'value_request_not_member');
        }
    }
    return assignees;
}

/**
 * Ask project members for fields: one request per person on the document, a
 * bell for each (in their own language). Returns the saved document and the
 * requests made; a refusal carries `status` and `errorClass`.
 */
export async function askColleagues(input: AskInput, deps: AskDeps = {}): Promise<{ doc: Doc, made: ValueRequest[] }> {
    const { store, doc, me, fields, message } = input;
    const assignees = await askable(input, deps.projectRole || realProjectRole);
    const known = (deps.contractKeys || realContractKeys)(doc);
    const now = new Date().toISOString();
    let settings: Settings = { ...(doc.settings || {}) };
    const made: ValueRequest[] = [];
    for (const assigneeId of assignees) {
        settings = addRequest(settings, { id: randomUUID(), fields, assigneeId, requestedBy: me.id, message, now, knownKeys: known.map((k) => k.key) });
        made.push(requestsOf(settings).at(-1) as ValueRequest);
    }
    const saved = await saveSettings(store, doc, settings, me.id, 'user') as Doc | null;
    if (!saved) throw refusal('Document not found', 404, 'document_not_found');
    const labelOf = new Map(known.map((k) => [k.key, k.label]));
    const notify = deps.notify || realNotify();
    const name = deps.name || serverName;
    for (const r of made) {
        try {
            await notify({
                userId: r.assigneeId, category: 'heads_up', link: documentLink(saved),
                title: await name(r.assigneeId, 'doc_value_requests.ask_title', { document: saved.name || '' }),
                message: await name(r.assigneeId, 'doc_value_requests.ask_message', {
                    person: me.name, fields: r.fields.map((k) => labelOf.get(k) || k).join(', '), note: r.message ? ` “${r.message}”` : '',
                }),
            });
        } catch (e) { warn('[fillTogether] could not notify the colleague', { error: (e as Error).message }); }
    }
    return { doc: saved, made };
}

export type Annotations = {
    requests: ValueRequest[], filledBy: FilledBy, notes: FieldNote[], review: ReturnType<typeof reviewView>,
};

/** What a reader is shown next to the values: requests, who filled what, notes, and the final check. */
export function annotationsOf(doc: Doc): Annotations {
    return {
        requests: requestsOf(doc.settings), filledBy: filledByOf(doc.settings), notes: notesOf(doc.settings),
        review: reviewView(doc.settings, valuesOf(doc)),
    };
}

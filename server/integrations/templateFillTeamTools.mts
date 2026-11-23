/**
 * The template-fill tools that are about other people and about where the
 * document ends up; templateFillTools.mts builds them next to its own.
 *
 *   template_fill_review         the assistant's final check, shown at the fields
 *   template_fill_ask_colleague  tag a project member for the fields only they know
 *   template_fill_add_note       a note for the others, at a field or on the document
 *   document_add_to_project      file the document in a project, and in one of its folders
 *
 * They write what the form's own routes write, through the same rules
 * (core/documents/fillReview.mts, fieldNotes.mts, fillTogether.mts), so a
 * remark, a request or a note looks the same whoever made it.
 *
 * Asking a colleague and leaving a note belong to a project's team chat: the
 * chat hands in the project's owner and editors by name (`ctx.colleagues`, the
 * asker among them). Access to the document is the fill tools' own
 * (templateFillTools.mts `fillableDocument`).
 */

import { randomUUID } from 'node:crypto';
import { addNote, notesOf } from '../core/documents/fieldNotes.mts';
import { cleanFindings, filledFields, openFindings, withReview, type FillReview } from '../core/documents/fillReview.mts';
import { askColleagues, type AskDeps } from '../core/documents/fillTogether.mts';
import { saveSettings, valuesOf, type ContractModule, type Settings, type TemplateDoc } from '../core/documents/templateValues.mts';
import { isOpen, requestsOf } from '../core/documents/valueRequests.mts';
import type { TemplateFillStore } from './templateFillTools.mts';

export type Person = { id: string, name: string };
export type TeamCtx = {
    project?: { id: string } | null,
    /** The project's owner and editors, the asker included. */
    colleagues?: () => Promise<Person[]>,
};
type Args = Record<string, unknown>;
type Out = Record<string, unknown>;
type Doc = TemplateDoc & { projectId?: string | null };
export type TeamHandler<C extends TeamCtx = TeamCtx> = (args: Args, ctx: C, userId: string) => Promise<Out>;

/** Files a person's document into a project and its folders (projects/documentFiling.mts). */
export type DocumentFiling = {
    targets: (userId: string) => Promise<Array<{ id: string, name: string }>>,
    fileDocument: (userId: string, documentId: string, projectId: string) => Promise<{ ok: true, project: { id: string, name: string } } | { ok: false, error: string }>,
    folders: (userId: string, projectId: string) => Promise<Array<{ id: string, name: string }>>,
    placeInFolder: (userId: string, projectId: string, documentId: string, folder: string) => Promise<{ ok: true, folder: { id: string, name: string }, created: boolean } | { ok: false, error: string }>,
};

export type TeamDeps<C extends TeamCtx> = {
    db: () => TemplateFillStore,
    contract: () => ContractModule,
    /** The document a fill tool works on, or the tool's error (templateFillTools.mts). */
    fillable: (args: Args, ctx: C, userId: string) => Promise<Doc | { error: string }>,
    /** The start of every answer about a document. */
    head: (doc: Doc) => Out,
    filing: () => DocumentFiling,
    ask?: AskDeps,
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const TEAM_ONLY = 'This works in a project\'s team chat, where the document is the project\'s and its members fill it in together.';
const projectUrl = (projectId: string, documentId: string): string => `/app/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`;

/** A store or rule refusal (a conflict, a cap) as the tool's error; anything else is thrown on. */
async function saved<T>(run: () => Promise<T>): Promise<T | { error: string }> {
    try {
        return await run();
    } catch (e) {
        const status = (e as { status?: number }).status;
        if (status && status < 500) return { error: (e as Error).message };
        throw e;
    }
}

/** The person a name or id means, among those who can be asked; or why it is nobody. */
function findPerson(people: Person[], wanted: string): Person | string {
    const needle = wanted.toLowerCase();
    const exact = people.filter((p) => p.id === wanted || p.name.toLowerCase() === needle);
    const found = exact.length ? exact : people.filter((p) => p.name.toLowerCase().includes(needle));
    if (found.length === 1) return found[0];
    return found.length ? `"${wanted}" fits more than one person: ask the user which of them.` : `Nobody called "${wanted}" can be asked in this project.`;
}

/**
 * What the assistant is told about the others, next to the values: the final
 * check's open remarks and, in a project, who was asked for what and the notes.
 */
export async function teamState(doc: Doc, ctx: TeamCtx): Promise<Out> {
    const findings = openFindings(doc.settings, valuesOf(doc)).map(({ was: _was, ...f }) => f);
    const open = requestsOf(doc.settings).filter(isOpen);
    const notes = notesOf(doc.settings);
    if (!open.length && !notes.length) return findings.length ? { openRemarks: findings } : {};
    const people = ctx.colleagues ? await ctx.colleagues() : [];
    const nameOf = (id: string): string => people.find((p) => p.id === id)?.name || 'a colleague';
    return {
        ...(findings.length ? { openRemarks: findings } : {}),
        ...(open.length ? { waitingFor: open.map((r) => ({ person: nameOf(r.assigneeId), askedBy: nameOf(r.requestedBy), fields: r.fields, ...(r.message ? { message: r.message } : {}) })) } : {}),
        ...(notes.length ? { notes: notes.map((n) => ({ by: nameOf(n.userId), ...(n.key ? { field: n.key } : {}), text: n.text })) } : {}),
    };
}

/** template_fill_review: the assistant's own findings, kept as the form's "Check" keeps a model's. */
function review<C extends TeamCtx>({ db, contract, fillable, head }: TeamDeps<C>): TeamHandler<C> {
    return async (args, ctx, userId) => {
        const doc = await fillable(args, ctx, userId);
        if ('error' in doc) return doc;
        if (!Array.isArray(args.findings)) return { documentId: doc.id, error: 'Pass findings as a list; an empty list when every value is fine.' };
        const fields = contract().getContract(doc);
        const values = valuesOf(doc);
        const findings = cleanFindings(args.findings, fields, values);
        const made: FillReview = { at: new Date().toISOString(), by: userId, source: 'chat', checked: filledFields(fields, values).length, findings };
        const out = await saved(() => saveSettings(db(), doc, withReview(doc.settings || {}, made), userId, 'ai'));
        if (!out) return { documentId: doc.id, error: 'Document is read-only.' };
        if ('error' in out) return { documentId: doc.id, error: out.error };
        const dropped = args.findings.length - findings.length;
        return {
            ...head(out), reviewed: true, checked: made.checked, remarks: findings.map(({ was: _was, ...f }) => f),
            ...(dropped > 0 ? { dropped, droppedWhy: 'Not kept: about an empty or unknown field, a rewrite of a field that is not text or equal to what is there, or a doubt without a reason.' } : {}),
            message: findings.length
                ? `The form now shows ${findings.length} remark(s) at their fields; the user takes a suggested wording over or keeps their own there. Say in one or two sentences what the check found (do not list every field) and that you finish it when they say so.`
                : 'The check found nothing to remark. Say so in one sentence and ask whether to finish.',
        };
    };
}

/** template_fill_ask_colleague: tag a member of the project for fields; without `person`, who can be asked. */
function askColleague<C extends TeamCtx>({ db, fillable, head, ask }: TeamDeps<C>): TeamHandler<C> {
    return async (args, ctx, userId) => {
        if (!ctx.project || !ctx.colleagues) return { error: TEAM_ONLY };
        const doc = await fillable(args, ctx, userId);
        if ('error' in doc) return doc;
        const everyone = await ctx.colleagues();
        const people = everyone.filter((p) => p.id !== userId);
        const wanted = str(args.person);
        if (!wanted) return { ...head(doc), colleagues: people, message: people.length ? 'These people can be asked. Call again with `person` and `fields`.' : 'Nobody else may edit this project yet, so there is no one to ask.' };
        const person = findPerson(people, wanted);
        if (typeof person === 'string') return { ...head(doc), colleagues: people, error: person };
        const fields = Array.isArray(args.fields) ? args.fields.filter((k): k is string => typeof k === 'string') : [];
        const out = await saved(() => askColleagues({
            store: db(), doc, me: { id: userId, name: everyone.find((p) => p.id === userId)?.name || '' }, fields, assigneeIds: [person.id], message: str(args.message),
        }, ask || {}));
        if ('error' in out) return { ...head(doc), error: out.error };
        return {
            ...head(out.doc), asked: { person: person.name, fields: out.made[0]?.fields || [] },
            message: `${person.name} got a notification, and the form shows those fields as asked of them; the request closes by itself once they have a value. Say so in one sentence.`,
        };
    };
}

/** template_fill_add_note: a note for the others, at a field or on the whole document. */
function addFieldNote<C extends TeamCtx>({ db, contract, fillable, head }: TeamDeps<C>): TeamHandler<C> {
    return async (args, ctx, userId) => {
        if (!ctx.project) return { error: TEAM_ONLY };
        const doc = await fillable(args, ctx, userId);
        if ('error' in doc) return doc;
        const knownKeys = contract().getContract(doc).parameters.map((field) => field.key);
        const out = await saved(async () => {
            const next: Settings = addNote({ ...(doc.settings || {}) }, { id: randomUUID(), key: str(args.field), userId, text: str(args.text), now: new Date().toISOString(), knownKeys });
            return saveSettings(db(), doc, next, userId, 'user');
        });
        if (!out) return { documentId: doc.id, error: 'Document is read-only.' };
        if ('error' in out) return { documentId: doc.id, error: out.error };
        return { ...head(out), noted: true, message: 'The note is in the form for everyone who fills this document in. Say so in one sentence.' };
    };
}

/** The folder part of an answer: the document put in `folder`, or the tool's error. */
async function intoFolder(filing: DocumentFiling, where: { userId: string, projectId: string, documentId: string }, folder: string): Promise<Out> {
    const placed = await filing.placeInFolder(where.userId, where.projectId, where.documentId, folder);
    if (!placed.ok) return { error: placed.error };
    return { folder: placed.folder, ...(placed.created ? { folderCreated: true } : {}) };
}

const filedMessage = (doc: Doc, where: string, url: string): string => `"${doc.name}" is now in ${where}. End your reply with the clickable link "[${doc.name}](${url})".`;

/** In a team chat the document is the project's already: only the folder is left to choose. */
async function placeInThisProject(deps: { filing: DocumentFiling, head: (doc: Doc) => Out }, doc: Doc, projectId: string, want: { userId: string, folder: string }): Promise<Out> {
    const url = projectUrl(projectId, doc.id);
    if (!want.folder) {
        const folders = await deps.filing.folders(want.userId, projectId);
        return { ...deps.head(doc), url, folders, message: 'The document is in this project already. Pass `folder` (a name; it is made when the project has none by that name) to put it in a folder.' };
    }
    const placed = await intoFolder(deps.filing, { userId: want.userId, projectId, documentId: doc.id }, want.folder);
    if (placed.error) return { ...deps.head(doc), error: placed.error };
    const folder = placed.folder as { name: string };
    return { ...deps.head(doc), url, ...placed, message: filedMessage(doc, `the folder "${folder.name}" of this project`, url) };
}

/** document_add_to_project: list the projects, file the document in one, and put it in a folder there. */
function addToProject<C extends TeamCtx>({ fillable, head, filing }: TeamDeps<C>): TeamHandler<C> {
    return async (args, ctx, userId) => {
        if (!ctx.project && !str(args.documentId)) return { error: 'documentId is required: the id from template_fill_start or template_fill_finish.' };
        const doc = await fillable(args, ctx, userId);
        if ('error' in doc) return doc;
        const folder = str(args.folder);
        if (ctx.project) return placeInThisProject({ filing: filing(), head }, doc, ctx.project.id, { userId, folder });
        const projectId = str(args.projectId);
        if (!projectId) {
            const projects = await filing().targets(userId);
            return projects.length
                ? { ...head(doc), projects, message: 'Ask the user which project, unless they named one; then call this again with its projectId (and `folder` when they named a folder).' }
                : { ...head(doc), projects, message: 'The user has no project they can add documents to.' };
        }
        // Filed already (a second call, for the folder): only the folder is left.
        let project: { id: string, name: string } | null = null;
        if (doc.projectId !== projectId) {
            const filed = await filing().fileDocument(userId, doc.id, projectId);
            if (!filed.ok) return { ...head(doc), error: filed.error };
            project = filed.project;
        }
        const url = projectUrl(projectId, doc.id);
        const base = { ...head(doc), url, added: true, ...(project ? { project } : {}) };
        if (!folder) {
            const folders = await filing().folders(userId, projectId);
            return { ...base, folders, message: `${filedMessage(doc, 'the project; its members can open and edit it there', url)} To put it in a folder (an existing one from \`folders\`, or a new name), call this again with \`folder\`.` };
        }
        const placed = await intoFolder(filing(), { userId, projectId, documentId: doc.id }, folder);
        if (placed.error) return { ...base, folderError: placed.error, message: `${filedMessage(doc, 'the project, at the top of its documents', url)} It could not be put in the folder: ${String(placed.error)}` };
        return { ...base, ...placed, message: filedMessage(doc, `the folder "${(placed.folder as { name: string }).name}" of the project`, url) };
    };
}

/** The handlers, by tool name. */
export function makeTeamHandlers<C extends TeamCtx>(deps: TeamDeps<C>): Record<string, TeamHandler<C>> {
    return {
        template_fill_review: review(deps), template_fill_ask_colleague: askColleague(deps),
        template_fill_add_note: addFieldNote(deps), document_add_to_project: addToProject(deps),
    };
}

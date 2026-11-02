/**
 * What the team chat's AI may do with what the project ALREADY holds
 * (projects/chatTools.js offers these next to its create tools), so a request
 * to work on an existing notebook changes that notebook instead of making a
 * second one with the same title:
 *
 *   list_project_items   the project's notebooks and documents, as cards: kind,
 *                        id, name and when it changed, nothing of the content
 *   read_project_item    one of them by id: a notebook as Markdown (outline,
 *                        section, search or full), a document as plain text
 *   edit_notebook        insert into, or replace text in, one notebook
 *
 * Every call runs as the member who asked and is checked again when it runs:
 * owner or editor on the project, a container that holds the kind, the
 * project's organisation, the notebook gates for a notebook, and the item must
 * be filed in THIS project (the stores also return the asker's own items
 * elsewhere, which a chat the whole team reads must not see). An edit also
 * needs the edit role on the notebook itself.
 *
 * Documents stay read-only: they are HTML pages and designed documents, where
 * a partial edit is not safe. There is no whole-notebook rewrite either: a
 * read can come back with values the Privacy Shield hid from the model, and a
 * rewrite built from that read would delete them. For the same reason an edit
 * that carries a hidden-value marker is refused, and a replace only matches
 * text that occurs exactly once.
 *
 * An edit is written the way the notebook's own chat writes the AI's changes
 * (agents/notebooks/aiDocWriter.js): through co-editing when colleagues are
 * typing, else compare-and-set on the row, a checkpoint version before the
 * first change of the answer as its undo, and a colliding change kept as a
 * proposal instead of written. A result gives the model ids and a link, never
 * the text it wrote.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log') as { warn: (msg: string, meta?: unknown) => void };

export { ITEM_TOOL_NAMES, ITEM_DEFINITIONS } from './chatItemToolDefs.mts';

/** Lookups (a list or a read) and edits one answer may make. */
export const MAX_READS = 6;
export const MAX_EDITS = 3;

const LIST_MAX = 50;
const LIST_FETCH = 200;
const QUERY_MAX = 200;
const ID_MAX = 100;
const READ_MAX = 30_000;
const EDIT_TEXT_MAX = 60_000;
// Where the Privacy Shield hid a value from a tool result (core/privacy/toolPiiGate.js replaceBlocked).
const HIDDEN_MARK = /\[blocked:[^\]]*\]/;
const NOT_HERE = 'There is no such item in this project, or the person who asked cannot open it.';

type Kind = 'notebook' | 'document';
type Role = 'owner' | 'editor' | 'viewer' | null;
type Project = { id: string, kind?: string | null, organizationId?: string | null };
type Who = { project: Project, userId: string, orgId?: string | null, session?: unknown };
type Args = Record<string, unknown>;
type NotebookRow = { id: string, name?: string, projectId?: string | null, role?: string | null, version?: number | null,
    documentContent?: string, documentMd?: string | null };
type DocumentRow = { id: string, name?: string, projectId?: string | null, kind?: string | null, archived?: boolean, bodyHtml?: string };
type Card = { id: string, name?: string | null, updatedAt?: string | Date | null };
type Current = { html: string, markdown: string | null, live: boolean, active: boolean };
type Contributor = { userId: string, kind: 'ai' | 'user' };
type WriteOutcome = { ok: boolean, conflict?: boolean, html?: string };
type Writer = {
    write: (html: string, markdown: string | null, opts?: { snapshot?: boolean }) => Promise<WriteOutcome>,
    contributors: Contributor[],
};
type Edited = { kind: 'notebook', id: string, name: string };
type TextEdit = { newContent?: string, error?: string };

type NotebookPort = {
    listProjectNotebooks: (projectId: string, opts?: { limit?: number }) => Promise<Card[]>,
    getNotebook: (id: string, userId: string) => Promise<NotebookRow | null>,
    recordVersion: (id: string, v: { html: string, markdown: string | null, source: string, createdBy: string,
        contributors: Contributor[] }) => Promise<{ id?: string, deduped?: boolean } | null>,
};
type DocumentPort = {
    listProjectDocuments: (projectId: string, opts?: { limit?: number }) => Promise<Card[]>,
    getDocument: (id: string, context: { userId: string }) => Promise<DocumentRow | null>,
};
type FeedPort = {
    contentChanged: (e: { projectId: string, notebookId: string, contributors: Contributor[], versionId: string | null, source: string }) => Promise<unknown>,
};

/**
 * The gates chatTools.js already resolved, and the seams of this module (each
 * defaults to the real module): `readCurrent` is the notebook's current
 * document (live while co-edited), `makeWriter` the AI writer of one edit.
 */
export type ItemToolDeps = {
    getProjectRole: (userId: string, projectId: string) => Promise<Role>,
    membership: () => { isAllowedIn: (kind: string, container: string | null) => boolean },
    notebooksAllowed: (p: { userId: string, orgId?: string | null, session?: unknown }) => Promise<boolean>,
    projectOrg: () => { projectOrgOf: (p: Project) => Promise<string>, belongsToProjectOrg: (userId: string, org: string) => Promise<boolean> },
    notebooks?: NotebookPort,
    documents?: DocumentPort,
    readCurrent?: (nb: NotebookRow) => Promise<Current>,
    makeWriter?: (o: { notebookId: string, userId: string, baseHtml: string, expectedVersion: number | null }) => Writer,
    feed?: FeedPort,
    markdownToHtml?: (md: string) => string,
};

type Ports = Omit<Required<ItemToolDeps>, 'notebooks' | 'documents' | 'feed'> & {
    // Resolved when used, as chatTools.js resolves its stores.
    notebooks: () => NotebookPort,
    documents: () => DocumentPort,
    feed: () => FeedPort,
    htmlToMarkdown: (html: string) => string,
    htmlToText: (html: unknown) => string,
    insertIntoContent: (content: string, edit: { position?: string, afterText?: string, insertContent?: string }) => { newContent?: string, error?: string },
    readNotebookContent: (content: string, args: { mode?: string, section_heading?: string, query?: string }) => Record<string, unknown>,
};
type Run = Ports & { who: Who, state: { reads: number, edits: number, edited: Edited[], checkpointed: Set<string> } };

const refuse = (error: string): string => JSON.stringify({ ok: false, error });
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const raw = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const kindOf = (v: unknown): Kind | null => (v === 'notebook' || v === 'document' ? v : null);
const canEdit = (nb: NotebookRow): boolean => nb.role === 'owner' || nb.role === 'editor';

function iso(v: unknown): string | null {
    if (!v) return null;
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function resolvePorts(deps: ItemToolDeps): Ports {
    const markdown = () => nodeRequire('../core/markdown');
    const collab = () => nodeRequire('../agents/notebooks/notebookCollab');
    return {
        ...deps,
        notebooks: () => deps.notebooks || nodeRequire('../stores/notebookStore'),
        documents: () => deps.documents || nodeRequire('../stores/documentStore'),
        readCurrent: deps.readCurrent || ((nb) => collab().readCurrentContent(nb, collab().defaultFacade())),
        makeWriter: deps.makeWriter || ((o) => nodeRequire('../agents/notebooks/aiDocWriter').makeAiDocWriter(o)),
        feed: () => deps.feed || nodeRequire('../agents/notebooks/notebookFeed').makeNotebookFeed(),
        markdownToHtml: deps.markdownToHtml || ((md) => markdown().markdownToHtml(md)),
        htmlToMarkdown: (html) => (markdown().looksLikeHtml(html) ? markdown().htmlToMarkdown(html) : html),
        htmlToText: (html) => nodeRequire('./chatTaggedItems').htmlToText(html),
        insertIntoContent: (content, edit) => nodeRequire('../integrations/notebookTextEdits').insertIntoContent(content, edit),
        readNotebookContent: (content, args) => nodeRequire('../integrations/notebookReadModes').readNotebookContent(content, args),
    };
}

/** Why the asker may not use `kind` in this project right now, or null. */
async function denied(run: Run, kind: Kind): Promise<string | null> {
    const { project, userId, orgId, session } = run.who;
    const role = await run.getProjectRole(userId, project.id);
    if (role !== 'owner' && role !== 'editor') return 'The person who asked can no longer use this project.';
    if (!run.membership().isAllowedIn(kind, project.kind ?? null)) return `This project holds no ${kind}s.`;
    if (kind === 'notebook' && !(await run.notebooksAllowed({ userId, orgId, session }))) return 'Notebooks are not available to the person who asked.';
    const { projectOrgOf, belongsToProjectOrg } = run.projectOrg();
    if (!(await belongsToProjectOrg(userId, await projectOrgOf(project)))) return 'This project belongs to another organization.';
    return null;
}

/** A notebook the asker can open AND that is filed in this project, or null. */
async function projectNotebook(run: Run, id: string): Promise<NotebookRow | null> {
    const nb = await run.notebooks().getNotebook(id, run.who.userId);
    return nb && nb.projectId === run.who.project.id ? nb : null;
}

const markdownOf = (run: Run, current: Current): string => current.markdown ?? run.htmlToMarkdown(current.html || '');

function cut(text: string): { content: string, note?: string } {
    if (text.length <= READ_MAX) return { content: text };
    return { content: `${text.slice(0, READ_MAX)}\n…`, note: 'Cut short: read a section or search for the part you need.' };
}

const overBudget = (run: Run): string | null => (run.state.reads >= MAX_READS ? `At most ${MAX_READS} lookups can be made in one answer.` : null);

async function listItems(run: Run, args: Args): Promise<string> {
    const spent = overBudget(run);
    if (spent) return refuse(spent);
    const asked = kindOf(args.kind);
    const kinds: Kind[] = asked ? [asked] : ['notebook', 'document'];
    const open: Kind[] = [];
    let reason: string | null = null;
    for (const kind of kinds) {
        const why = await denied(run, kind);
        if (why) reason = reason || why;
        else open.push(kind);
    }
    if (!open.length) return refuse(reason || NOT_HERE);
    run.state.reads += 1;
    const projectId = run.who.project.id;
    const card = (kind: Kind) => (r: Card) => ({ kind, id: String(r.id), name: String(r.name ?? ''), updatedAt: iso(r.updatedAt) });
    const cards = [
        ...(open.includes('notebook') ? (await run.notebooks().listProjectNotebooks(projectId, { limit: LIST_FETCH })).map(card('notebook')) : []),
        ...(open.includes('document') ? (await run.documents().listProjectDocuments(projectId, { limit: LIST_FETCH })).map(card('document')) : []),
    ];
    const query = str(args.query, QUERY_MAX).toLowerCase();
    const hits = cards.filter((c) => !query || c.name.toLowerCase().includes(query))
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return JSON.stringify({
        ok: true,
        items: hits.slice(0, LIST_MAX),
        ...(hits.length > LIST_MAX ? { more: hits.length - LIST_MAX } : {}),
        ...(hits.length ? {} : { message: query ? `Nothing in this project has "${query}" in its name.` : 'This project holds none yet.' }),
    });
}

async function readNotebook(run: Run, id: string, args: Args): Promise<string> {
    const nb = await projectNotebook(run, id);
    if (!nb) return refuse(NOT_HERE);
    const md = markdownOf(run, await run.readCurrent(nb));
    const head = { ok: true, kind: 'notebook', id: nb.id, name: nb.name || '', canEdit: canEdit(nb) };
    if (!md.trim()) return JSON.stringify({ ...head, content: '', message: 'The notebook is empty.' });
    const read = run.readNotebookContent(md, { mode: str(args.mode, 20) || undefined, section_heading: str(args.section_heading, QUERY_MAX), query: str(args.query, QUERY_MAX) });
    if (typeof read.error === 'string') return refuse(read.error);
    const body = typeof read.content === 'string' ? { ...read, ...cut(read.content) } : read;
    // The outline's hints speak of the normal chat's tool; here it is this one. Only the hint
    // lines: the notebook's own text is handed on as it is, or a find_text copied from it misses.
    return JSON.stringify({ ...head, ...body }).replace(/Use notebook_read with/g, 'Use read_project_item with');
}

async function readDocument(run: Run, id: string): Promise<string> {
    const doc = await run.documents().getDocument(id, { userId: run.who.userId });
    // What the project holds (documentStore PROJECT_DOCUMENT_SQL): not an archived one, not a template.
    if (!doc || doc.projectId !== run.who.project.id || (doc.kind ?? 'document') !== 'document' || doc.archived === true) return refuse(NOT_HERE);
    return JSON.stringify({ ok: true, kind: 'document', id: doc.id, name: doc.name || '', readOnly: true, ...cut(run.htmlToText(doc.bodyHtml)) });
}

async function readItem(run: Run, args: Args): Promise<string> {
    const spent = overBudget(run);
    if (spent) return refuse(spent);
    const kind = kindOf(args.kind);
    const id = str(args.id, ID_MAX);
    if (!kind || !id) return refuse('Give the kind ("notebook" or "document") and the id list_project_items returned.');
    const why = await denied(run, kind);
    if (why) return refuse(why);
    run.state.reads += 1;
    return kind === 'notebook' ? readNotebook(run, id, args) : readDocument(run, id);
}

/** The text exactly as it occurs in `content` (as sent, else trimmed), or ''. */
function exactIn(content: string, wanted: unknown): string {
    const text = raw(wanted, EDIT_TEXT_MAX);
    if (text.trim() && content.includes(text)) return text;
    const trimmed = text.trim();
    return trimmed && content.includes(trimmed) ? trimmed : '';
}

function replaceOnce(before: string, args: Args): TextEdit {
    if (!before.trim()) return { error: 'The notebook is empty: there is nothing to replace. Use action "insert".' };
    const find = exactIn(before, args.find_text);
    if (!find) return { error: 'find_text does not occur in the notebook. Read it with read_project_item mode "search" and copy the text exactly. Nothing was changed.' };
    const at = before.indexOf(find);
    if (before.indexOf(find, at + 1) !== -1) return { error: 'find_text occurs more than once. Include more of the text around it so it is unique. Nothing was changed.' };
    // Spliced, not String.replace: a `$&` in the new text is text, not a pattern.
    return { newContent: before.slice(0, at) + raw(args.replace_text, EDIT_TEXT_MAX) + before.slice(at + find.length) };
}

function insert(run: Run, before: string, args: Args): TextEdit {
    const content = raw(args.content, EDIT_TEXT_MAX);
    if (!content.trim()) return { error: 'An insert needs its content.' };
    const position = args.position === 'start' || args.position === 'after' ? args.position : 'end';
    if (position !== 'after') return run.insertIntoContent(before, { position, insertContent: content });
    const afterText = exactIn(before, args.after_text);
    if (!afterText) return { error: 'after_text does not occur in the notebook. Copy it exactly from a read, or insert at the end. Nothing was changed.' };
    return run.insertIntoContent(before, { position, afterText, insertContent: content });
}

/** Text the shield hid from the model cannot be matched against, nor written back as its marker. */
function hiddenIn(args: Args): boolean {
    return ['find_text', 'replace_text', 'content', 'after_text'].some((k) => typeof args[k] === 'string' && HIDDEN_MARK.test(args[k] as string));
}

async function recordAiVersion(run: Run, nb: NotebookRow, doc: { html: string, markdown: string | null }, contributors: Contributor[]): Promise<void> {
    const { project, userId } = run.who;
    try {
        const v = await run.notebooks().recordVersion(nb.id, { ...doc, source: 'ai', createdBy: userId, contributors });
        if (!v?.deduped) void run.feed().contentChanged({ projectId: project.id, notebookId: nb.id, contributors, versionId: v?.id ?? null, source: 'ai' });
    } catch (err) {
        log.warn('[ProjectChatTools] could not record the AI version', { notebookId: nb.id, error: (err as Error)?.message });
    }
}

async function persist(run: Run, nb: NotebookRow, current: Current, markdown: string): Promise<string> {
    const { project, userId } = run.who;
    const html = run.markdownToHtml(markdown);
    const writer = run.makeWriter({ notebookId: nb.id, userId, baseHtml: current.html || '', expectedVersion: Number.isFinite(nb.version) ? Number(nb.version) : null });
    // One checkpoint per notebook per answer: the state before the AI's first change is its undo.
    const snapshot = !run.state.checkpointed.has(nb.id);
    run.state.checkpointed.add(nb.id);
    const saved = await writer.write(html, markdown, { snapshot });
    if (saved.conflict) return refuse('Someone changed the same part of the notebook meanwhile, so this change was not applied; it was kept as a proposal they can compare and restore. Tell the member.');
    if (!saved.ok) return refuse('The change could not be saved; the notebook was left as it was.');
    await recordAiVersion(run, nb, saved.html ? { html: saved.html, markdown: null } : { html, markdown }, writer.contributors);
    if (!run.state.edited.some((e) => e.id === nb.id)) run.state.edited.push({ kind: 'notebook', id: nb.id, name: nb.name || '' });
    return JSON.stringify({ ok: true, kind: 'notebook', id: nb.id, name: nb.name || '', url: `/app/projects/${project.id}/notebooks/${nb.id}` });
}

/** What is wrong with an edit call before anything is looked up, or null. */
function badEdit(run: Run, args: Args, id: string): string | null {
    if (run.state.edits >= MAX_EDITS) return `At most ${MAX_EDITS} edits can be made in one answer.`;
    if (!id) return 'Give the id of the notebook from list_project_items.';
    if (args.action !== 'insert' && args.action !== 'replace') return 'action is "insert" or "replace".';
    if (hiddenIn(args)) return 'The text holds a part the Privacy Shield hid from you ([blocked:...]). Match and write only text you can read in full. Nothing was changed.';
    return null;
}

async function editNotebook(run: Run, args: Args): Promise<string> {
    const id = str(args.id, ID_MAX);
    const bad = badEdit(run, args, id);
    if (bad) return refuse(bad);
    const why = await denied(run, 'notebook');
    if (why) return refuse(why);
    const nb = await projectNotebook(run, id);
    if (!nb) return refuse(NOT_HERE);
    if (!canEdit(nb)) return refuse('The person who asked may read this notebook but not change it.');
    const current = await run.readCurrent(nb);
    // Co-edited, but the live document could not be read: a write onto the row would be undone.
    if (current.active && !current.live) return refuse('Colleagues are editing this notebook live and it could not be read just now, so nothing was changed. Try again shortly.');
    const before = markdownOf(run, current);
    const edit = args.action === 'replace' ? replaceOnce(before, args) : insert(run, before, args);
    if (edit.error) return refuse(edit.error);
    const after = edit.newContent ?? before;
    if (after === before) return JSON.stringify({ ok: true, kind: 'notebook', id: nb.id, name: nb.name || '', message: 'Nothing changed: the text was already so.' });
    run.state.edits += 1;
    return persist(run, nb, current, after);
}

const RUNNERS: Record<string, (run: Run, args: Args) => Promise<string>> = {
    list_project_items: listItems,
    read_project_item: readItem,
    edit_notebook: editNotebook,
};

/**
 * `forAnswer(who)` is one answer's run: `execute(name, args)` for the three
 * tools, and `edited` (`{ kind, id, name }` in order) for the message that
 * follows. A failure the model sees is a sentence, never an internal error.
 */
export function makeProjectItemTools(deps: ItemToolDeps) {
    const ports = resolvePorts(deps);
    function forAnswer(who: Who) {
        const run: Run = { ...ports, who, state: { reads: 0, edits: 0, edited: [], checkpointed: new Set() } };
        async function execute(name: string, args: unknown): Promise<string> {
            const runner = RUNNERS[name];
            if (!Object.hasOwn(RUNNERS, name) || !runner) return refuse('That tool is not available in a team chat.');
            try {
                return await runner(run, args && typeof args === 'object' ? args as Args : {});
            } catch (err) {
                log.warn(`[ProjectChatTools] ${name} failed in project ${who.project.id}: ${(err as { code?: string })?.code || (err as Error)?.message}`);
                return refuse('That could not be done just now.');
            }
        }
        return { execute, edited: run.state.edited };
    }
    return { forAnswer };
}

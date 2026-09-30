// @typecheck
/**
 * What the team chat's AI may DO, as opposed to say: a short allow-list of
 * things that belong to the project, carried out as the member who asked.
 *
 *   create_document   a page in the project (Markdown in, a rich-text page out), or a DESIGNED document
 *                     with its own HTML and CSS (an invoice, a letter, a report ...), or such a
 *                     document as a reusable TEMPLATE with {{fields}}
 *   create_notebook   a notebook in the project, optionally with a first text
 *
 * That is the whole list. The AI has none of the tools a normal chat carries
 * for the person's other apps (mail, calendar, routines, web, knowledge bases
 * outside the project, memory, ...): they are not offered, and a call to a name
 * outside the list is refused before anything runs, whatever the model says.
 *
 * Each call is checked again when it runs, as the asker, because roles and
 * licences change during a model call: editor on the project, a container that
 * holds the kind, the asker's own organisation, and for a notebook the same
 * three gates a normal chat applies before it offers notebook tools (the
 * feature switch, the plan, the use_notebooks permission). Only the person who
 * asked is the actor: nothing an AI makes by itself (`auto`) is offered these
 * tools at all, since nobody asked. What is made belongs to the asker and is
 * filed in the project, exactly like "New document" and "New notebook" there.
 * The one exception is a template: the library keeps templates apart from a
 * project's documents (they are the person's or the organisation's to share), so
 * it is made in the asker's own library and the answer says where.
 *
 * A result gives the model ids and a link, never the text it wrote.
 */

'use strict';

const log = require('../telemetry/log');

const MAX_ITEMS_PER_ANSWER = 3;
const MAX_ROUNDS = 4;
const NAME_MAX = 200;
const CONTENT_MAX = 60_000;
const HTML_MAX = 150_000;
const CSS_MAX = 50_000;
const DESIGNED_TYPES = Object.freeze(['document', 'invoice', 'quote', 'letter', 'report', 'security']);
const DESCRIPTION_MAX = 1000;

const TOOL_NAMES = Object.freeze(['create_document', 'create_notebook']);

const DEFINITIONS = Object.freeze({
    create_document: {
        type: 'function',
        function: {
            name: 'create_document',
            description: 'Create a new document in THIS project, owned by the person who asked, and fill it completely in this one call. Returns { ok, kind, id, name, url }. Afterwards tell them it is made and where, in one or two sentences; do not repeat the content.\n\n'
                + 'format "page" (default): a rich-text page for writing. Put the whole text in `content` as Markdown.\n\n'
                + 'format "designed": a laid-out document that prints or goes out as a PDF (an invoice, quote, letter, report, certificate), with its own styling. Give the whole markup in `bodyHtml` and the whole stylesheet in `css`. bodyHtml is BODY MARKUP ONLY: no <html>, <head>, <body>, <style> or <script>. Use semantic markup with classes (<table class="lines">, <div class="totals">) and do all the layout and styling in `css`: set `@page { size: A4; margin: 18mm 16mm; }`, fonts, colours, a title block, tables with clear borders and spacing, a footer. Make it look finished and professional. The organisation\'s letterhead is applied automatically: colour your accents with var(--doc-accent), text with var(--doc-ink), quiet text with var(--doc-muted), and put <div class="doc-logo"></div> where the logo belongs. Write real content, not lorem ipsum.\n\n'
                + 'template true (only with format "designed"): make it a reusable TEMPLATE. Write the changeable parts as {{placeholders}} in bodyHtml, such as {{client_name}}, {{invoice_number}}, {{date}}; each becomes a field to fill in. Templates live in the person\'s document library, not in the project: say so.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The title of the document.' },
                    format: { type: 'string', enum: ['page', 'designed'], description: 'page: rich text from Markdown (default). designed: your own HTML and CSS.' },
                    content: { type: 'string', description: 'For a page: the text of the document, as Markdown.' },
                    docType: { type: 'string', enum: [...DESIGNED_TYPES], description: 'For a designed document: what kind it is (default document).' },
                    bodyHtml: { type: 'string', description: 'For a designed document: the body markup.' },
                    css: { type: 'string', description: 'For a designed document: the full stylesheet, including @page.' },
                    template: { type: 'boolean', description: 'For a designed document: make it a reusable template with {{placeholders}} (goes to the library).' },
                    useHouseStyle: { type: 'boolean', description: 'Leave out (true) unless the person explicitly wants it without the organisation\'s letterhead.' },
                },
                required: ['name'],
            },
        },
    },
    create_notebook: {
        type: 'function',
        function: {
            name: 'create_notebook',
            description: 'Create a new notebook in THIS project, owned by the person who asked. Use it when they ask for a notebook (a workspace for notes and sources). `content` is an optional first text as Markdown. Returns { ok, kind, id, name, url }. Afterwards, tell them it is made, in one or two sentences.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The name of the notebook.' },
                    description: { type: 'string', description: 'One line on what the notebook is for (optional).' },
                    content: { type: 'string', description: 'A first text for the notebook, as Markdown (optional).' },
                },
                required: ['name'],
            },
        },
    },
});

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * @param {object} [deps]
 * @param {Function} [deps.getProjectRole]   (userId, projectId) => role|null
 * @param {Function} [deps.getUser]          (id) => user row
 * @param {object}   [deps.documents]        stores/documentStore surface: createDocument
 * @param {object}   [deps.notebooks]        stores/notebookStore surface: createNotebook, updateNotebook
 * @param {object}   [deps.membership]       projects/membership surface: isAllowedIn
 * @param {Function} [deps.recordCreated]    ({ projectId, itemType, itemId, actorId }) => void, one "created" entry in the project feed
 * @param {Function} [deps.markdownToHtml]   (md) => html
 * @param {Function} [deps.notebooksAllowed] ({ userId, orgId, session }) => boolean: the switch, the plan and the permission
 */
function makeProjectChatTools(deps = {}) {
    const getProjectRole = deps.getProjectRole || ((userId, projectId) => require('../auth/projectAccess').getProjectRole(userId, projectId));
    const getUser = deps.getUser || ((id) => require('../stores/userStore').getUser(id));
    const documents = () => deps.documents || require('../stores/documentStore');
    const notebooks = () => deps.notebooks || require('../stores/notebookStore');
    const membership = () => deps.membership || require('./membership');
    const recordCreated = deps.recordCreated || ((e) => require('./changeFeed').recordItemCreated(e));
    const markdownToHtml = deps.markdownToHtml || ((md) => require('../core/markdown').markdownToHtml(md));
    const notebooksAllowed = deps.notebooksAllowed || (async ({ userId, orgId, session }) => {
        const enabled = (await require('../stores/configStore').getConfig('feature_notebooks_enabled')) !== false;
        if (!enabled) return false;
        const { hasCapability } = require('../core/entitlements/entitlements');
        if (!(await hasCapability('notebooks', { userId, orgId: orgId || null, session: session || null }))) return false;
        return require('../auth/permissions').hasPermission(userId, 'use_notebooks', session || null);
    });

    /** The tool definitions this asker may be offered right now. */
    async function offered({ project, userId, orgId, session }) {
        const out = [];
        try {
            const role = await getProjectRole(userId, project.id);
            if (role !== 'owner' && role !== 'editor') return [];
            if (membership().isAllowedIn('document', project.kind ?? null)) out.push(DEFINITIONS.create_document);
            if (membership().isAllowedIn('notebook', project.kind ?? null) && await notebooksAllowed({ userId, orgId, session })) out.push(DEFINITIONS.create_notebook);
        } catch (err) {
            log.warn(`[ProjectChatTools] tools not offered for ${project && project.id}: ${err && err.message}`);
            return [];
        }
        return out;
    }

    /**
     * One run of tools for one answer: `execute(name, args)` for the loop, and
     * `created` (`{ kind, id, name }` in order) for the message that follows.
     */
    function forAnswer({ project, userId, orgId, session: authSession }) {
        /** @type {{ kind: 'document'|'notebook'|'template', id: string, name: string }[]} */
        const created = [];
        const refuse = (error) => JSON.stringify({ ok: false, error });

        async function checked(kind, noun) {
            if (created.length >= MAX_ITEMS_PER_ANSWER) return { error: `At most ${MAX_ITEMS_PER_ANSWER} items can be made in one answer.` };
            const role = await getProjectRole(userId, project.id);
            if (role !== 'owner' && role !== 'editor') return { error: 'The person who asked can no longer add to this project.' };
            if (!membership().isAllowedIn(kind, project.kind ?? null)) return { error: `This project holds no ${noun}.` };
            const user = await getUser(userId);
            if ((user?.organizationId || '') !== (project.organizationId || '')) return { error: 'This project belongs to another organization.' };
            return { user };
        }

        async function createDocument(args) {
            const name = str(args.name, NAME_MAX);
            if (!name) return refuse('A document needs a name.');
            const designed = args.format === 'designed';
            const template = designed && args.template === true;
            const gate = await checked('document', 'documents');
            if (gate.error) return refuse(gate.error);
            if (designed) return createDesigned({ name, args, template });
            const content = str(args.content, CONTENT_MAX);
            const doc = await documents().createDocument({
                userId, name, docType: 'page', bodyHtml: content ? markdownToHtml(content) : '',
                kind: 'document', visibility: 'private', projectId: project.id,
            });
            await recordCreated({ projectId: project.id, itemType: 'document', itemId: doc.id, actorId: userId });
            created.push({ kind: 'document', id: doc.id, name: doc.name || name });
            return JSON.stringify({ ok: true, kind: 'document', id: doc.id, name: doc.name || name, url: `/app/projects/${project.id}/documents/${doc.id}` });
        }

        /**
         * A document with its own HTML and CSS. Filed in the project like any document; a template is the exception
         * (the library holds templates apart from a project's documents), so it is made in the asker's own library.
         */
        async function createDesigned({ name, args, template }) {
            const bodyHtml = typeof args.bodyHtml === 'string' ? args.bodyHtml.trim().slice(0, HTML_MAX) : '';
            if (!bodyHtml) return refuse('A designed document needs its bodyHtml.');
            const css = typeof args.css === 'string' ? args.css.slice(0, CSS_MAX) : '';
            const docType = DESIGNED_TYPES.includes(args.docType) ? args.docType : 'document';
            const doc = await documents().createDocument({
                userId, name, docType, bodyHtml, css,
                settings: args.useHouseStyle === false ? { houseStyle: false } : {},
                kind: template ? 'template' : 'document', visibility: 'private',
                ...(template ? {} : { projectId: project.id }),
            });
            if (template) {
                created.push({ kind: 'template', id: doc.id, name: doc.name || name });
                return JSON.stringify({
                    ok: true, kind: 'template', id: doc.id, name: doc.name || name, url: `/app/studio/documents/${doc.id}`, inProject: false,
                    note: 'Saved as a template in the asker\'s own document library, not in the project.',
                });
            }
            await recordCreated({ projectId: project.id, itemType: 'document', itemId: doc.id, actorId: userId });
            created.push({ kind: 'document', id: doc.id, name: doc.name || name });
            return JSON.stringify({ ok: true, kind: 'document', id: doc.id, name: doc.name || name, url: `/app/projects/${project.id}/documents/${doc.id}` });
        }

        async function createNotebook(args) {
            const name = str(args.name, NAME_MAX);
            const content = str(args.content, CONTENT_MAX);
            if (!name) return refuse('A notebook needs a name.');
            if (!(await notebooksAllowed({ userId, orgId, session: authSession }))) return refuse('Notebooks are not available to the person who asked.');
            const gate = await checked('notebook', 'notebooks');
            if (gate.error) return refuse(gate.error);
            const nb = await notebooks().createNotebook({
                userId, name, description: str(args.description, DESCRIPTION_MAX), projectId: project.id,
                organizationId: gate.user?.organizationId || null,
            });
            if (content) await notebooks().updateNotebook(nb.id, userId, { documentContent: content });
            await recordCreated({ projectId: project.id, itemType: 'notebook', itemId: nb.id, actorId: userId });
            created.push({ kind: 'notebook', id: nb.id, name: nb.name || name });
            return JSON.stringify({ ok: true, kind: 'notebook', id: nb.id, name: nb.name || name, url: `/app/projects/${project.id}/notebooks/${nb.id}` });
        }

        /** @param {string} name @param {any} args */
        async function execute(name, args) {
            // The allow-list is enforced here, not only by what was offered: a model can name any tool.
            if (!TOOL_NAMES.includes(name)) return refuse('That tool is not available in a team chat.');
            const input = args && typeof args === 'object' ? args : {};
            try {
                return name === 'create_document' ? await createDocument(input) : await createNotebook(input);
            } catch (err) {
                log.warn(`[ProjectChatTools] ${name} failed in project ${project.id}: ${err && (err.errorClass || err.code || err.message)}`);
                // A refusal the store states on purpose is a sentence; anything else stays generic.
                const status = Number(err && err.status);
                return refuse(status >= 400 && status < 500 && err.message ? String(err.message).slice(0, 200) : 'It could not be made.');
            }
        }

        return { execute, created };
    }

    return { offered, forAnswer };
}

module.exports = { makeProjectChatTools, TOOL_NAMES, MAX_ITEMS_PER_ANSWER, MAX_ROUNDS };

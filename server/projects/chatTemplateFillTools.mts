/**
 * Filling in a template together in a project's team chat: the chat's own
 * template tools (integrations/templateFillTools.mts) with the project as the
 * place the document lives. Offered by projects/chatTools.js next to its
 * create_document.
 *
 * What changes against a person's own chat:
 *   - template_fill_start files the new document IN THE PROJECT (as "New
 *     document" there does), so every member who may edit the project fills it
 *     in, in the chat and in the form under the answer;
 *   - "the fill this conversation is doing" is the team chat's, found among the
 *     project's documents, so a colleague who asks the AI next goes on with the
 *     same document instead of starting a second one.
 *
 * Every call is checked when it runs, as the member who asked: editor of the
 * project, documents allowed in this kind of project, the project's
 * organisation. The documents touched are reported (`touched`) so the answer
 * carries the form (aiMeta.templateFills) and a chip.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Project = { id: string, kind?: string | null, organizationId?: string, ownerId?: string };
type Role = 'owner' | 'editor' | 'viewer' | null;
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>, userId: string) => Promise<Record<string, unknown>>;
type ToolDef = { type: string, function: { name: string, description: string, parameters: Record<string, unknown> } };

export interface Touched { kind: 'templateFill', id: string, name: string }

interface Deps {
    getProjectRole: (userId: string, projectId: string) => Promise<Role>,
    membership: () => { isAllowedIn: (kind: string, projectKind: string | null) => boolean },
    projectOrg: () => { projectOrgOf: (p: Project) => Promise<string>, belongsToProjectOrg: (userId: string, org: string) => Promise<boolean> },
    handlers?: () => Record<string, Handler>,
    definitions?: () => ToolDef[],
}

/** The tool names, in the order the model is offered them. */
export const PROJECT_TEMPLATE_FILL_TOOL_NAMES: readonly string[] = Object.freeze([
    'document_templates_list', 'template_fill_start', 'template_fill_set_values', 'template_fill_status', 'template_fill_finish',
]);

/** A tool answer with the document's link in the project (where its members open it), not in the Studio library. */
function inProject(out: Record<string, unknown>, projectId: string, id: string): Record<string, unknown> {
    const studio = typeof out.url === 'string' ? out.url : null;
    const url = `/app/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(id)}`;
    const message = typeof out.message === 'string' && studio ? out.message.split(studio).join(url) : out.message;
    return { ...out, ...(studio ? { url } : {}), ...(message !== undefined ? { message } : {}) };
}

const TEAM_NOTE =' In this team chat the document is the project\'s: every member who may edit the project fills it in, here or in the form under your answer.';

export function makeProjectTemplateFillTools(deps: Deps) {
    const handlers = deps.handlers || (() => (nodeRequire('../integrations/templateFillTools.mts') as { TEMPLATE_FILL_HANDLERS: Record<string, Handler> }).TEMPLATE_FILL_HANDLERS);
    const definitions = deps.definitions || (() => (nodeRequire('../integrations/templateFillToolDefs.mts') as { TEMPLATE_FILL_TOOLS: ToolDef[] }).TEMPLATE_FILL_TOOLS);

    /** The definitions for a member who may edit a project that holds documents; none otherwise. */
    async function offered(project: Project, userId: string): Promise<ToolDef[]> {
        const role = await deps.getProjectRole(userId, project.id);
        if (role !== 'owner' && role !== 'editor') return [];
        if (!deps.membership().isAllowedIn('document', project.kind ?? null)) return [];
        return definitions()
            .filter((d) => PROJECT_TEMPLATE_FILL_TOOL_NAMES.includes(d.function.name))
            .map((d) => ({ ...d, function: { ...d.function, description: d.function.description + TEAM_NOTE } }));
    }

    /** One answer's run: `execute` for the loop, `touched` for the message that follows. */
    function forAnswer({ project, userId, chatId }: { project: Project, userId: string, chatId: string | null }) {
        const touched: Touched[] = [];
        const ctx = { project: { id: project.id }, conversationId: chatId, documentScope: null };

        async function gate(): Promise<string | null> {
            const role = await deps.getProjectRole(userId, project.id);
            if (role !== 'owner' && role !== 'editor') return 'The person who asked can no longer add to this project.';
            if (!deps.membership().isAllowedIn('document', project.kind ?? null)) return 'This project holds no documents.';
            const { projectOrgOf, belongsToProjectOrg } = deps.projectOrg();
            if (!await belongsToProjectOrg(userId, await projectOrgOf(project))) return 'This project belongs to another organization.';
            return null;
        }

        async function execute(name: string, args: Record<string, unknown>): Promise<string> {
            if (!PROJECT_TEMPLATE_FILL_TOOL_NAMES.includes(name)) return JSON.stringify({ ok: false, error: 'That tool is not available in a team chat.' });
            const refused = await gate();
            if (refused) return JSON.stringify({ ok: false, error: refused });
            const out = await handlers()[name](args, ctx, userId);
            const id = typeof out.documentId === 'string' ? out.documentId : null;
            if (id && !out.error && !touched.some((t) => t.id === id)) touched.push({ kind: 'templateFill', id, name: String(out.name || '') });
            return JSON.stringify(id ? inProject(out, project.id, id) : out);
        }

        return { execute, touched };
    }

    return { offered, forAnswer };
}

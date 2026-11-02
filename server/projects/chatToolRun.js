// @typecheck strict
/**
 * The team chat answer when the AI may use its project tools
 * (projects/chatTools.js): the bounded tool loop around the model call, with
 * the Privacy Shield on both sides of every tool call the way a normal chat
 * applies it, and the lists of what got made and what got changed.
 */

'use strict';

const { MAX_ROUNDS, SEARCH_TOOL } = require('./chatTools');

/** Room for one answer with a whole document (markup and stylesheet) in its tool call. */
const TOOL_MAX_TOKENS = 12_000;

const MAKE_PROMPT = 'You can create documents and notebooks in this project with your tools when a member asks you to write, draft or make one: put the real content in the tool call, not a description of it. '
    + 'When they want a styled or designed document (an invoice, letter, report, a nicely laid-out page), make a designed document with complete HTML and CSS; when they want a reusable template, make it a template with {{placeholders}}. '
    + 'Never say you made or changed something unless a tool call succeeded, and afterwards say so in one or two sentences with its name, without repeating its text. ';
// Without these, the only action left for "add this to our notebook" is a second notebook of the same name.
const FIND_PROMPT = 'Before you create a notebook or document, call list_project_items. When one on the same subject exists, or the member refers to an existing one, read it with read_project_item and work on that one instead of making a new one. Documents can be read but not changed. ';
const EDIT_PROMPT = 'Change an existing notebook with edit_notebook, never by making a second one. Before a replace, read the part with read_project_item mode "search" or "section" and copy find_text exactly. ';
const SEARCH_PROMPT = 'You can search the web with agent_search when a member asks you to look something up or research it, or the answer needs current facts: search with a short, specific query, and never put names, e-mail addresses or other personal data in a query. '
    + 'Answer from what the results say, name the sources with their links, and say so when the results do not answer the question. ';

/**
 * What the system prompt says about the tools, for the ones that were offered.
 * @param {any[]} definitions
 */
function toolsPrompt(definitions) {
    const names = new Set((definitions || []).map((d) => d?.function?.name || d?.name));
    const make = names.has('create_document') || names.has('create_notebook');
    return (make ? MAKE_PROMPT : '') + (names.has('list_project_items') ? FIND_PROMPT : '') + (names.has('edit_notebook') ? EDIT_PROMPT : '')
        + (names.has(SEARCH_TOOL) ? SEARCH_PROMPT : '')
        + 'You can do nothing else outside this chat, and you cannot delete anything.';
}

/**
 * `tools` is the projects/chatTools surface, `definitions` what was offered,
 * `shield` the projects/chatShield surface; `tokenMap` holds the placeholders
 * the model saw, to put back in what it writes, and `auditBase` the ids for
 * the guardrail event rows.
 *
 * @param {{
 *   tools: Pick<ReturnType<typeof import('./chatTools').makeProjectChatTools>, 'forAnswer'>,
 *   definitions: any[],
 *   runToolLoop: typeof import('../core/llm/llmClient').runToolLoop,
 *   shield: Pick<ReturnType<typeof import('./chatShield').makeChatShield>, 'toolGate'|'searchGuard'|'restoreArgs'>,
 *   shieldConfig: any|null,
 *   project: { id: string, organizationId?: string|null },
 *   userId: string,
 *   orgId: string|null,
 *   session: any|null,
 *   modelId: string,
 *   messages: any[],
 *   options: Parameters<typeof import('../core/llm/llmClient').runToolLoop>[3],
 *   tokenMap: Record<string,string>|null,
 *   auditBase: Record<string, unknown> }} p
 */
async function answerWithTools({ tools, definitions, runToolLoop, shield, shieldConfig, project, userId, orgId, session, modelId, messages, options, tokenMap, auditBase }) {
    const run = tools.forAnswer({ project, userId, orgId, session });
    const gate = shield.toolGate({ shield: shieldConfig, orgId, userId, auditBase });
    const guardSearch = shield.searchGuard({ shield: shieldConfig, orgId, userId, auditBase });
    /**
     * @param {string} name
     * @param {Record<string, any>} args
     */
    const executeTool = async (name, args) => {
        // What the model wrote may carry placeholders; an item is made with the real values, but a search query
        // keeps its placeholders, so no real personal data goes to a search provider.
        const isSearch = name === SEARCH_TOOL;
        const real = isSearch ? args : shield.restoreArgs(args, tokenMap);
        const refusal = await gate.refuse(name, real);
        if (refusal) return JSON.stringify({ ok: false, error: refusal.modelError });
        if (isSearch) {
            const blocked = await guardSearch(String(real?.query ?? ''));
            if (blocked) return JSON.stringify({ ok: false, error: blocked.modelError });
        }
        const out = await run.execute(name, real);
        return gate.forModel(out, name);
    };
    const result = await runToolLoop(modelId, messages, definitions, options, executeTool, MAX_ROUNDS);
    return { result, created: run.created, edited: run.edited };
}

module.exports = { answerWithTools, toolsPrompt, TOOL_MAX_TOKENS };

// @typecheck
/**
 * The team chat answer when the AI may use its project tools
 * (projects/chatTools.js): the bounded tool loop around the model call, with
 * the Privacy Shield on both sides of every tool call the way a normal chat
 * applies it, and the list of what got made.
 */

'use strict';

const { MAX_ROUNDS } = require('./chatTools');

/** Room for one answer with a whole document (markup and stylesheet) in its tool call. */
const TOOL_MAX_TOKENS = 12_000;

/** What the system prompt says about the tools when there are any. */
const TOOLS_PROMPT = 'You can create documents and notebooks in this project with your tools when a member asks you to write, draft or make one: put the real content in the tool call, not a description of it. '
    + 'When they want a styled or designed document (an invoice, letter, report, a nicely laid-out page), make a designed document with complete HTML and CSS; when they want a reusable template, make it a template with {{placeholders}}. '
    + 'You can do nothing else outside this chat, and you cannot open, change or delete anything that already exists. '
    + 'Never say you made something unless a tool call succeeded, and after making something say so in one or two sentences with its name, without repeating its text.';

/**
 * @param {object} p
 * @param {object} p.tools           projects/chatTools surface (forAnswer)
 * @param {any[]} p.definitions      what was offered
 * @param {Function} p.runToolLoop   llmClient.runToolLoop-shaped: (modelId, messages, tools, options, executeTool, maxRounds)
 * @param {any} p.shield             projects/chatShield surface (toolGate, restoreArgs)
 * @param {object|null} p.shieldConfig
 * @param {{ id: string, organizationId?: string|null }} p.project
 * @param {string} p.userId
 * @param {string|null} p.orgId
 * @param {object|null} p.session
 * @param {string} p.modelId
 * @param {any[]} p.messages
 * @param {object} p.options
 * @param {Record<string,string>|null} p.tokenMap  placeholders the model saw, to put back in what it writes
 * @param {object} p.auditBase       ids for the guardrail event rows
 */
async function answerWithTools({ tools, definitions, runToolLoop, shield, shieldConfig, project, userId, orgId, session, modelId, messages, options, tokenMap, auditBase }) {
    const run = tools.forAnswer({ project, userId, orgId, session });
    const gate = shield.toolGate({ shield: shieldConfig, orgId, userId, auditBase });
    const executeTool = async (name, args) => {
        // What the model wrote may carry placeholders; the item is made with the real values.
        const real = shield.restoreArgs(args, tokenMap);
        const refusal = await gate.refuse(name, real);
        if (refusal) return JSON.stringify({ ok: false, error: refusal.modelError });
        const out = await run.execute(name, real);
        return gate.forModel(out, name);
    };
    const result = await runToolLoop(modelId, messages, definitions, options, executeTool, MAX_ROUNDS);
    return { result, created: run.created };
}

module.exports = { answerWithTools, TOOLS_PROMPT, TOOL_MAX_TOKENS };

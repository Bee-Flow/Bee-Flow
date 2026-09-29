/**
 * The skill-test SANDBOX — which tools a Test-tab run may call.
 * (Bee Flow Builder redesign, Sep 2026, Track S3.)
 *
 * `POST /api/skills/:id/test` runs ONE agent turn on request of somebody who
 * is editing a skill. That turn talks to a model, and a model that is handed
 * `gmail_compose` will eventually call it. So the tool list a test turn gets
 * is built from NOTHING and grows by hand, rather than being the agent's
 * real stack with the dangerous entries filtered out.
 *
 * ── WHY AN ALLOW-LIST AND NOT A DENY-LIST ───────────────────────────
 * A deny-list is a promise about tools that do not exist yet. Every
 * integration added next year would land inside the sandbox by default, and
 * nothing in this file would go red. The list below is CLOSED: a name that
 * is not in it has no definition to give the model and is refused by the
 * executor even if it somehow reaches it. `skillSandbox.test.js` proves that
 * with a tool nobody has ever heard of.
 *
 * ── TWO INDEPENDENT GATES ───────────────────────────────────────────
 *   1. the closed name list in this file — a human decision per tool;
 *   2. `sideEffectMap.effectOf(name) === 'reads'` — the app-wide
 *      classification, which is fail-closed (an unknown name is `writes`).
 * Both are checked at BUILD time (a name that stops being read-only is never
 * offered) and gate 1 again at EXECUTE time. They are independent on
 * purpose: adding a name here does not make it read-only, and reclassifying
 * a tool in sideEffectMap.js drops it out of the sandbox without anyone
 * having to remember this file exists.
 *
 * ── WHAT A PASSAGE IS ───────────────────────────────────────────────
 * `kb_search` returns text from the user's own documents. The `ask.js`
 * doctrine applies unchanged: the passages are fenced and prefixed with
 * `DATA_NOT_INSTRUCTIONS`, because a crafted PDF saying "ignore the above"
 * reaches this model too.
 *
 * ── THE KB IDS ARE NOT THE MODEL'S TO CHOOSE ────────────────────────
 * `quickKBSearch` does no tenant filtering — the ids it is handed ARE the
 * boundary. The model never names one: the route resolves the skill's own
 * knowledge bases, checks each against the CALLER with the RETRIEVAL check
 * (`usableKbIdsForRequest`, not the management one), and passes the surviving
 * ids in the context together with how many were declared. The tool takes a
 * query and nothing else.
 */

'use strict';

const { effectOf } = require('../../automation/sideEffectMap');
const log = require('../../telemetry/log');

/** A test question is a question; a query for the search is shorter still. */
const MAX_QUERY_CHARS = 500;
/** Passages per search. Eight is what the KB test question shows. */
const SANDBOX_KB_TOPK = 6;
/** Guard against a source whose passages are enormous. */
const MAX_CHUNK_CHARS = 2000;

/**
 * Search the knowledge bases the SKILL declares — never a base the model
 * names, and never one the caller may not read (the route filtered them).
 *
 * ── AN EMPTY LIST IS NOT ONE SENTENCE ───────────────────────────────
 * `ctx.kbDeclared` is how many bases the skill actually links, before the
 * caller's rights were applied. Without it this tool said "this skill has no
 * knowledge base linked" to a skill that links three the tester may not read
 * — a claim about the SKILL made out of an answer about the PERSON. The model
 * then answered from the skill text, the grader saw no evidence for the step
 * that says "look it up", and the run was stored as a verdict on the skill.
 * Same rule as the failed search two lines down: say what happened.
 */
async function runKbSearch(args, ctx) {
    const query = typeof args?.query === 'string' ? args.query.trim().slice(0, MAX_QUERY_CHARS) : '';
    if (!query) return 'No query given, so nothing was searched.';
    const kbIds = Array.isArray(ctx?.kbIds) ? ctx.kbIds.filter(Boolean) : [];
    const declared = Number.isInteger(ctx?.kbDeclared) ? ctx.kbDeclared : kbIds.length;
    const dropped = Math.max(0, declared - kbIds.length);
    if (kbIds.length === 0) {
        if (declared === 0) {
            return 'This skill has no knowledge base linked, so there is nothing to search. Answer from the skill itself.';
        }
        return 'The knowledge bases this skill links are not available to the person running this test, '
            + 'so nothing was searched. Answer from the skill itself, and do not claim the knowledge base was consulted.';
    }
    const note = dropped > 0
        ? `\n\n(${dropped} of the ${declared} knowledge bases this skill links are not available to the person running this test and were not searched.)`
        : '';
    let chunks = [];
    try {
        const { quickKBSearch } = require('../agentRuntime/knowledgeSearch');
        chunks = await quickKBSearch(ctx.userId, kbIds, query, {
            topK: SANDBOX_KB_TOPK,
            session: ctx.session || null,
        }) || [];
    } catch (err) {
        // A failed search is a failed search — never "nothing was found",
        // which the model would report as "the sources do not cover this".
        return `The knowledge search failed and returned nothing: ${err.message}`;
    }
    if (chunks.length === 0) return `No passages matched that query.${note}`;
    const { fenceChunks, DATA_NOT_INSTRUCTIONS } = require('../kb/sourceFencing');
    return `${DATA_NOT_INSTRUCTIONS}\n\n${fenceChunks(chunks, { maxChars: MAX_CHUNK_CHARS })}${note}`;
}

/**
 * THE list. A Map (not an object literal) so a name like `constructor` or
 * `__proto__` cannot resolve to something inherited: membership here is a
 * security answer, and `{}` answers it wrong for three keys.
 */
const SANDBOX_TOOLS = new Map([
    ['kb_search', {
        def: {
            type: 'function',
            function: {
                name: 'kb_search',
                description: 'Search the knowledge bases this skill is allowed to read. Returns passages from the user\'s own documents, nothing else. Use it when the skill says an answer should come from the knowledge base.',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['query'],
                    properties: {
                        query: { type: 'string', description: 'What to look for, in the words of the question.' },
                    },
                },
            },
        },
        run: runKbSearch,
    }],
]);

/** Every name the sandbox knows about, in declaration order. */
const SANDBOX_TOOL_NAMES = Object.freeze([...SANDBOX_TOOLS.keys()]);

/** Gate 2, on its own so the test can assert the whole list passes it. */
function isReadOnlyTool(name) {
    return effectOf(name) === 'reads';
}

/** Is `name` in the closed list AND still classified read-only? */
function isSandboxTool(name) {
    return typeof name === 'string' && SANDBOX_TOOLS.has(name) && isReadOnlyTool(name);
}

/**
 * The tool definitions a test turn is handed — BUILT, not filtered. A name
 * that sideEffectMap no longer calls a read is dropped here with a warning
 * rather than offered: reclassification is exactly the change that must not
 * need somebody to remember this file.
 *
 * @returns {Array} OpenAI-format tool defs (possibly empty)
 */
function buildSandboxTools() {
    const out = [];
    for (const [name, entry] of SANDBOX_TOOLS) {
        if (!isReadOnlyTool(name)) {
            log.warn(`[skillSandbox] "${name}" is no longer classified read-only — not offered to a skill test.`);
            continue;
        }
        out.push(entry.def);
    }
    return out;
}

/**
 * Run one sandbox tool. Refuses ANY name that is not in the closed list —
 * including a name that reached the tool loop through a definition the model
 * hallucinated, or one a future caller passed by mistake. The refusal is a
 * tool RESULT, not a throw: the turn continues and the model is told plainly
 * that the tool does not exist here.
 *
 * @param {string} name
 * @param {object} args   the model's arguments — untrusted
 * @param {{ userId:string, kbIds:string[], session?:object }} ctx
 * @returns {Promise<string>}
 */
async function executeSandboxTool(name, args, ctx = {}) {
    if (!isSandboxTool(name)) {
        return `The tool "${String(name).slice(0, 80)}" is not available while testing a skill. A test runs read-only: no messages, no writes, no external calls. Answer with what you have.`;
    }
    return SANDBOX_TOOLS.get(name).run(args || {}, ctx);
}

module.exports = {
    SANDBOX_TOOL_NAMES,
    buildSandboxTools,
    executeSandboxTool,
    isSandboxTool,
    isReadOnlyTool,
    MAX_QUERY_CHARS,
    SANDBOX_KB_TOPK,
};

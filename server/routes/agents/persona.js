/**
 * POST /agents/:id/persona/parse — "back to fields" (A1c).
 *
 * The persona → prompt direction is a pure rendering
 * (core/agentRuntime/personaPrompt.js). The way BACK is not: a prompt someone
 * wrote by hand cannot be decomposed into who/tone/does/doesNot without
 * inventing something, so it is an explicit, user-triggered AI parse on the
 * fast tier rather than anything that happens on a save.
 *
 * THREE THINGS THIS ENDPOINT DOES NOT DO, each on purpose:
 *
 *   It does not WRITE. The parse is a proposal; the editor shows the fields and
 *   the user saves them (or does not) through the normal PUT, which re-clamps
 *   everything and holds the CAS token. A write here would race the editor's
 *   autosave and hand the model a way to change an agent nobody looked at.
 *
 *   It does not TRUST the model. `normalisePersona` clamps the whole result —
 *   an enum outside the three modes lands on the narrowest one, a language it
 *   cannot name is dropped, every list and string is bounded. The model output
 *   is untrusted input like any other request body.
 *
 *   It does not return a ROUTINE id. `unknown.automationId` is stripped from
 *   whatever comes back: no model knows this installation's automation ids, so
 *   anything in that field is a guess, and a guess there is a grant request.
 *   The user picks the routine in the editor.
 *
 * Gate: `manage_agents` on the router, then `canModifyAgent` per call — the
 * same chain as PUT /agents/:id and routes/versions.js. The endpoint reads the
 * agent's own system prompt when no text is supplied, so anything less would
 * hand a draft prompt to someone who may only chat with the agent.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// One key is read: the text on screen. A misspelled one fell through to the
// agent's STORED text, so the parse ran over the saved prompt instead of the
// edit in front of the person -- and came back 200 with cards that described
// something else.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const ParseBody = bodyOf({ text: worded('text is the instruction to read.').nullish() });

const agentStore = require('../../stores/agentStore');
const llmClient = require('../../core/llm/llmClient');
const { resolveModelForTierName } = require('../../core/llm/modelResolver');
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const personaPrompt = require('../../core/agentRuntime/personaPrompt');

// One LLM call per request. Without a cap a logged-in user can run up the
// org's inference bill at request rate; 20/min is far above human use of a
// button you press when you switch a panel back to fields.
const parseLimiter = perUserRateLimit({ windowMs: 60_000, max: 20 });

const PERSONA_TOOL = {
    type: 'function',
    function: {
        name: 'agent_persona',
        description: 'Describe an AI agent\'s role as separate fields, taken strictly from the instructions given.',
        parameters: {
            type: 'object',
            properties: {
                who: { type: 'string', description: 'One or two sentences: who this agent is and who it is for. Second person ("You are …").' },
                tone: {
                    type: 'object',
                    properties: {
                        chips: { type: 'array', items: { type: 'string' }, description: 'Up to 5 one-word tone labels, lowercase (e.g. friendly, concise, formal).' },
                        text: { type: 'string', description: 'One sentence about tone that the labels do not already cover. Empty string if there is none.' },
                    },
                },
                does: { type: 'array', items: { type: 'string' }, description: 'Short bullets: what the agent does. One task per bullet.' },
                doesNot: { type: 'array', items: { type: 'string' }, description: 'Short bullets: what the agent must never do. Empty array if the instructions say nothing about this.' },
                unknown: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string', enum: ['honest', 'web', 'handoff'], description: 'What the instructions say to do when the answer is not known: honest = say so, web = search the web, handoff = pass it to someone/something else. Use "honest" when the instructions do not say.' },
                    },
                },
                language: { type: 'string', description: 'ISO code of the language the agent must reply in (e.g. "nl"), or "" when the instructions do not fix one.' },
            },
            required: ['who', 'does'],
        },
    },
};

const SYSTEM = [
    'You take the system prompt of an AI agent and split it into separate fields for an editor.',
    'Report ONLY what the prompt actually says. Never add a rule, a tone or a language that is not there — an empty field is correct and expected.',
    'Keep the wording of the original where you can, and keep every field in the language the prompt is written in.',
    'Bullets are short: one instruction each, no numbering, no trailing punctuation.',
].join(' ');

router.post('/:id/persona/parse', requirePermission('manage_agents'), parseLimiter, validate({ body: ParseBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { canModifyAgent } = require('./crud');
    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({
            error: 'You do not have permission to edit this agent.',
            code: 'agent_not_editable',
        });
    }

    // The text to parse: what the editor has on screen, or — when it sends
    // nothing — the agent's own free text / prompt. Both are the concept,
    // which is what this caller is allowed to read (the gate above is the
    // editor gate, not the chat gate).
    const supplied = typeof req.body?.text === 'string' ? req.body.text : null;
    const stored = (agent.persona && agent.persona.freeText) || agent.system_prompt || '';
    const text = (supplied !== null ? supplied : stored).slice(0, personaPrompt.LIMITS.freeText);
    if (!text.trim()) {
        return res.status(400).json({ error: 'There is no instruction text to read.', code: 'persona_empty' });
    }

    // The workspace is what the tier lookup below is resolved AGAINST: it
    // selects the org's own tier and the EU override. A failed resolve read
    // as `null` would be read one line later as "no org at all" — the
    // global, non-EU tier map — so it refuses instead. (`null` after a
    // SUCCESSFUL resolve still means super admin, and stays legal.)
    let orgIds;
    try {
        // `strict`, anders is deze catch onbereikbaar: zonder die vlag vangt
        // `resolveUserOrgIds` élke storefout zelf af en geeft een LEGE Set
        // terug, die één regel verder als "geen workspace" leest — de
        // globale, niet-EU tiermap, precies wat het commentaar hierboven
        // uitsluit.
        orgIds = await resolveUserOrgIds(req, { strict: true });
    } catch (e) {
        log.error('[agents/persona/parse] could not resolve the workspace:', e.message);
        return res.status(503).json({
            error: 'Could not check your workspace right now. Try again.',
            code: 'org_check_failed',
        });
    }
    const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

    // No `fallback:` on purpose — see modelResolver.resolveModelForTierName.
    // This request hands the agent's own instruction text to a model; a
    // hardcoded default here sent it to Google for a workspace that never
    // chose Google, and past the EU override at that. Not configured and
    // not readable both refuse, and they say different things.
    let modelId;
    try {
        modelId = await resolveModelForTierName('fast', { userOrgId, userId });
    } catch (e) {
        log.error('[agents/persona/parse] model tier unreadable:', e.message);
        return res.status(503).json({
            error: 'Could not look up which model reads these instructions. Try again.',
            code: 'persona_model_unavailable',
        });
    }
    if (!modelId) {
        return res.status(503).json({
            error: 'No AI model is configured to read these instructions.',
            code: 'no_persona_model',
        });
    }

    let structured;
    try {
        ({ structured } = await llmClient.chatForcedTool(modelId, [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Agent instructions:\n\n${text}` },
        ], PERSONA_TOOL, { maxTokens: 1500, temperature: 0.1, reasoningEffort: 'none', budgetTokens: 0 }));
    } catch (e) {
        log.error('[agents/persona/parse] inference failed:', e.message);
        return res.status(502).json({ error: 'Could not read the instructions right now.', code: 'persona_parse_failed' });
    }
    if (!structured || typeof structured !== 'object') {
        return res.status(422).json({ error: 'The model did not return usable fields.', code: 'persona_parse_failed' });
    }

    // Clamp, then override the two fields the MODEL does not get to decide:
    // the mode (a parse always lands in fields mode — that is what the user
    // pressed) and the routine id (see the header).
    const { persona, warnings } = personaPrompt.normalisePersona({ ...structured, mode: 'fields', freeText: '' });
    persona.unknown = { mode: persona.unknown.mode, automationId: null };

    res.json({ persona, warnings });
});

module.exports = router;

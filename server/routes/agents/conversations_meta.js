const express = require('express');
const agentStore = require('../../stores/agentStore');
require('../../core/agentRuntime');
require('../../core/aiAgent');
require('../../stores/configStore');
require('../../auth');
require('../../stores/memoryStore');
require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');

require('../../stores/userStore');
require('../../stores/usageStore');
require('../../core/entitlements/limits');
require('../../core/http/sseHelpers');

const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What the search query may say ------------------------------------
//
// `source` decided which two halves of the search ran, and it decided them
// by saying what it is NOT: `includeAgents = source !== 'direct'` and
// `includeDirect = source !== 'agent'`. So `source=agents` -- one letter off
// -- switched BOTH halves on, and somebody who had narrowed to their agent
// conversations was handed their direct chats as well, under a 200. Any
// other spelling did the same thing.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const SOURCE_TEXT = 'source is "agent" or "direct".';
const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();
const whole = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`).optional();

const SearchQuery = z.object({
    // Shorter than two characters still answers with an empty list rather
    // than a refusal: that is the search box mid-word, not a bad request.
    q: worded('q is what to search for.').optional(),
    agentId: one('agentId', 'the id of an agent'),
    startDate: one('startDate', 'a date'),
    endDate: one('endDate', 'a date'),
    source: z.enum(['agent', 'direct'], { errorMap: () => ({ message: SOURCE_TEXT }) }).optional(),
    limit: whole('limit'),
    offset: whole('offset'),
}).strict();

// ============ All Conversations ============

// Get all conversations for the current user across all agents
router.get('/conversations/all', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversations = await agentStore.listAllConversations(userId);
    res.json(conversations);
});

// Search all conversations (agent + direct)
const SEARCH_MAX_LIMIT = 200;
const SEARCH_DEFAULT_LIMIT = 50;
router.get('/conversations/search', validate({ query: SearchQuery }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { q, agentId, startDate, endDate, source } = req.query;

    if (!q || q.length < 2) {
        return res.json([]);
    }

    // If a specific agentId is supplied, gate it on access — otherwise the
    // endpoint can be used to enumerate agents the user can't read.
    if (agentId) {
        const { canReadAgent } = require('./crud');
        const agent = await agentStore.getAgent(agentId);
        if (!agent || !(await canReadAgent(agent, userId, req))) {
            return res.status(404).json({ error: 'Agent not found' });
        }
    }

    const filters = {};
    if (agentId) filters.agentId = agentId;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const encryptionKey = req.session?.encryptionKey;
    const includeAgents = source !== 'direct';
    const includeDirect = source !== 'agent' && !agentId; // direct chats have no agent

    const [agentResults, directResults] = await Promise.all([
        includeAgents ? agentStore.searchConversations(userId, q, filters, encryptionKey) : Promise.resolve([]),
        includeDirect ? agentStore.searchDirectConversations(userId, q, filters, encryptionKey) : Promise.resolve([]),
    ]);

    const tagged = [
        ...agentResults.map(r => ({ ...r, kind: 'agent' })),
        ...directResults,
    ];

    tagged.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    // Backwards-compatible: still return a plain array (the existing
    // SearchOverlay consumer expects this). Pagination is surfaced via
    // X-Total-Count / X-Has-More headers for new callers.
    const rawLimit = req.query.limit;
    const rawOffset = req.query.offset;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const items = tagged.slice(offset, offset + limit);
    res.set('X-Total-Count', String(tagged.length));
    res.set('X-Has-More', String(offset + items.length < tagged.length));
    res.json(items);
});


module.exports = router;

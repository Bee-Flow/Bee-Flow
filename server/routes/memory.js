/**
 * Memory API Routes
 * Manage user memories for AI agents
 *
 * SECURITY: every route here requires a signed-in user — `router.use(requireAuth)`
 * runs before any handler, so an anonymous caller is 401'd before a single
 * store call. Until the 2026-08 memory overhaul this router was classified as
 * part of the guest-chat surface: every handler scoped on `getEffectiveUserId`,
 * which mints a `guest_<random>` id for a visitor instead of returning 401, and
 * the rationale was that a guest had to be able to see and delete what the
 * product remembered about them. That rationale no longer holds: the extractor
 * writes nothing for an anonymous id (agents/memory/extractor.js — a `guest_*`
 * id has no data subject who could ever exercise access or erasure), and
 * migrations/memory-guest-purge-2026-08.js removed the rows written before.
 * What remained of the open design was an unauthenticated, unrate-limited
 * write path into `user_memories` — and anything stored as
 * `type: 'instruction'` is rendered into the system prompt of every later turn.
 *
 * Input validation lives here for the same reason: `type` is a closed
 * vocabulary, `content` is capped, `importance` is clamped, and PUT validates
 * like POST. Proven by routes/memory.guards.test.js and
 * routes/memory.validation.test.js; project-role authorization by
 * routes/memory.authz.test.js.
 *
 * ── WHAT A CALLER MAY SEND ──────────────────────────────────────────
 * Every body and query is a zod schema, `.strict()`. What the hand-written
 * checks let through under a 200:
 *
 *   - `POST /clear` ignored its body, so `{"agentId":"a1"}` — "clear this
 *     agent's memories" — deleted EVERY memory the person had. Its only
 *     narrowing now is `{"projectId"}`, which clears that project's shared
 *     pool (editor required); anything else is refused. Without it the
 *     project tab's "Clear All" deleted the member's PERSONAL memories;
 *   - `PUT /:id` validated `type` and then dropped it (updateMemory has no
 *     type column), so a type change answered success and changed nothing.
 *     A memory's type is refused on PUT, with the reason;
 *   - `PUT /:id {"importance":0.9}` replaced the stored summary with the
 *     first 50 characters of the content: the route handed the store `null`
 *     for "not sent", and the store reads null as "derive a new one". A PUT
 *     that leaves both content and summary alone keeps the summary now;
 *   - a non-number `importance` became the default (POST) or was ignored
 *     (PUT); `?type=instuction` listed nothing, as if there were no
 *     instructions; `?projectid=p1` (one letter's case) listed the person's
 *     own memories instead of the project's. All refused.
 *
 * `:id` is a TEXT key; an unknown one is the store's 404.
 *
 * POST /import additionally spends LLM tokens, so it carries the same per-user
 * rate limit as the LLM-backed helpers in routes/agents/chat.js, caps how many
 * memories one paste may create, and de-dupes against what already exists.
 */

const express = require('express');
const memoryStore = require('../stores/memoryStore');
const { hasProjectRole } = require('../auth/projectAccess');
const { requireAuth } = require('../auth');
const { getEffectiveUserId } = require('./agents');
const { extractJSON } = require('../pipeline/llmHelpers');
const llmClient = require('../core/llm/llmClient');
const { resolveModelForTier, getTierConfig } = require('../core/llm/modelResolver');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// Anonymous → 401 before any handler runs. See the SECURITY header.
router.use(requireAuth);

// LLM-backed import is rate-limited to prevent cost blow-up — same shape as
// helperLimiter in routes/agents/chat.js.
const importLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });

const MAX_IMPORT_BYTES = 50_000;
/** Memories one paste may create; the remainder is reported as skipped. */
const MAX_IMPORT_ITEMS = 100;
/** Longest memory a caller may store. Instructions are clipped far shorter at prompt time. */
const MAX_CONTENT_CHARS = 2000;
const MAX_SUMMARY_CHARS = 500;
const DEFAULT_IMPORTANCE = 0.5;
const VALID_TYPES = new Set(['instruction', 'person', 'project', 'preference', 'workflow', 'fact', 'context']);

// Memory type definitions
const MEMORY_TYPES = [
    { id: 'instruction', label: 'Instructions', icon: '📌', description: 'Standing instructions (always/never do X)' },
    { id: 'person', label: 'People', icon: '👤', description: 'People you know and work with' },
    { id: 'project', label: 'Projects', icon: '📁', description: 'Project details, tech stacks, URLs' },
    { id: 'preference', label: 'Preferences', icon: '⚙️', description: 'Your preferences and settings' },
    { id: 'workflow', label: 'Workflows', icon: '🔄', description: 'How you like to work' },
    { id: 'fact', label: 'Facts', icon: '📋', description: 'Facts about you or your work' },
    { id: 'context', label: 'Context', icon: '🏢', description: 'General background context' },
];

// ── What a caller may send ───────────────────────────────────────────────────
//
// One set of field schemas for POST and PUT alike — fixing only the create
// path would leave the identical hole one verb away.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** Express 5 leaves `req.body` undefined without a body; read that as `{}`. */
const orEmpty = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);
const NoQuery = orEmpty(z.object({}).strict());

const CONTENT_TEXT = 'Content is required';
const TYPE_TEXT = `type must be one of: ${[...VALID_TYPES].join(', ')}`;
const SUMMARY_TEXT = `summary must be a string of at most ${MAX_SUMMARY_CHARS} characters`;
const IMPORTANCE_TEXT = 'importance is a number from 0 to 1.';

// Length is checked on what was sent, then trimmed, then required non-blank —
// the order the hand-written check had.
const memoryContent = worded(CONTENT_TEXT)
    .max(MAX_CONTENT_CHARS, `content exceeds ${MAX_CONTENT_CHARS} characters`)
    .trim().min(1, CONTENT_TEXT);
const memoryType = z.enum([...VALID_TYPES], { errorMap: () => ({ message: TYPE_TEXT }) });
/** A blank summary is no summary: the store then derives one from the content. */
const memorySummary = worded(SUMMARY_TEXT).max(MAX_SUMMARY_CHARS, SUMMARY_TEXT)
    .transform((v) => v.trim() || null).nullish();
/**
 * A number (or the digits of one) is clamped into [0, 1]. Anything else used
 * to become the default on POST and be ignored on PUT; it is refused now.
 */
const memoryImportance = z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v),
    z.number({ invalid_type_error: IMPORTANCE_TEXT }).finite(IMPORTANCE_TEXT)
        .transform((n) => Math.min(1, Math.max(0, n))),
).nullish();
const optionalId = (what) => worded(`${what} is an id.`).trim().max(200, `${what} is at most 200 characters.`).nullish();

const CreateMemoryBody = orEmpty(z.object({
    content: memoryContent,
    type: memoryType.nullish(),
    summary: memorySummary,
    importance: memoryImportance,
    agentId: optionalId('agentId'),
    projectId: optionalId('projectId'),
}).strict());

const UpdateMemoryBody = orEmpty(z.object({
    content: memoryContent.nullish(),
    // updateMemory has no type column: this used to be validated and dropped.
    type: z.undefined({ invalid_type_error: 'A memory\'s type cannot be changed. Delete it and add it again with the right type.' }),
    summary: memorySummary,
    importance: memoryImportance,
}).strict());

const BulkDeleteBody = orEmpty(z.object({
    ids: z.array(worded('Each id is the id of a memory.'), { required_error: 'ids array is required', invalid_type_error: 'ids array is required' })
        .min(1, 'ids array is required'),
}).strict());

/**
 * Clear takes one narrowing and only one: the project whose shared pool to
 * empty. A blank or null `projectId` is refused rather than read as "no
 * project": that reading is the personal clear, and a caller that meant a
 * project and lost the id on the way must not wipe someone's personal memory.
 */
const PROJECT_ID_TEXT = 'projectId is the id of the project whose memory to clear.';
const ClearBody = orEmpty(z.object({
    projectId: worded(PROJECT_ID_TEXT).trim().min(1, PROJECT_ID_TEXT)
        .max(200, 'projectId is at most 200 characters.').optional(),
}, { invalid_type_error: 'The body is empty, or names the project to clear: {"projectId": "…"}.' }).strict());

const ImportBody = orEmpty(z.object({
    // The byte limit is the handler's: it is a limit on bytes, not characters.
    text: worded('text is required').trim().min(1, 'text is required'),
}).strict());

/**
 * The list's filters. `schedule_coverage` is a type the product writes itself
 * (stores/memoryStore R3) and so may be listed, though no one may create one.
 */
const LIST_TYPES = [...VALID_TYPES, 'schedule_coverage'];
function pageNumber(name, { min, max, fallback }) {
    const text = `${name} is a whole number.`;
    return worded(text).trim().regex(/^-?\d+$/, text)
        .transform((v) => Math.min(Math.max(Number(v), min), max))
        .default(String(fallback));
}
const ListQuery = orEmpty(z.object({
    agentId: worded('agentId is an id.').trim().max(200, 'agentId is at most 200 characters.').optional(),
    projectId: worded('projectId is an id.').trim().max(200, 'projectId is at most 200 characters.').optional(),
    type: z.enum(LIST_TYPES, { errorMap: () => ({ message: `type is one of: ${LIST_TYPES.join(', ')}.` }) }).optional(),
    search: worded('The search term must be text.').trim().max(200, 'The search term is at most 200 characters.').optional(),
    // The same clamp the store applies (1–200), so the echoed limit is honest.
    limit: pageNumber('limit', { min: 1, max: 200, fallback: 50 }),
    offset: pageNumber('offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
}).strict());

// Get memory type definitions
router.get('/types', validate({ query: NoQuery }), (req, res) => {
    res.json({ types: MEMORY_TYPES });
});

/**
 * Can this user touch this memory row?
 *
 * Project memories are a SHARED pool — memoryStore drops the `user_id` filter for
 * them on purpose, so every member sees the same rows. That makes the role the
 * only thing standing between a viewer and the delete button, and the previous
 * code used `userHasAccess`, which is true for viewers: a read-only member could
 * wipe a project's entire memory. Reads need viewer, writes need editor.
 *
 * `hasProjectRole` resolves the caller's groups itself, which also fixes the
 * separate bug where group-shared members were 403'd from their own project.
 *
 * @param {string} userId
 * @param {object} memory  row from user_memories
 * @param {'viewer'|'editor'} minRole
 */
async function canAccessMemory(userId, memory, minRole) {
    if (memory.project_id) return hasProjectRole(userId, memory.project_id, minRole);
    return memory.user_id === userId;
}

// Get all memories for current user. For the user-global view (no agentId /
// projectId) supports `limit`, `offset`, and `search` so the Memory panel can
// page through the full backlog and find specific entries (BFSF-161).
router.get('/', validate({ query: ListQuery }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agentId = req.query.agentId || null;
    const projectId = req.query.projectId || null;
    const typeFilter = req.query.type || null;
    const search = req.query.search || null;
    const { limit, offset } = req.query;

    if (projectId) {
        // Verify the caller can actually see this project before returning its
        // memories — every other project-scoped memory endpoint already does
        // this; the list endpoint was missing the check, letting any logged-in
        // user dump project memories by guessing the UUID.
        if (!await hasProjectRole(userId, projectId, 'viewer')) {
            return res.status(403).json({ error: 'No access to this project' });
        }
        const memories = await memoryStore.getMemoriesForProject(userId, projectId);
        const filtered = typeFilter ? memories.filter(m => m.type === typeFilter) : memories;
        return res.json({ memories: filtered });
    }
    if (agentId) {
        // Honor the agent's "use general memory" flag for per-agent agents.
        let includeGeneral = true;
        try {
            const agentStore = require('../stores/agentStore');
            const a = await agentStore.getAgent(agentId);
            const cfg = a?.config || {};
            if (cfg.memoryEnabled === true && cfg.useGeneralMemory === false) {
                includeGeneral = false;
            }
        } catch (_) { /* default to true */ }
        const memories = await memoryStore.getMemoriesForAgent(userId, agentId, 50, { includeGeneral });
        const filtered = typeFilter ? memories.filter(m => m.type === typeFilter) : memories;
        return res.json({ memories: filtered });
    }

    // User-global view — paginate + search at the DB layer.
    const page = await memoryStore.searchUserMemories(userId, {
        limit,
        offset,
        search,
        type: typeFilter,
    });
    res.json({
        memories: page.items,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        hasMore: page.offset + page.items.length < page.total,
    });
});

// User-global memory stats (total + type distribution + importance buckets).
// Must be registered before `/:id` or Express will route "stats" as an id.
router.get('/stats', validate({ query: NoQuery }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const stats = await memoryStore.getMemoryStats(userId);
    res.json(stats);
});

// Get a single memory
router.get('/:id', validate({ query: NoQuery }), async (req, res) => {
    const userId = getEffectiveUserId(req);

    const memory = await memoryStore.getMemoryById(req.params.id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    if (!await canAccessMemory(userId, memory, 'viewer')) {
        return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ memory });
});

// Create a memory manually
router.post('/', validate({ body: CreateMemoryBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { agentId, projectId, content, type, summary, importance } = req.body;

    // Writing into a project's shared memory pool requires editor, not membership.
    if (projectId && !await hasProjectRole(userId, projectId, 'editor')) {
        return res.status(403).json({ error: 'Editor role required for this project' });
    }

    const id = await memoryStore.createMemory(
        userId, agentId || null, type || 'fact',
        content, summary ?? null, importance ?? DEFAULT_IMPORTANCE, null, null, null, null, projectId || null
    );
    res.json({ success: true, id });
});

// Update a memory — validated like POST.
router.put('/:id', validate({ body: UpdateMemoryBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { content, summary, importance } = req.body;

    const memory = await memoryStore.getMemoryById(req.params.id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    if (!await canAccessMemory(userId, memory, 'editor')) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const newContent = content ?? memory.content;
    // updateMemory reads a null summary as "derive one from the content".
    // Right when the content changed; wrong when only the importance did —
    // that used to overwrite the stored summary with 50 characters of text.
    const keepSummary = summary === undefined && (content === undefined || content === null);
    await memoryStore.updateMemory(
        req.params.id,
        newContent,
        keepSummary ? (memory.summary ?? null) : (summary ?? null),
        importance ?? null,
    );
    res.json({ success: true });
});

// Bulk delete memories
router.post('/bulk-delete', validate({ body: BulkDeleteBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { ids } = req.body;

    let deleted = 0;
    for (const id of ids) {
        const memory = await memoryStore.getMemoryById(id);
        if (!memory) continue;
        if (!await canAccessMemory(userId, memory, 'editor')) continue;
        await memoryStore.deleteMemory(id);
        deleted++;
    }
    res.json({ success: true, deleted });
});

// Delete a memory
router.delete('/:id', validate({ query: NoQuery }), async (req, res) => {
    const userId = getEffectiveUserId(req);

    const memory = await memoryStore.getMemoryById(req.params.id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    if (!await canAccessMemory(userId, memory, 'editor')) {
        return res.status(403).json({ error: 'Access denied' });
    }

    await memoryStore.deleteMemory(req.params.id);
    res.json({ success: true });
});

// "Clear All". Two pools, two clears:
//   - no body: the caller's PERSONAL memory, everything outside a project;
//   - `{projectId}`: that project's shared pool, the rows GET /?projectId=
//     lists. A write to the pool like any other, so editor, the same check
//     POST / and canAccessMemory make.
// The project tab used to send no body too, and so cleared the member's
// personal memory while the project's stayed on screen. Any other narrowing
// (`{agentId}`) is refused: it used to be ignored on the way to clearing
// everything.
router.post('/clear', validate({ query: NoQuery, body: ClearBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { projectId } = req.body;

    if (projectId) {
        if (!await hasProjectRole(userId, projectId, 'editor')) {
            return res.status(403).json({ error: 'Editor role required for this project' });
        }
        await memoryStore.clearProjectMemories(projectId);
        return res.json({ success: true });
    }

    await memoryStore.clearAllMemories(userId);
    res.json({ success: true });
});

// Export memories as JSON
router.get('/export/all', validate({ query: NoQuery }), require('../compliance/dataPortability/stampExport')('memories'), async (req, res) => {
    const userId = getEffectiveUserId(req);

    const memories = await memoryStore.getMemories(userId, 1000);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=memories.json');
    res.json({ exportDate: new Date().toISOString(), userId, memories });
});

/** Case- and whitespace-insensitive identity of a memory's content. */
function contentKey(content) {
    return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Import memories from pasted text (e.g. an export from another AI provider).
// Uses the fast-tier LLM to extract a typed list of memories from free-form
// text, then inserts each one through the normal createMemory path — capped
// per paste, de-duped within the paste and against what already exists.
router.post('/import', importLimiter, validate({ body: ImportBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    // Trimmed and required non-blank by the schema.
    const { text } = req.body;

    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
        return res.status(400).json({ error: `text exceeds ${MAX_IMPORT_BYTES} byte limit` });
    }

    const userOrgId = req.user?.organizationId || null;
        const modelId = await resolveModelForTier('tier:fast', { userOrgId, userId, fallbackTier: 'fast' });
        const tierConfig = await getTierConfig('fast', { userOrgId, userId });

        const systemPrompt = `You extract structured memories from free-form text exported from an AI assistant.

Return ONLY a JSON object of the form {"memories": [{"type": "...", "content": "..."}]}.

"type" must be exactly one of: instruction, person, project, preference, workflow, fact, context.
- instruction: standing instructions (always/never do X)
- person: people the user knows or works with
- project: projects, tech stacks, URLs
- preference: settings, formatting, tone preferences
- workflow: how the user likes to work
- fact: specific facts about the user or their work
- context: general background context
If unsure, use "fact".

"content" must be a single concise sentence in the user's voice, preserving their wording where possible. One memory per distinct fact — do not bundle multiple facts into one entry. Skip filler text, greetings, and meta-commentary. If nothing useful can be extracted, return {"memories": []}.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Extract memories from this text:\n\n${text}` },
        ];

        const result = await llmClient.chat(modelId, messages, {
            temperature: tierConfig?.temperature ?? 0.2,
            maxTokens: Math.min(tierConfig?.maxTokens ?? 2000, 4000),
            budgetTokens: 0,
            reasoningEffort: 'none',
        });

        const parsed = extractJSON(result?.content || '');
        const items = Array.isArray(parsed?.memories) ? parsed.memories : [];

        let imported = 0;
        let skipped = 0;
        const inserted = [];
        const seen = new Set();
        for (const item of items) {
            // The cap is on INSERTS. Past it the remainder is counted, not
            // silently dropped, so the caller can see the paste was too big.
            if (imported >= MAX_IMPORT_ITEMS) { skipped++; continue; }

            // An unknown type lands in `fact` rather than failing the whole paste.
            const type = VALID_TYPES.has(item?.type) ? item.type : 'fact';
            const content = typeof item?.content === 'string' ? item.content.trim() : '';
            if (!content || content.length > MAX_CONTENT_CHARS) { skipped++; continue; }

            // Within one paste: case and whitespace do not make a new memory.
            const key = contentKey(content);
            if (seen.has(key)) { skipped++; continue; }
            seen.add(key);

            try {
                // Against what already exists: re-pasting the same export used to
                // double the memory count. createMemory's canonical dedupe needs
                // subject/attribute, which an import never has, so the similarity
                // check has to happen here — and a hit confirms the existing row.
                const existing = await memoryStore.findSimilarMemory(userId, content);
                if (existing) {
                    await memoryStore.confirmMemory(existing.id);
                    skipped++;
                    continue;
                }
                await memoryStore.createMemory(userId, null, type, content);
                imported++;
                inserted.push({ type, content });
            } catch (e) {
                skipped++;
                log.warn('[memory/import] insert failed:', e.message);
            }
        }

        res.json({ imported, skipped, items: inserted });
});

module.exports = router;

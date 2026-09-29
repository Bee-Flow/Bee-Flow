/**
 * Configuration surface for the AI auto-responder: the configStore keys
 * (agent id, KB ids, v2 flag, auto-resolve threshold), the Bee Flow Support
 * singleton agent itself, and the non-streaming preview the configuration UI
 * uses to dry-run a reply.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `ConfigBody` is `.strict()`, and `v2Enabled` needed it: the route stored
 * `!!v2Enabled`, so the STRING 'false' switched the tool-using responder ON
 * while the caller was switching it off — 200, `{ ok: true }`, and the live
 * auto-responder changed behaviour. A misspelled key (`kbids`) was dropped
 * just as quietly under the same `{ ok: true }`.
 *
 * `config` on PUT /agent stays deliberately open and is still MERGED over
 * what is stored: a sub-flag a later release adds must survive a save made by
 * an older client. The keys around it are pinned, so a body can still not
 * re-target the singleton at another owner or org.
 */

const configStore = require('../../stores/configStore');
const { isSuperAdmin } = require('../../auth');

const { getUserId, requireStaffSupport } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

const SUPPORT_AGENT_ID = 'system-bee-flow-support';

/** The super-admin gate as middleware, so a schema never answers ahead of the 403. */
function requireSuperAdmin(req, res, next) {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super-admin required' });
    return next();
}

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const idList = (name) => z.array(worded(`${name} is a list of ids.`), {
    required_error: `${name} is a list of ids.`, invalid_type_error: `${name} is a list of ids.`,
});

const ConfigBody = bodyOf({
    agentId: worded('agentId must be an agent id.').trim().max(200, 'agentId is at most 200 characters.').nullish(),
    kbIds: idList('kbIds').optional(),
    // Only a real false switches the tool-using responder off.
    v2Enabled: z.boolean({ invalid_type_error: 'v2Enabled is true or false.' }).optional(),
    autoResolveThreshold: z.coerce.number({ invalid_type_error: 'autoResolveThreshold is a number between 0 and 1.' })
        .min(0, 'autoResolveThreshold is a number between 0 and 1.')
        .max(1, 'autoResolveThreshold is a number between 0 and 1.')
        .optional(),
});

const AgentBody = bodyOf({
    name: worded('name must be text.').trim().max(200, 'name is at most 200 characters.').optional(),
    description: worded('description must be text.').nullish(),
    systemPrompt: worded('systemPrompt must be text.').nullish(),
    model: worded('model must be a model id or tier.').trim().max(200, 'model is at most 200 characters.').nullish(),
    starterPrompts: z.array(z.string(), { invalid_type_error: 'starterPrompts is a list of prompts.' }).optional(),
    knowledgeBaseIds: idList('knowledgeBaseIds').optional(),
    // Merged over the stored config — a sub-flag a later release adds must
    // survive a save made by an older client, so this one stays open.
    config: z.record(z.unknown(), { invalid_type_error: 'config is a JSON object.' }).optional(),
});

const MESSAGE_TEXT = 'A preview needs a message.';
const PreviewBody = bodyOf({
    message: worded(MESSAGE_TEXT).trim().min(1, MESSAGE_TEXT).max(5000, 'A preview message is at most 5000 characters.'),
});

function register(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // GET /config — staff: read AI agent + KB ids
    // PUT /config — super-admin: update them
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/config', requireStaffSupport, async (req, res) => {
        const agentId = await configStore.getConfig('support_ai_agent_id');
        const kbRaw = await configStore.getConfig('support_ai_kb_ids');
        let kbIds = [];
        if (kbRaw) {
            try { kbIds = Array.isArray(kbRaw) ? kbRaw : JSON.parse(kbRaw); } catch { kbIds = []; }
        }
        const v2Enabled = !!(await configStore.getConfig('support_ai_v2_enabled'));
        const autoResolveThreshold = Number(await configStore.getConfig('support_ai_autoresolve_threshold')) || 0.78;
        res.json({ agentId: agentId || null, kbIds, v2Enabled, autoResolveThreshold });
    });

    router.put('/config', requireSuperAdmin, validate({ body: ConfigBody }), async (req, res) => {
        const { agentId, kbIds, v2Enabled, autoResolveThreshold } = req.body;
        if (agentId !== undefined) {
            await configStore.setConfig('support_ai_agent_id', agentId || '');
        }
        if (kbIds !== undefined) {
            await configStore.setConfig('support_ai_kb_ids', JSON.stringify(kbIds));
        }
        if (v2Enabled !== undefined) {
            await configStore.setConfig('support_ai_v2_enabled', v2Enabled);
        }
        if (autoResolveThreshold !== undefined) {
            await configStore.setConfig('support_ai_autoresolve_threshold', autoResolveThreshold);
        }
        res.json({ ok: true });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /agent  — fetch the Bee Flow Support singleton agent
    // PUT /agent  — update the singleton (system prompt, model tier, KB ids,
    //               starter prompts). Proxies to agentStore, bypassing the
    //               owner_id check that PUT /agents/:id imposes for user-owned
    //               agents (this agent has owner_id='system').
    // POST /preview — non-streaming dry-run AI reply for the configuration UI.
    //                 Calls chatWithAgent against the singleton without touching
    //                 support_threads / support_messages / email.
    // ──────────────────────────────────────────────────────────────────────────

    router.get('/agent', requireStaffSupport, async (req, res) => {
        const agentStore = require('../../stores/agentStore');
        const agent = await agentStore.getAgent(SUPPORT_AGENT_ID);
        if (!agent) {
            return res.status(404).json({
                error: 'Support agent not seeded yet. Restart the server to seed it.',
            });
        }
        res.json({ agent });
    });

    router.put('/agent', requireSuperAdmin, validate({ body: AgentBody }), async (req, res) => {
        const agentStore = require('../../stores/agentStore');
        const existing = await agentStore.getAgent(SUPPORT_AGENT_ID);
        if (!existing) {
            return res.status(404).json({ error: 'Support agent not seeded yet.' });
        }

        const body = req.body;
        // Whitelisted fields — block anything that would let an admin
        // re-target the singleton at a different owner or org.
        const name = body.name ?? existing.name;
        const description = body.description ?? existing.description;
        const systemPrompt = body.systemPrompt ?? existing.system_prompt;
        const model = body.model ?? existing.model;
        const starterPrompts = Array.isArray(body.starterPrompts)
            ? body.starterPrompts
            : (() => {
                try { return JSON.parse(existing.starter_prompts || '[]'); } catch { return []; }
            })();

        // Merge config — preserve unknown keys so an upgrade that adds a new
        // sub-flag doesn't get silently wiped on save.
        const existingConfig = existing.config && typeof existing.config === 'object' ? existing.config : {};
        const inboundConfig = body.config && typeof body.config === 'object' ? body.config : {};
        const config = { ...existingConfig, ...inboundConfig };
        if (Array.isArray(body.knowledgeBaseIds)) {
            config.knowledge_base_ids = body.knowledgeBaseIds;
        }

        // No expectedRev → last-write-wins (the support singleton has no
        // concurrent editor). updateAgent now returns a discriminated result.
        const { ok } = await agentStore.updateAgent(
            SUPPORT_AGENT_ID,
            name,
            description,
            systemPrompt,
            'system',                // ownerId — singleton is system-owned
            model,
            starterPrompts,
            existing.avatar || null, // avatar
            !!existing.threads_enabled,
            !!existing.copy_enabled,
            !!existing.workspace_enabled,
            config,
            !!existing.embed_enabled,
            null,                    // organizationId — singleton, no tenant
            [],                      // sharedGroups — never published
            null                     // categoryId
        );
        if (!ok) {
            return res.status(500).json({ error: 'Update failed (agent not owned by system?)' });
        }
        // Mirror knowledge_base_ids into the legacy configStore key so the
        // existing supportAiResponder fallback path keeps working without a
        // code change.
        if (Array.isArray(body.knowledgeBaseIds)) {
            try {
                await configStore.setConfig('support_ai_kb_ids', JSON.stringify(body.knowledgeBaseIds));
            } catch {}
        }
        const updated = await agentStore.getAgent(SUPPORT_AGENT_ID);
        res.json({ ok: true, agent: updated });
    });

    router.post('/preview', requireStaffSupport, validate({ body: PreviewBody }), async (req, res) => {
        const { message } = req.body;

        const { chatWithAgent } = require('../../core/agentRuntime');
        const { quickKBSearch } = require('../../core/agentRuntime/knowledgeSearch');
        const agentStore = require('../../stores/agentStore');
        const agent = await agentStore.getAgent(SUPPORT_AGENT_ID);
        if (!agent) return res.status(404).json({ error: 'Support agent not seeded' });

        // Use the configured KB ids (same source the real responder reads).
        const kbIds = Array.isArray(agent?.config?.knowledge_base_ids)
            ? agent.config.knowledge_base_ids
            : [];

        // Synthetic preview user — never collides with a real session id.
        const previewUserId = `support-ai-preview:${getUserId(req) || 'anon'}`;

        let kbHits = [];
        try {
            kbHits = await quickKBSearch(previewUserId, kbIds, message, { topK: 4 });
        } catch (e) {
            log.warn('[Support] preview KB search failed:', e.message);
        }

        const kbContext = kbHits.length
            ? `\n\n[Reference material — only cite if directly relevant:]\n${kbHits.map((h, i) => `(${i + 1}) ${h.title}\n${h.content}`).join('\n\n')}`
            : '';
        const userMessage = `Preview mode — test customer message.\n\nSubject: (preview)\n\nCustomer: ${message}${kbContext}\n\nReply only to the customer's most recent message. If the knowledge base does not contain a confident answer or this requires account-specific actions, respond briefly and end your reply with [ESCALATE: <reason>].`;

        let result;
        result = await chatWithAgent(SUPPORT_AGENT_ID, previewUserId, userMessage, {});

        const raw = (result && (result.content || result.response || result.message)) || '';
        const escMatch = raw.match(/\[ESCALATE(?::\s*([^\]]+))?\]/i);
        const escalated = !!escMatch || (kbHits.length === 0 && raw.trim().length < 60);
        const cleaned = raw.replace(/\[ESCALATE(?::\s*[^\]]+)?\]/i, '').trim();

        res.json({
            content: cleaned || '(empty reply)',
            model: (result && result.model) || null,
            modelTier: agent.model || null,
            citations: kbHits.map(h => ({ title: h.title, source_uri: h.source_uri, score: h.score })),
            escalated,
            escalateReason: escMatch?.[1]?.trim() || (escalated ? 'no_kb_grounding' : null),
        });
    });
}

module.exports = { register };

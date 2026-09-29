/**
 * Direct Chat — conversation management: conversation CRUD, chat-local
 * session skills, conversation labels, and the per-conversation notebook
 * workspace.
 *
 * Moved verbatim out of routes/ai/directChat.js when the router was split.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const configStore = require('../../../stores/configStore');
const agentStore = require('../../../stores/agentStore');
const { getProviderForModel } = require('../../../core/aiAgent');
const { getAdapter } = require('../../../core/providers');
const { bootstrapSessionSkills } = require('../../../core/tools/sessionSkillRuntime');
const { requireAuth } = require('../../../auth/permissions');
const { usableKbIdsForRequest } = require('../../../support/kbAccess');
const { MAX_ATTACHED_KB_IDS } = require('../../../core/kb/kbSelection');
const { encryptionOpts } = require('./shared');
const { z } = require('zod');
const { validate } = require('../../../core/http/validate');

// ── What a caller may send ────────────────────────────────────────────────
// Every schema is `.strict()`: a key the router does not read is a client
// bug, and answering 200 to it means the user watches a setting they typed
// fail to stick with nothing on screen to explain it.

/** An id a caller supplies, in a list. Blank entries are a client bug, not a gap. */
const ID = (message) => z.string({ invalid_type_error: message }).trim().min(1, message);

const KB_IDS_TEXT = 'Each knowledge base id must be a non-empty string.';
const ConversationPatch = z.object({
    title: z.string({ invalid_type_error: 'A conversation title must be text.' }).optional(),
    pinned: z.boolean({ invalid_type_error: 'pinned is true or false.' }).optional(),
    labels: z.array(ID('Each label id must be a non-empty string.'),
        { invalid_type_error: 'labels must be a list of label ids.' }).optional(),
    knowledgeBaseIds: z.array(ID(KB_IDS_TEXT), { invalid_type_error: 'knowledgeBaseIds must be an array.' })
        .max(MAX_ATTACHED_KB_IDS, `At most ${MAX_ATTACHED_KB_IDS} knowledge bases`)
        // The route asks the access layer about each id, so the same id twice
        // is the same question twice.
        .transform((ids) => [...new Set(ids)])
        .optional(),
}).strict();

const RegenerateBody = z.object({
    message: z.string({ invalid_type_error: 'message must be text.' }).trim().optional(),
    // The prompt is written for a place, so an absent or blank zone is UTC
    // rather than a refusal — the caller did not claim a zone, it has none.
    timezone: z.string({ invalid_type_error: 'timezone must be text.' }).trim().optional()
        .transform((v) => v || 'UTC'),
}).strict();

const ImportSkillBody = z.object({
    name: z.string({ invalid_type_error: 'A skill name must be text.' }).trim().min(1).max(120).optional(),
    isShared: z.boolean({ invalid_type_error: 'isShared is true or false.' }).default(false),
    dynamicActivation: z.boolean({ invalid_type_error: 'dynamicActivation is true or false.' }).default(true),
}).strict();

const LABEL_NAME = 'A label needs a name.';
const LabelBody = z.object({
    name: z.string({ required_error: LABEL_NAME, invalid_type_error: LABEL_NAME }).trim().min(1, LABEL_NAME).max(120),
    color: z.string({ invalid_type_error: 'A label colour must be text.' }).trim().min(1).max(32).default('#6366f1'),
}).strict();

/** Every field optional: renaming a label must not have to resend its colour. */
const LabelPatch = LabelBody.partial();

const WorkspaceBody = z.object({
    // The store refuses a non-string with INVALID_WORKSPACE_CONTENT, which the
    // client swallowed as a 500; said here, the caller learns which field.
    content: z.string({ invalid_type_error: 'Workspace content must be a string' }).default(''),
    notebookId: z.string({ invalid_type_error: 'notebookId must be text.' }).trim().min(1).nullish()
        .transform((v) => v ?? null),
}).strict();

// ─── Conversation CRUD ───────────────────────────────────────────

router.get('/direct/conversations', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conversations = await agentStore.listDirectConversations(userId);
        res.json(conversations);
    } catch (e) {
        log.error('Failed to list direct conversations:', e);
        res.status(500).json({ error: 'Failed to list conversations' });
    }
});

router.get('/direct/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        // ── Attached knowledge bases: CHECKED AGAIN, ON EVERY READ ──────
        //
        // Being stored is not a permission. A base can be unpublished, pulled
        // out of a group, switched off for chat or deleted after it was
        // attached — and on a shared thread the READER is not necessarily the
        // owner who attached it. So the same check the turn runs
        // (kbVisibility + usage_contexts) runs here, and the client is handed
        // only what survives it.
        //
        // The raw column is stripped rather than shipped alongside: leaving
        // both on the payload would put an unfiltered list one property away
        // from the honest one, and something would eventually read the wrong
        // one. `knowledgeBaseIds` is the whole answer.
        const payload = { ...conv };
        delete payload.knowledge_base_ids;
        payload.knowledgeBaseIds = await usableKbIdsForRequest(req, conv.knowledgeBaseIds);
        res.json(payload);
    } catch (e) {
        log.error('Failed to get direct conversation:', e);
        res.status(500).json({ error: 'Failed to get conversation' });
    }
});

router.get('/direct/conversations/:id/session-skills', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        const skills = Array.isArray(conv.sessionSkills) ? conv.sessionSkills : [];
        const activated = Array.isArray(conv.activatedSessionSkillIds) ? conv.activatedSessionSkillIds : [];
        res.json({
            skills,
            activatedSkillIds: activated,
            modelTier: conv.model_tier || 'fast',
        });
    } catch (e) {
        log.error('Failed to get direct session skills:', e);
        res.status(500).json({ error: 'Failed to load session skills' });
    }
});

// Regenerate the chat-local session-skill set for a Standard-tier conversation.
// Body: { message? }   — optional refining prompt. If absent, re-uses the
//                          first user message from the conversation.
// Resets `activatedSessionSkillIds` since the new ids won't match the old ones.
router.post('/direct/conversations/:id/session-skills/regenerate', requireAuth, validate({ body: RegenerateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Resolve the tier the conversation uses; we only regenerate for Standard.
    const userStoreForOrg = require('../../../stores/userStore');
    const callerForOrg = await userStoreForOrg.getUser(userId);
    const callerOrgId = callerForOrg?.organizationId || null;
    const { isEUModeActive } = require('../../../core/llm/modelResolver');
    const { isEU } = await isEUModeActive({ userOrgId: callerOrgId, userId }).catch(() => ({ isEU: false }));
    const tiersKey = isEU ? 'chat_model_tiers_eu' : 'chat_model_tiers';
    const tiers = (await configStore.getConfig(tiersKey)) || {};
    const tier = tiers.standard || {};
    if (!tier.modelId) {
        return res.status(400).json({ error: 'Standard tier is not configured.' });
    }

    // Pick the bootstrap model (cheap if configured, otherwise main).
    let bootstrapModelId = tier.bootstrapModelId || tier.modelId;
    let bootstrapConfig;
    try {
        bootstrapConfig = await getProviderForModel(bootstrapModelId);
    } catch (_) {
        // Cheap model unavailable — fall back to the main tier model.
        bootstrapConfig = await getProviderForModel(tier.modelId);
        bootstrapModelId = tier.modelId;
    }
    const bootstrapAdapter = getAdapter(bootstrapConfig.providerType, (bootstrapConfig.url || '').replace(/\/+$/, ''));

    // Determine the seed message — body override > first user message > placeholder.
    const overrideMessage = req.body.message || null;
    const firstUserMsg = (Array.isArray(conv.messages) ? conv.messages : []).find(m => m.role === 'user')?.content;
    const seedMessage = overrideMessage || firstUserMsg || '[No prior user text — derive broadly useful skills.]';

    // Pull user/org context for tone/language tailoring.
    let userContext = null;
    try {
        const userStore = require('../../../stores/userStore');
        const u = await userStore.getUser(userId);
        if (u) {
            userContext = {
                language: u.language || u.locale || (req.session?.user?.language) || null,
                role: u.orgRole || u.role || null,
            };
            if (u.organizationId) {
                const org = await userStore.getOrganization(u.organizationId);
                if (org) {
                    userContext.orgName = org.name || null;
                    userContext.orgTagline = org.tagline || null;
                }
            }
        }
    } catch (_) { /* non-fatal */ }

    const newSkills = await bootstrapSessionSkills({
        adapter: bootstrapAdapter,
        apiKey: bootstrapConfig.apiKey,
        apiUrl: (bootstrapConfig.url || '').replace(/\/+$/, ''),
        modelId: bootstrapModelId,
        message: seedMessage,
        timezone: req.body.timezone,
        apiVersion: bootstrapConfig.apiVersion || undefined,
        userContext,
    });

    // Persist new skills + reset activations & completions. Preserve existing messages.
    const existingMessages = Array.isArray(conv.messages) ? conv.messages : [];
    await agentStore.updateDirectConversation(req.params.id, existingMessages, userId, {
        sessionSkills: newSkills,
        activatedSessionSkillIds: [],
        completedSessionSkillIds: [],
        sessionSkillsCompletions: [],
    }, encryptionOpts(req));

    res.json({ success: true, skills: newSkills, activatedSkillIds: [], completedSkillIds: [] });
});

// Delete one chat-local session skill from a conversation.
router.delete('/direct/conversations/:id/session-skills/:skillId', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const sessionSkills = Array.isArray(conv.sessionSkills) ? conv.sessionSkills : [];
        const skillId = req.params.skillId;
        const nextSkills = sessionSkills.filter(s => s.id !== skillId);
        if (nextSkills.length === sessionSkills.length) {
            return res.status(404).json({ error: 'Session skill not found' });
        }
        const nextActivated = (Array.isArray(conv.activatedSessionSkillIds) ? conv.activatedSessionSkillIds : []).filter(id => id !== skillId);
        const nextCompleted = (Array.isArray(conv.completedSessionSkillIds) ? conv.completedSessionSkillIds : []).filter(id => id !== skillId);
        const nextCompletions = (Array.isArray(conv.sessionSkillsCompletions) ? conv.sessionSkillsCompletions : []).filter(c => c?.skillId !== skillId);

        const existingMessages = Array.isArray(conv.messages) ? conv.messages : [];
        await agentStore.updateDirectConversation(req.params.id, existingMessages, userId, {
            sessionSkills: nextSkills,
            activatedSessionSkillIds: nextActivated,
            completedSessionSkillIds: nextCompleted,
            sessionSkillsCompletions: nextCompletions,
        }, encryptionOpts(req));

        res.json({ success: true, skills: nextSkills, activatedSkillIds: nextActivated, completedSkillIds: nextCompleted });
    } catch (e) {
        log.error('Failed to delete session skill:', e);
        res.status(500).json({ error: 'Failed to delete session skill' });
    }
});

router.post('/direct/conversations/:id/session-skills/:skillId/import', requireAuth, validate({ body: ImportSkillBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const sessionSkills = Array.isArray(conv.sessionSkills) ? conv.sessionSkills : [];
        const source = sessionSkills.find(s => s.id === req.params.skillId);
        if (!source) return res.status(404).json({ error: 'Session skill not found' });

        const userStore = require('../../../stores/userStore');
        const skillStore = require('../../../stores/skillStore');
        const user = await userStore.getUser(userId);
        const orgId = user?.organizationId || null;
        if (!orgId) return res.status(400).json({ error: 'No organization found' });

        const created = await skillStore.createSkill({
            orgId,
            userId,
            name: req.body.name || source.name,
            description: source.description || '',
            instructions: source.instructions || '',
            workflow: source.workflow || '',
            rules: source.rules || '',
            examples: source.examples || '',
            icon: '⚡',
            isShared: req.body.isShared,
            dynamicActivation: req.body.dynamicActivation,
        });

        res.json({ success: true, skill: created });
    } catch (e) {
        log.error('Failed to import direct session skill:', e);
        res.status(500).json({ error: 'Failed to import session skill' });
    }
});

// Rename / pin / label / attach knowledge bases to a direct conversation
router.patch('/direct/conversations/:id', requireAuth, validate({ body: ConversationPatch }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, pinned, labels, knowledgeBaseIds } = req.body;
        const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        // ── Attaching a knowledge base is a READ GRANT ──────────────────
        //
        // From here on the turn searches whatever is in this list, and the
        // ingest layer (core/localKBIngest) does no tenant filtering of its
        // own — the id list IS its access boundary. So an id the caller may
        // not use is a HARD 400 naming the offending ids, the same contract
        // the project linker enforces (routes/projects.js
        // validateKnowledgeBaseIds), never a silent drop: quietly saving four
        // of five bases leaves the picker showing a fifth the server refused.
        //
        // The check is `usableKbIdsForRequest`, i.e. the RETRIEVAL rule —
        // strictly narrower than the linker's read check, because "saved" has
        // to mean "will actually be used". An org admin's bypass and a base
        // its owner switched off for chat both fail here, and both would
        // otherwise be accepted and then silently ignored every turn.
        let nextKbIds = null;
        if (knowledgeBaseIds !== undefined) {
            const usable = await usableKbIdsForRequest(req, knowledgeBaseIds);
            const invalid = knowledgeBaseIds.filter(id => !usable.includes(id));
            if (invalid.length > 0) {
                return res.status(400).json({ error: 'One or more knowledge bases are not available', invalid });
            }
            nextKbIds = usable;
        }

        if (title !== undefined) await agentStore.updateDirectConversationTitle(req.params.id, title, userId);
        if (pinned !== undefined) await agentStore.pinDirectConversation(req.params.id, pinned, userId);
        if (labels !== undefined) await agentStore.setDirectConversationLabels(req.params.id, labels, userId);
        if (nextKbIds !== null) {
            // getDirectConversation admits any project VIEWER of a shared
            // thread, and the store write is owner-scoped. Answering
            // `{success:true}` on a write that matched no row would leave the
            // picker showing a selection the database never took — so say so.
            const written = await agentStore.setDirectConversationKnowledgeBases(req.params.id, nextKbIds, userId);
            if (!written) {
                return res.status(403).json({ error: 'Only the owner can change the attached knowledge bases' });
            }
            return res.json({ success: true, knowledgeBaseIds: nextKbIds });
        }
        res.json({ success: true });
    } catch (e) {
        // A schema that has not migrated yet is not "you are not the owner".
        if (e?.code === 'KB_COLUMN_MISSING') {
            return res.status(503).json({ error: 'Knowledge bases cannot be attached until the database has migrated' });
        }
        log.error('Failed to update direct conversation:', e);
        res.status(500).json({ error: 'Failed to update conversation' });
    }
});

// ─── Conversation Label CRUD ───
router.get('/labels', requireAuth, async (req, res) => {
    try {
        const labels = await agentStore.listLabels(req.session.user.id);
        res.json(labels);
    } catch (e) {
        log.error('Failed to list labels:', e);
        res.status(500).json({ error: 'Failed to list labels' });
    }
});

router.post('/labels', requireAuth, validate({ body: LabelBody }), async (req, res) => {
    try {
        const { name, color } = req.body;
        const label = await agentStore.createLabel(req.session.user.id, name, color);
        res.json(label);
    } catch (e) {
        log.error('Failed to create label:', e);
        res.status(500).json({ error: 'Failed to create label' });
    }
});

router.patch('/labels/:id', requireAuth, validate({ body: LabelPatch }), async (req, res) => {
    try {
        const { name, color } = req.body;
        await agentStore.updateLabel(req.params.id, req.session.user.id, { name, color });
        res.json({ success: true });
    } catch (e) {
        log.error('Failed to update label:', e);
        res.status(500).json({ error: 'Failed to update label' });
    }
});

router.delete('/labels/:id', requireAuth, async (req, res) => {
    try {
        await agentStore.deleteLabel(req.params.id, req.session.user.id);
        res.json({ success: true });
    } catch (e) {
        log.error('Failed to delete label:', e);
        res.status(500).json({ error: 'Failed to delete label' });
    }
});

router.delete('/direct/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const success = await agentStore.deleteDirectConversation(req.params.id, userId);
        if (!success) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ success: true });
    } catch (e) {
        log.error('Failed to delete direct conversation:', e);
        res.status(500).json({ error: 'Failed to delete conversation' });
    }
});

// Get workspace content for a direct conversation
router.get('/direct/conversations/:id/workspace', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        // Render-time un-tokenisation. The stored workspace_content keeps the
        // raw `[person_N]` tokens so the AI can re-read them via notebook_read
        // in a later turn; this endpoint reaches the user, so swap them back
        // to real values. Async getter so an open-after-server-restart hits the
        // DB hydrate path in dlpRunner.
        const { restoreTokens } = require('../../../core/privacy/piiDetection');
        const _convMap = await require('../../../core/dlp/dlpRunner').getConversationTokenMapAsync(req.params.id);
        const { resolveWorkspaceContent } = require('../../../integrations/workspaceTools');
        const content = await resolveWorkspaceContent({
            notebookId: conv.workspace_notebook_id,
            userId,
            fallbackContent: conv.workspace_content,
        });
        res.json({
            content: restoreTokens(content, _convMap),
            notebookId: conv.workspace_notebook_id || null,
        });
    } catch (e) {
        log.error('Failed to get direct conversation workspace:', e);
        res.status(500).json({ error: 'Failed to get workspace' });
    }
});

// Update workspace content for a direct conversation
router.put('/direct/conversations/:id/workspace', requireAuth, validate({ body: WorkspaceBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId, encryptionOpts(req));
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        const { content, notebookId } = req.body;
        // userId is REQUIRED by the store — the workspace is owner-only and there
        // is no unscoped form. Omitting it threw CALLER_USER_ID_REQUIRED straight
        // into the catch below, which answered 500; the client swallows that, so
        // every direct-chat notebook save silently lost its content.
        await agentStore.updateDirectConversationWorkspace(req.params.id, content, notebookId, userId);
        res.json({ success: true });
    } catch (e) {
        if (e?.code === 'INVALID_WORKSPACE_CONTENT') return res.status(400).json({ error: 'Workspace content must be a string' });
        if (e?.code === 'WORKSPACE_CONTENT_TOO_LARGE') return res.status(413).json({ error: 'Workspace content is too large' });
        log.error('Failed to update direct conversation workspace:', e);
        res.status(500).json({ error: 'Failed to update workspace' });
    }
});

module.exports = router;

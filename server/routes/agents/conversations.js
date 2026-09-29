const express = require('express');
const agentStore = require('../../stores/agentStore');
require('../../core/agentRuntime');
require('../../core/aiAgent');
require('../../stores/configStore');
require('../../auth');
require('../../stores/memoryStore');
require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

require('../../stores/userStore');
require('../../stores/usageStore');
require('../../core/entitlements/limits');
require('../../core/http/sseHelpers');

const router = express.Router();

// Defensive limits applied at the route boundary. These are intentionally
// generous — they exist to stop runaway clients and prevent very large blobs
// from reaching the encrypted store, not to enforce product policy.
const MAX_TITLE_LEN = 500;
const MAX_LABEL_LEN = 64;
const MAX_LABELS = 50;
const MAX_THREAD_TITLES = 200;
const MAX_THREAD_TITLE_LEN = 500;
const MAX_WORKSPACE_BYTES = 10 * 1024 * 1024; // 10 MB

// ── What a caller may send ──────────────────────────────────────────
//
// Every schema is `.strict()`: a key this router does not read is a client
// bug, and answering 200 to it means the person watches a setting they typed
// fail to stick with nothing on screen to explain it.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const TITLE_TEXT = 'A conversation title must be text.';
const Title = worded(TITLE_TEXT).max(MAX_TITLE_LEN, `A conversation title is at most ${MAX_TITLE_LEN} characters.`);

const LABEL_TEXT = 'Each label must be text.';
const Labels = z.array(
    worded(LABEL_TEXT).max(MAX_LABEL_LEN, `A label is at most ${MAX_LABEL_LEN} characters.`),
    { invalid_type_error: 'labels is a list of labels.' },
).max(MAX_LABELS, `At most ${MAX_LABELS} labels on one conversation.`);

const NewConversationBody = z.object({
    title: Title.optional(),
}).strict();

const ConversationPatch = z.object({
    title: Title.optional(),
    // A boolean, like the direct-chat conversation routes. The check this
    // replaced also let a number through, which the store then coerced —
    // so `pinned: 0` unpinned and `pinned: 2` pinned, by accident.
    pinned: z.boolean({ invalid_type_error: 'pinned is true or false.' }).optional(),
    labels: Labels.optional(),
}).strict();

const THREAD_TITLES_TEXT = 'threadTitles maps a thread id to its title.';
const ThreadTitlesBody = z.object({
    threadTitles: z.record(
        worded('A thread title must be text.').max(MAX_THREAD_TITLE_LEN, `A thread title is at most ${MAX_THREAD_TITLE_LEN} characters.`),
        { required_error: THREAD_TITLES_TEXT, invalid_type_error: THREAD_TITLES_TEXT },
    ).refine((m) => Object.keys(m).length <= MAX_THREAD_TITLES,
        `At most ${MAX_THREAD_TITLES} thread titles on one conversation.`),
}).strict();

const WorkspaceBody = z.object({
    content: worded('Workspace content must be text.').nullish(),
    notebookId: worded('notebookId must be text.').trim().min(1, 'notebookId must be text.').nullish(),
}).strict();

// Reuse the agent visibility gate so list/create endpoints can't be used to
// touch agents the caller has no audience for. Without this, an org-B user
// who knows an org-A agent ID could create orphan conversation rows even
// though the chat-stream endpoint correctly blocks them from sending.
const { canReadAgent } = require('./crud');

async function requireAgentReadAccess(req, res, agent) {
    const userId = getEffectiveUserId(req);
    if (!agent.is_published && !req.session?.user?.id) {
        res.status(401).json({ error: 'Not authenticated' });
        return false;
    }
    if (!(await canReadAgent(agent, userId, req))) {
        res.status(403).json({ error: 'Access denied' });
        return false;
    }
    return true;
}

// ============ Multi-Conversation Management ============

// List all conversations for an agent
router.get('/:id/conversations', async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await requireAgentReadAccess(req, res, agent))) return;

    const conversations = await agentStore.listConversations(req.params.id, getEffectiveUserId(req));
    res.json(conversations);
});

// Create a new conversation
router.post('/:id/conversations', validate({ body: NewConversationBody }), async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await requireAgentReadAccess(req, res, agent))) return;

    const { title } = req.body;
    const conversation = await agentStore.createConversation(req.params.id, getEffectiveUserId(req), title || 'New Chat');
    res.json(conversation);
});

// Get a specific conversation
router.get('/:id/conversations/:convId', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(conversation);
});

// Update conversation title / pin / labels
router.patch('/:id/conversations/:convId', validate({ body: ConversationPatch }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);

    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    const { title, pinned, labels } = req.body;
    if (title !== undefined) await agentStore.updateConversationTitle(req.params.convId, title);
    if (pinned !== undefined) await agentStore.pinConversation(req.params.convId, pinned);
    if (labels !== undefined) await agentStore.setConversationLabels(req.params.convId, labels);
    res.json({ success: true });
});

// Delete a conversation
router.delete('/:id/conversations/:convId', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);

    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    await agentStore.deleteConversationById(req.params.convId);
    res.json({ success: true });
});

// Update thread titles for a conversation
router.patch('/:id/conversations/:convId/thread-titles', validate({ body: ThreadTitlesBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    await agentStore.updateThreadTitles(req.params.convId, req.body.threadTitles);
    res.json({ success: true });
});

// Get workspace content for a conversation
router.get('/:id/conversations/:convId/workspace', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    // Render-time un-tokenisation — stored content keeps raw tokens so the
    // AI can re-read them via notebook_read; the user-facing API restores
    // them to real values. Mirror of directChat.js workspace GET.
    const { restoreTokens } = require('../../core/privacy/piiDetection');
    const _convMap = await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(req.params.convId);
    const { resolveWorkspaceContent } = require('../../integrations/workspaceTools');
    const content = await resolveWorkspaceContent({
        notebookId: conversation.workspace_notebook_id,
        userId,
        fallbackContent: conversation.workspace_content,
    });
    res.json({
        content: restoreTokens(content, _convMap),
        notebookId: conversation.workspace_notebook_id || null,
    });
});

// Update workspace content for a conversation
router.put('/:id/conversations/:convId/workspace', validate({ body: WorkspaceBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversationById(req.params.convId, req.session?.encryptionKey);
    if (!conversation || conversation.user_id !== userId) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    const { content, notebookId } = req.body;
    // Size, not shape: too large is a 413, which `validate` cannot answer.
    if (typeof content === 'string' && content.length > MAX_WORKSPACE_BYTES) {
        return res.status(413).json({ error: `content exceeds ${MAX_WORKSPACE_BYTES} bytes` });
    }
    await agentStore.updateConversationWorkspace(req.params.convId, content || '', notebookId !== undefined ? notebookId : null);
    res.json({ success: true });
});


module.exports = router;

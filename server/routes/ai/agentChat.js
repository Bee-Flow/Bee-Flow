/**
 * Agent Chat Routes
 *
 * Handles: agent chat, streaming, history, tools, component creation
 *
 * Every route here carries inline requireAuth: this playground backs the
 * signed-in Component Studio only. The guest chat surface — with its own
 * deliberately open component catalog — lives under /agents
 * (routes/agents/meta.js), not here.
 *
 * The two chat routes ALSO carry requireCapability('component_designer'), the
 * same gate as /create-component below and the whole /components mount in
 * index.js. They were requireAuth only, but the agent behind them is the
 * Component Designer, whose system tools include `update_component` (writes
 * any file of an existing component, index.js included) and
 * `execute_component` (spawns it with the server's env). So any signed-in
 * user could have code written into a component and run, around the gate
 * that /create-component was given for exactly that reason. The only client,
 * the AI designer in the Component Studio, already renders behind
 * <RequireTier feature="component_designer">.
 *
 * What stays open, and why: `component` in POST /create-component is
 * validated field by field but NOT refused for extra keys. Its author is the
 * model — the studio posts the JSON block the designer wrote, verbatim — so a
 * stray `version` in that block is model variance, not a caller's typo, and
 * refusing it would fail the happy path of "Create". The route writes only
 * the fields it names; the ones it reads are typed, so `agentEnabled: "false"`
 * can no longer be read as true.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const log = require('../../telemetry/log');
const router = express.Router();
const {
    getOrCreateAgent,
    clearConversation,
} = require('../../core/cms/componentDesignerAgent');
const { getAvailableComponents } = require('../../core/agentRuntime');
const componentManager = require('../../core/cms/componentManager');
const { requireAuth } = require('../../auth');
const { requireCapability } = require('../../core/entitlements/entitlements');
const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
// The caller's primary org, for the quota check. Its own copy of "first of the
// org union" used to live here; auth/orgScope.js is the one read now.
const { resolvePrimaryOrgId } = require('../../auth');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const COMPONENTS_DIR = path.resolve(__dirname, '../../../components');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
/** An absent body is an empty one, so the missing field gets its sentence rather than "Required". */
const bodyOf = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);

// ── What a caller may send ────────────────────────────────────────────────

const MESSAGE_TEXT = 'Message is required';
const ChatBody = bodyOf(z.object({
    message: worded(MESSAGE_TEXT).trim().min(1, MESSAGE_TEXT),
    // Component ids the designer may call this turn. The agent treats null as
    // "keep the previous turn's selection", so null stays null.
    tools: z.array(worded('Each tool is a component id.'),
        { invalid_type_error: 'tools is a list of component ids.' }).nullish(),
    // The two keys the agent reads: the component being edited, and a
    // replacement system prompt. Anything else was read by nothing.
    context: z.object({
        componentId: worded('context.componentId is the id of the component being edited.').optional(),
        systemPrompt: worded('context.systemPrompt must be text.').optional(),
    }, { invalid_type_error: 'context is an object.' }).strict().nullish(),
}).strict());

const INVALID_COMPONENT = 'Invalid component data';

// The studio posts the designer model's JSON block as-is, and a model writes
// `[]` for "none" about as often as `{}`. Refusing that failed an ordinary
// Create with a 400; an EMPTY list means the same as an empty object. A list
// with entries is still refused: it cannot say which version or which input
// name it means.
const emptyListIsNone = (schema) => z.preprocess((v) => (Array.isArray(v) && v.length === 0 ? {} : v), schema);

const ComponentBody = bodyOf(z.object({
    component: z.object({
        id: worded(INVALID_COMPONENT)
            .regex(/^[a-z0-9-]+$/, 'Component ID must be lowercase letters, numbers, and hyphens only'),
        name: worded(INVALID_COMPONENT).min(1, INVALID_COMPONENT),
        // It becomes index.js. An object here used to be JSON.stringify'd into
        // that file: a component that could never run, "created successfully".
        code: z.string({ required_error: INVALID_COMPONENT, invalid_type_error: 'Component code must be text — it becomes index.js.' })
            .min(1, INVALID_COMPONENT),
        description: worded('A component description must be text.').optional(),
        category: worded('A component category must be text.').optional(),
        inputs: emptyListIsNone(z.record(z.unknown(), { invalid_type_error: 'Component inputs are an object keyed by input name.' })).optional(),
        outputs: emptyListIsNone(z.record(z.unknown(), { invalid_type_error: 'Component outputs are an object keyed by output name.' })).optional(),
        dependencies: emptyListIsNone(z.record(worded('Each dependency is a version range, as in package.json.'),
            { invalid_type_error: 'Component dependencies are an object of package names to versions.' })).optional(),
        // Typed, because the fallback is OPEN: `agentEnabled !== false` read
        // the string "false" as true, and every agent in every org could call
        // the component.
        agentEnabled: z.boolean({ invalid_type_error: 'agentEnabled is true or false.' }).optional(),
        directChatEnabled: z.boolean({ invalid_type_error: 'directChatEnabled is true or false.' }).optional(),
    }, { required_error: INVALID_COMPONENT, invalid_type_error: INVALID_COMPONENT }),
}).strict());

// Chat with AI agent (standard JSON response)
router.post('/chat', requireAuth, requireCapability('component_designer'), validate({ body: ChatBody }), async (req, res) => {
    const sessionId = req.sessionID || 'default';
    const { message, tools, context } = req.body;

    const userId = req.session.user.id;
    const limitOrgId = await resolvePrimaryOrgId(req);
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    if (limitError) return res.status(402).json({ error: limitError });

    const agent = getOrCreateAgent(sessionId);
    const response = await agent.chat(message, tools, context);

    res.json(response);
});

// Chat with AI agent — SSE streaming with real-time progress
router.post('/chat-stream', requireAuth, requireCapability('component_designer'), validate({ body: ChatBody }), async (req, res) => {
    const sessionId = req.sessionID || 'default';
    const { message, tools, context } = req.body;

    const userId = req.session.user.id;
    const limitOrgId = await resolvePrimaryOrgId(req);
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    if (limitError) return res.status(402).json({ error: limitError });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const agent = getOrCreateAgent(sessionId);
        const response = await agent.chat(message, tools, context, (progress) => {
            send('progress', progress);
        });

        send('done', response);
    } catch (error) {
        log.error('AI chat-stream error:', error);
        send('error', { error: error.message });
    } finally {
        res.end();
    }
});

// Clear AI conversation
router.post('/clear', requireAuth, (req, res) => {
    const sessionId = req.sessionID || 'default';
    clearConversation(sessionId);
    res.json({ success: true });
});

// Get conversation history. requireAuth also keeps anonymous probes from
// allocating per-session agent instances via getOrCreateAgent.
router.get('/history', requireAuth, (req, res) => {
    const sessionId = req.sessionID || 'default';
    const agent = getOrCreateAgent(sessionId);
    res.json({ history: agent.getHistory(), toolCalls: agent.getToolCalls() });
});

// Get available tools/components for research
router.get('/tools', requireAuth, async (req, res) => {
    const components = await getAvailableComponents();
    const researchTools = components.filter(c => {
        const name = (c.name || '').toLowerCase();
        const desc = (c.description || '').toLowerCase();
        const category = (c.category || '').toLowerCase();
        return name.includes('search') ||
            name.includes('fetch') ||
            name.includes('api') ||
            name.includes('http') ||
            desc.includes('search') ||
            desc.includes('fetch') ||
            category.includes('api') ||
            category.includes('search');
    });
    res.json({ tools: components, researchTools });
});

// Create component from AI-generated data. Persists caller-supplied
// executable code into COMPONENTS_DIR and registers it with the runtime, so
// the gate must run before anything below does.
//
// That comment described an intent the code did not implement. `/components`
// (index.js) is wrapped in requireCapability('component_designer'), but this
// route is mounted under /ai and carried only requireAuth — so the enterprise
// gate on writing executable component code was reachable around, by any
// authenticated user. componentManager runs `npm install` in the component's
// directory and executionEngine spawns index.js with the server's env, so the
// capability is the boundary, not a paywall.
//
// ORDER MATTERS: requireCapability opens with
// `if (!req.session?.isAuthenticated) return next()` — it defers anonymous
// callers to "the auth middleware". requireAuth must therefore stay in front
// of it. This is the same pair routes/components.js had to be given. The
// schema runs after both, so only an entitled caller learns what it refuses.
router.post('/create-component', requireAuth, requireCapability('component_designer'), validate({ body: ComponentBody }), async (req, res) => {
    const { component } = req.body;

    const componentDir = path.join(COMPONENTS_DIR, component.id);

    if (fs.existsSync(componentDir)) {
        return res.status(400).json({ error: 'Component with this ID already exists' });
    }

    await fs.promises.mkdir(componentDir, { recursive: true });

    const componentJson = {
        name: component.name,
        description: component.description || '',
        category: component.category || 'Custom',
        inputs: component.inputs || {},
        outputs: component.outputs || {},
        // Written EXPLICITLY. This key used to be omitted entirely, and
        // the agent-tool filters read `agentEnabled !== false` — so a
        // component the model had just authored was silently callable by
        // every agent in every org, because nobody had said otherwise.
        // Those filters now fail closed (core/agentRuntime/agentTools.js),
        // which makes an absent key mean "not callable"; writing the value
        // keeps this path's behaviour exactly as it was, and makes the
        // decision visible in the file and round-trippable in the studio's
        // toggle. Flip the fallback to `false` if AI-authored components
        // should instead be opt-in.
        agentEnabled: component.agentEnabled !== false,
        directChatEnabled: component.directChatEnabled === true
    };
    await fs.promises.writeFile(path.join(componentDir, 'component.json'), JSON.stringify(componentJson, null, 2));

    const packageJson = {
        name: component.id,
        version: '1.0.0',
        dependencies: component.dependencies || {}
    };
    await fs.promises.writeFile(path.join(componentDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    await fs.promises.writeFile(path.join(componentDir, 'index.js'), component.code);

    await componentManager.initialize();

    res.json({ success: true, id: component.id, message: 'Component created successfully' });
});

module.exports = router;

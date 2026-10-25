// @typecheck
/**
 * Core's own tool families: the tools that are Bee Flow itself rather than a
 * third-party integration (skills, media generation, reminders, Cowork,
 * datatables). Registered when the dispatcher loads; the integration families
 * register from integrations/toolFamilies.js.
 *
 * The `order` values interleave with the integration families' and reproduce
 * the sequence of the dispatcher's former if-chain (see toolFamilyRegistry.js).
 * The executors below are lazily required, as they were in that chain: some of
 * them sit in import cycles with the chat runtime.
 */

const { registerToolFamily } = require('./toolFamilyRegistry');
const configStore = require('../../stores/configStore');

function sessionSkillRuntime() {
    return require('./sessionSkillRuntime');
}

/** An SSE sender that tolerates a context without one. */
function relay(send) {
    return (type, data) => {
        if (send) send(type, data);
    };
}

// ─── Skill Activation (dynamic skill loading) ──────────────────
async function executeActivateSkillTool(toolName, toolArgs, context) {
    const { executeActivateSkill } = require('./skillInjection');
    // agentId/conversationId attribute the skill_activations row this path
    // records with source 'activate_skill' — without them the activation
    // belongs to no agent and no conversation.
    return await executeActivateSkill({
        args: toolArgs,
        orgId: context.orgId,
        userId: context.userId,
        onSkillsActivated: context.onSkillsActivated,
        agentId: context.agentId || null,
        conversationId: context.conversationId || null,
        // Who starts an automation-linked skill (handoff 5 caller trace).
        callerAgentId: context.callerAgentId || context.agentId || null,
        runScope: context.runScope || null,
    });
}

// ─── Session Skill Runtime (direct-chat local skills) ──────────
function isSessionSkillTool(toolName) {
    const rt = sessionSkillRuntime();
    return toolName === rt.ACTIVATE_SESSION_SKILL_TOOL_NAME
        || toolName === rt.COMPLETE_SESSION_SKILL_TOOL_NAME
        || toolName === rt.PUBLISH_SESSION_SKILL_TOOL_NAME;
}

async function executeSessionSkillTool(toolName, toolArgs, context) {
    const rt = sessionSkillRuntime();
    const sessionSkills = context.sessionSkills || [];
    if (toolName === rt.ACTIVATE_SESSION_SKILL_TOOL_NAME) {
        return await rt.executeActivateSessionSkill({
            args: toolArgs,
            sessionSkills,
            activatedSkillIds: context.activatedSessionSkillIds || [],
            completedSkillIds: context.completedSessionSkillIds || [],
        });
    }
    if (toolName === rt.COMPLETE_SESSION_SKILL_TOOL_NAME) {
        return await rt.executeCompleteSessionSkill({
            args: toolArgs,
            sessionSkills,
            activatedSessionSkillIds: context.activatedSessionSkillIds || [],
            completedSessionSkillIds: context.completedSessionSkillIds || [],
            roundsInCurrentStep: typeof context.roundsInCurrentStep === 'number' ? context.roundsInCurrentStep : null,
        });
    }
    return await rt.executePublishSessionSkill({
        args: toolArgs,
        sessionSkills,
        orgId: context.orgId,
        userId: context.userId,
    });
}

// ─── Image Generation ──────────────────────────────────────────
async function executeGenerateImage(toolName, toolArgs, context) {
    const { executeImageGenTool } = require('./imageGenTool');
    const { send, onImageGenerated } = context;
    let capturedImageData = null;
    const imgSend = (type, data) => {
        if (type === 'image' && data?.data) {
            capturedImageData = data;
        }
        if (send) send(type, data);
    };
    const result = await executeImageGenTool(toolArgs, context.imageGenSettings, imgSend, context.req);
    // Enrich captured image data with proxy URL for persistent storage
    if (capturedImageData && onImageGenerated) {
        if (result?.imageUrl) capturedImageData.url = result.imageUrl;
        onImageGenerated(capturedImageData);
    }
    return result;
}

// ─── Video Generation ──────────────────────────────────────────
async function executeGenerateVideo(toolName, toolArgs, context) {
    const { executeVideoGenTool } = require('./videoGenTool');
    return await executeVideoGenTool(toolArgs, relay(context.send), context.req, context.nanoBananaSettings);
}

// ─── ElevenLabs Tools (Music, TTS, SFX) ────────────────────────
async function executeElevenLabs(toolName, toolArgs, context) {
    const { executeElevenLabsTool } = require('./elevenLabsTools');
    return await executeElevenLabsTool(toolName, toolArgs, relay(context.send), context.req, context.nanoBananaSettings);
}

// ─── Reminder Tool ─────────────────────────────────────────────
async function executeSetReminder(toolName, toolArgs, context) {
    const reminderStore = require('../../stores/reminderStore');
    const { userId } = context;
    if (!userId) return { error: 'Not authenticated' };
    if (!toolArgs.title) return { error: 'Title is required' };
    if (!toolArgs.remind_at) return { error: 'remind_at is required' };
    try {
        const reminder = await reminderStore.createReminder({
            userId,
            title: toolArgs.title,
            message: toolArgs.message || '',
            remindAt: toolArgs.remind_at,
            repeatInterval: toolArgs.repeat_interval || null,
        });
        return { success: true, reminder_id: reminder.id, title: reminder.title, remind_at: reminder.remindAt, repeat_interval: reminder.repeatInterval || 'none' };
    } catch (err) {
        return { error: `Failed to create reminder: ${err.message}` };
    }
}

// ─── Cowork Tool ───────────────────────────────────────────────
// Writes to cowork_schedules, not ai_tasks. The plain prompt tasks this
// used to create were migrated into Cowork and that table no longer has a
// UI, so anything landing there would be invisible and unmanageable. The
// tool name stays `set_ai_task`: it is in every model's tool schema and in
// saved agent configs, and renaming it would silently drop the capability
// from existing agents.
async function executeSetAiTask(toolName, toolArgs, context) {
    const coworkStore = require('../../stores/coworkStore');
    const { userId } = context;
    if (!userId) return { error: 'Not authenticated' };
    if (!toolArgs.title) return { error: 'Title is required' };
    if (!toolArgs.prompt) return { error: 'Prompt is required' };
    if (!toolArgs.first_run_at) return { error: 'first_run_at is required' };
    try {
        // Same ceiling as the /api/cowork route — one budget for "how much
        // unattended work may a user queue", however it got queued.
        const maxTasks = (await configStore.getConfig('ai_tasks_max_per_user')) || 10;
        const currentCount = await coworkStore.getScheduleCount(userId);
        if (currentCount >= maxTasks) {
            return { error: `Maximum number of cowork items reached (${maxTasks}). The user needs to delete or pause an existing one first.` };
        }
        // createSchedule's optional fields (toolsEnabled, agentId, ...) are not declared optional.
        const task = await coworkStore.createSchedule(/** @type {any} */ ({
            userId,
            title: toolArgs.title,
            prompt: toolArgs.prompt,
            repeatInterval: toolArgs.repeat_interval || null,
            nextRunAt: toolArgs.first_run_at,
            modelTier: toolArgs.model_tier || 'fast',
            timezone: context?.timezone || 'UTC',
        }));
        return {
            success: true,
            task_id: task.id,
            title: task.title,
            next_run: task.nextRunAt,
            repeat: task.repeatInterval || 'one-time',
            model_tier: task.modelTier,
        };
    } catch (err) {
        return { error: `Failed to create cowork item: ${err.message}` };
    }
}

// ─── Datatable as knowledge (read-only, live, as the asker) ────
// `context.askerUserId`, NOT `context.userId`. That one is the INTEGRATION
// identity: callers overwrite it with an acting operator
// (`userAuth.integrationUserId`, which the Support inbox sets) or with a
// lent connection's owner, so that per-user OAuth tokens resolve. Right
// for a token, wrong for a row: keyed on it, this tool would read a table
// as the operator while the person who asked watches the answer.
// There is no fallback to `userId` on purpose — a caller that does not say
// who is asking gets a refusal, which is the narrow reading of "I could
// not tell". `agentId` is load-bearing too: the grants come off that
// agent's published config.
async function executeDatatable(toolName, toolArgs, context) {
    const { executeDatatableTool } = require('./datatableTools');
    return await executeDatatableTool(toolName, toolArgs, {
        userId: context.askerUserId, agentId: context.agentId,
    });
}

const BUILTIN_TOOL_FAMILIES = [
    { name: 'activate_skill', order: 10, isTool: n => n === require('./skillInjection').ACTIVATE_SKILL_TOOL_NAME, execute: executeActivateSkillTool },
    { name: 'session_skills', order: 20, isTool: isSessionSkillTool, execute: executeSessionSkillTool },
    { name: 'generate_image', order: 30, isTool: n => n === 'generate_image', execute: executeGenerateImage },
    { name: 'generate_video', order: 60, isTool: n => n === 'generate_video', execute: executeGenerateVideo },
    { name: 'elevenlabs', order: 70, isTool: n => require('./elevenLabsTools').isElevenLabsTool(n), execute: executeElevenLabs },
    { name: 'set_reminder', order: 400, isTool: n => n === 'set_reminder', execute: executeSetReminder },
    { name: 'set_ai_task', order: 410, isTool: n => n === 'set_ai_task', execute: executeSetAiTask },
    { name: 'datatable', order: 460, isTool: n => require('./datatableTools').isDatatableTool(n), execute: executeDatatable },
];

function registerBuiltinToolFamilies() {
    for (const family of BUILTIN_TOOL_FAMILIES) registerToolFamily(family);
}

module.exports = { BUILTIN_TOOL_FAMILIES, registerBuiltinToolFamilies };

/** @typedef {import('./toolFamilyRegistry').ToolContext} ToolContext */

const express = require('express');
const agentStore = require('../../stores/agentStore');
const skillStore = require('../../stores/skillStore');
const userStore = require('../../stores/userStore');
const configStore = require('../../stores/configStore');
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { extractJSON } = require('../../pipeline/llmHelpers');
const llmClient = require('../../core/llm/llmClient');
const { resolveModelForTier, getTierConfig } = require('../../core/llm/modelResolver');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const log = require('../../telemetry/log');
const { canCreateSkills, skillsLockedBody } = require('../../core/skills/creationGate');

const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// `plan` and `current` stay OPEN: the first is the model's own plan document
// as the wizard hands it back, the second is the agent config the screen is
// holding, and both are read through their own allow-lists (planPersonaFields,
// buildPreserved). What was missing is the envelope around them -- a
// misspelled `refinment` on /refine read as "no refinement", which the route
// refuses, but a misspelled `locale` or `modelTier` was dropped in silence and
// the wizard drew a plan in the wrong language on the wrong tier.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const doc = (name) => z.record(z.unknown(), { required_error: `${name} is a document.`, invalid_type_error: `${name} is a document.` });
const PROMPT_TEXT = 'Prompt is required';
const REFINE_TEXT = 'Refinement is required';
const opt = (name, what) => worded(`${name} is ${what}.`).nullish();

const DraftBody = bodyOf({
    prompt: worded(PROMPT_TEXT).min(1, PROMPT_TEXT),
    modelTier: opt('modelTier', 'the name of a model tier'),
    locale: opt('locale', 'a locale code'),
});

const RefineBody = bodyOf({
    prompt: opt('prompt', 'what the agent should do'),
    plan: doc('plan'),
    refinement: worded(REFINE_TEXT).min(1, REFINE_TEXT),
    modelTier: opt('modelTier', 'the name of a model tier'),
    locale: opt('locale', 'a locale code'),
    current: doc('current').nullish(),
});

const CommitBody = bodyOf({
    plan: doc('plan'),
    locale: opt('locale', 'a locale code'),
});

// Wizard endpoints all back onto an LLM call. Without a per-user cap a
// logged-in user can run up the org's LLM bill at request rate. 30/min is
// generous for human use (a refine-burst rarely exceeds 5/min) and rejects
// bot-like abuse.
const wizardLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });

// ─────────────────────────────────────────────────────────────────
// Integration catalog the LLM can pick from. Mirrors the catalog in
// agent-hub/src/components/admin/AgentDesigner/integrations.jsx so the
// model picks ids the front-end and runtime actually understand.
// ─────────────────────────────────────────────────────────────────
const INTEGRATION_CATALOG = [
    { id: 'gmail', label: 'Gmail', group: 'google', description: 'Read and send emails' },
    { id: 'google-calendar', label: 'Google Calendar', group: 'google', description: 'Create and manage events' },
    { id: 'google-drive', label: 'Google Drive', group: 'google', description: 'Search and access files' },
    { id: 'google-sheets', label: 'Google Sheets', group: 'google', description: 'Read and write spreadsheets' },
    { id: 'google-docs', label: 'Google Docs', group: 'google', description: 'Create and edit documents' },
    { id: 'google-slides', label: 'Google Slides', group: 'google', description: 'Create presentations' },
    { id: 'google-contacts', label: 'Google Contacts', group: 'google', description: 'Search and manage contacts' },
    { id: 'google-keep', label: 'Google Keep', group: 'google', description: 'List and create notes' },
    { id: 'google-groups', label: 'Google Groups', group: 'google', description: 'Read and reply to group conversations' },
    { id: 'outlook', label: 'Outlook', description: 'Read and send Outlook emails' },
    { id: 'ms-calendar', label: 'Microsoft Calendar', description: 'Manage Microsoft calendar events' },
    { id: 'onedrive', label: 'OneDrive', description: 'Access OneDrive files' },
    { id: 'ms-contacts', label: 'Microsoft Contacts', description: 'Search Microsoft contacts' },
    { id: 'fireflies', label: 'Fireflies.ai', description: 'Meeting transcripts', requiresKey: 'hasFirefliesKey' },
    { id: 'youtrack', label: 'YouTrack', description: 'Issues and projects', requiresKey: 'hasYouTrackConfig' },
    { id: 'gamma', label: 'Gamma', description: 'AI presentations', requiresKey: 'hasGammaKey' },
    { id: 'afas-profit', label: 'AFAS Profit', description: 'Query AFAS Profit business data (read-only)', requiresKey: 'hasAfasConfig' },
    { id: 'nmbrs', label: 'NMBRS', description: 'Read NMBRS payroll & HR data (read-only)', requiresKey: 'hasNmbrsConfig' },
    { id: 'vplan', label: 'vPlan', description: 'Read vPlan planning, capacity & time tracking (read-only)', requiresKey: 'hasVplanConfig' },
    { id: 'linkedin', label: 'LinkedIn', description: 'Post and search on LinkedIn', requiresKey: 'hasLinkedInConfig' },
    { id: 'n8n', label: 'n8n', description: 'Run workflows', requiresKey: 'hasN8nConfig' },
    { id: 'web-search', label: 'Web Search', description: 'Search the web' },
    { id: 'image-gen', label: 'Image Generation', description: 'Generate images' },
];

// Compute the integrations actually available to this user — same gating
// rules as agent-hub/src/components/admin/AgentDesigner/sections/ToolsSection.jsx
async function getAvailableIntegrations(userId) {
    const user = await userStore.getUser(userId).catch(() => null);
    const orgId = user?.organizationId || null;

    let orgEnabled = null;
    // Org-admin "active" subset; null = no extra restriction (e.g. for super
    // admin or when the org has no active list yet). Applied as an
    // intersection AFTER the super-admin allow-list filter.
    let orgActiveSet = null;
    if (orgId) {
        try {
            const org = await userStore.getOrganization(orgId);
            if (org?.enabledIntegrations) {
                orgEnabled = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
            } else {
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabled = typeof globalDefaults === 'string' ? JSON.parse(globalDefaults) : globalDefaults;
                }
            }
            // Super admins bypass — they always see everything the platform
            // allows in the wizard's suggestions.
            if (user?.role !== 'admin') {
                try {
                    const active = await userStore.getOrgEnabledIntegrations(orgId);
                    orgActiveSet = new Set(active);
                } catch (_) { orgActiveSet = new Set(); }
            }
        } catch (_) { /* ignore */ }
    }
    // NC catalog — NC IDs aren't gated by the org-admin active list (they
    // run through the dedicated NC panel + per-group opt-out path), so
    // skip the intersection for them.
    let ncIdSet = new Set();
    try {
        const cat = require('../../core/integrations/ncIntegrationCatalog');
        ncIdSet = cat.NC_INTEGRATION_ID_SET || new Set(cat.NC_INTEGRATION_IDS || []);
    } catch (_) { }

    const isGoogleUser = !!user?.oauthProvider && user.oauthProvider === 'google';
    const isMicrosoftUser = !!user?.oauthProvider && user.oauthProvider === 'microsoft';
    const hasFirefliesKey = !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`).catch(() => null));
    const hasYouTrackConfig = !!(await configStore.getSecret(`youtrack_url_user_${userId}`).catch(() => null))
        && !!(await configStore.getSecret(`youtrack_token_user_${userId}`).catch(() => null));
    const hasGammaKey = !!(await configStore.getSecret(`gamma_api_key_user_${userId}`).catch(() => null));
    const hasAfasConfig = !!(await configStore.getSecret(`afas_token_user_${userId}`).catch(() => null))
        && !!(await configStore.getSecret(`afas_member_number_user_${userId}`).catch(() => null));
    const hasNmbrsConfig = !!(await configStore.getSecret(`nmbrs_subdomain_user_${userId}`).catch(() => null))
        && !!(await configStore.getSecret(`nmbrs_token_user_${userId}`).catch(() => null));
    const hasVplanConfig = !!(await configStore.getSecret(`vplan_api_key_user_${userId}`).catch(() => null))
        && !!(await configStore.getSecret(`vplan_api_env_user_${userId}`).catch(() => null));
    const hasLinkedInConfig = !!(await configStore.getSecret('linkedin_client_id').catch(() => null));
    let hasN8nConfig = false;
    if (orgId) {
        try {
            const url = await configStore.getConfig(`n8n_url_org_${orgId}`);
            const key = await configStore.getSecret(`n8n_api_key_org_${orgId}`);
            hasN8nConfig = !!(url && key);
        } catch (_) { /* ignore */ }
    }

    const status = { isGoogleUser, isMicrosoftUser, hasFirefliesKey, hasYouTrackConfig, hasGammaKey, hasAfasConfig, hasNmbrsConfig, hasVplanConfig, hasLinkedInConfig, hasN8nConfig };

    return INTEGRATION_CATALOG.filter(item => {
        if (orgEnabled && !orgEnabled.includes(item.id)) return false;
        if (orgActiveSet && !ncIdSet.has(item.id) && !orgActiveSet.has(item.id)) return false;
        if (item.group === 'google') return isGoogleUser;
        if (item.id === 'outlook' || item.id === 'ms-calendar' || item.id === 'onedrive' || item.id === 'ms-contacts') return isMicrosoftUser;
        if (item.requiresKey) return !!status[item.requiresKey];
        return true;
    });
}

const PLAN_SCHEMA = `{
  "name": "string (short, friendly agent name)",
  "description": "string (1-2 sentences, second person, in the user's language)",
  "avatar": "single emoji",
  "capabilities": ["string", ...],         // 2-5 short capability bullets
  "model": "fast|thinking",                 // recommended model tier for the agent's task complexity
  "enabledIntegrations": ["id", ...],       // pick ONLY ids from the provided list
  "skills": [
    {
      "id": "string|null",                  // null when proposing a NEW skill
      "name": "string",
      "description": "string (one line)",
      "instructions": "string (when and how the agent should use this skill, in the user's language)"
    }
  ],
  "knowledge_base_ids": ["id", ...],        // keep the agent's current KBs unless the feedback asks to change them
  "persona": {                              // the agent's ROLE as editable fields — this is what its owner sees and edits
    "who": "string (1-3 sentences: who this agent is, who it is for, what it is responsible for)",
    "tone": {
      "chips": ["string", ...],             // 1-4 one-or-two-word tone words, e.g. "friendly", "concise"
      "text": "string (one line of extra tone guidance, or \\"\\")"
    },
    "does": ["string", ...],                // 2-6 short rules of what it DOES
    "doesNot": ["string", ...]              // 0-5 short rules of what it must NEVER do
  },
  "systemPrompt": "string (concrete instructions for the agent, written in the user's language)",
  "routine": null | {                       // OPTIONAL — set ONLY when the user is asking to schedule a recurring task for THIS agent.
    "title": "string (short routine name, in the user's language)",
    "prompt": "string (what the agent should do each time the routine fires)",
    "repeatInterval": "hourly|daily|weekdays|weekly|biweekly|monthly",
    "daysOfWeek": ["mon","tue","wed","thu","fri","sat","sun"] | null,  // only for daily/weekly/biweekly when specific days matter
    "timeOfDay": "HH:MM" | null,             // 24h, in the user's local timezone; null for hourly
    "timezone": "string IANA name" | null    // e.g. "Europe/Amsterdam"; null = use the user's default
  }
}`;

const LOCALE_NAMES = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };

// Skills are Enterprise (license/tiers.js). Without them the plan still has
// the "skills" key (the schema and the client expect it), but the model is told
// to leave it empty and is not shown the library. normalizePlan's caller empties
// it again anyway, because a model does not always do as it is told.
const NO_SKILLS_SECTION = 'Skills are not available in this workspace. Always return "skills": [].';
const NO_SKILLS_RULE = '- skills: always an empty array. Put what a skill would say in persona and systemPrompt instead.';
const SKILLS_RULE = '- skills: propose 0-5 skills. Reuse existing ones by id when there\'s a clear match; otherwise propose new skills with id=null and meaningful instructions.';

function planSystemPrompt(locale, availableIntegrations, existingSkills, currentConfig = null, { skillsAllowed = true } = {}) {
    const langName = LOCALE_NAMES[(locale || 'en').toLowerCase().split('-')[0]] || 'English';
    const integrationList = availableIntegrations.length
        ? availableIntegrations.map(i => `  - ${i.id}: ${i.label} — ${i.description}`).join('\n')
        : '  (none available)';
    const skillList = existingSkills.length
        ? existingSkills.map(s => `  - id="${s.id}" name="${s.name}"${s.description ? ` — ${s.description}` : ''}`).join('\n')
        : '  (no existing skills)';
    const skillsSection = skillsAllowed
        ? `Existing skills in the user's organization (reuse by setting "id" to one of these; otherwise propose a new skill with id=null):\n${skillList}`
        : NO_SKILLS_SECTION;

    // When refining an EXISTING agent, spell out its current curated
    // configuration and instruct the model to preserve it. This is the core of
    // "preserve & patch": a refine like "make the tone friendlier" must not wipe
    // the apps/skills/KBs the user carefully enabled.
    let currentSection = '';
    if (currentConfig) {
        const apps = Array.isArray(currentConfig.enabledIntegrations) && currentConfig.enabledIntegrations.length
            ? currentConfig.enabledIntegrations.join(', ') : '(none)';
        const skills = Array.isArray(currentConfig.attachedSkills) && currentConfig.attachedSkills.length
            ? currentConfig.attachedSkills.map(s => `id="${s.id}" name="${s.name}"`).join(', ') : '(none)';
        const kbs = Array.isArray(currentConfig.knowledge_base_ids) && currentConfig.knowledge_base_ids.length
            ? currentConfig.knowledge_base_ids.join(', ') : '(none)';
        currentSection = `

CURRENT CONFIGURATION — preserve unless the feedback explicitly changes it:
  - enabledIntegrations: ${apps}
  - attachedSkills: ${skills}
  - knowledge_base_ids: ${kbs}
`;
    }

    return `You design AI agent configurations. Given a user's natural-language description, return ONLY a JSON object matching this schema:

${PLAN_SCHEMA}

Available integrations (pick from these ids only — do NOT invent others):
${integrationList}

${skillsSection}
${currentSection}
Rules:
- PRESERVE the current configuration. Return ALL currently-enabled integrations and ALL currently-attached skills (with their existing "id"), and the current knowledge_base_ids, UNLESS the feedback explicitly asks to add, remove or replace them. Never drop a curated app/skill/KB the user did not mention.
- Write all user-facing text (name, description, capabilities, skills.name, skills.description, skills.instructions, systemPrompt) in ${langName}. If the user's prompt is clearly in another language, prefer that language.
- Keep "name" under 40 characters.
- Capabilities are short user-visible bullets, not technical jargon.
- model: recommend "fast" for simple lookups and Q&A, "thinking" for analysis, writing and deep multi-step reasoning. Default to "fast" when unsure.
- enabledIntegrations: APPS ARE OFF BY DEFAULT. Add an id ONLY when the agent's stated job clearly requires it (e.g. include "gmail" only if the agent must read or send email). Do not enable apps speculatively. If unsure, leave the array empty — the user can flip apps on later in the editor.
${skillsAllowed ? SKILLS_RULE : NO_SKILLS_RULE}
- persona is the SOURCE of the agent's role: "who", "tone", "does" and "doesNot" are the fields its owner edits afterwards, so put the real substance there and write them in ${langName}. Say the same things you would put in systemPrompt, split across the fields: scope and responsibility in "who", house style in "tone", the concrete rules in "does", and the hard limits ("never promise a refund") in "doesNot". Keep each does/doesNot entry to one short sentence.
- persona and systemPrompt must agree. Fill in persona ALWAYS; systemPrompt stays the prose version for agents whose owner writes their instructions by hand.
- systemPrompt must be self-contained: tone, scope, what to do, what to avoid.
- routine: leave null UNLESS the user is explicitly asking to SCHEDULE a recurring task ("every morning", "each Monday", "weekly", "every 2 hours", "monthly report"). When set, write title/prompt in ${langName}, and pick the cadence and time that match the user's request. Do NOT invent a routine for vague capability requests like "summarize emails" — only when there's a clear time signal.
- Respond with raw JSON only, no markdown fences.`;
}

/**
 * The four DESCRIPTIVE persona fields of a plan, clamped — or null when the
 * model gave us nothing usable.
 *
 * Clamping runs through `personaPrompt.normalisePersona`, the same total
 * function the write path uses, so a plan can never carry a `who` the column
 * would truncate or a chip list the editor would silently drop. Only the four
 * fields come back out: `unknown`, `language`, `mode` and `freeText` are NOT
 * the model's business. `unknown` in particular has config side effects
 * (strict knowledge, an app, a routine grant), and a plan is a suggestion, not
 * a grant.
 *
 * NULL IS LOAD-BEARING. It is the difference between "the model wrote a role"
 * and "it did not", and the callers branch on exactly that: no fields means the
 * agent keeps the prose prompt as its source (free mode), which is what every
 * plan produced before this schema existed.
 */
function planPersonaFields(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const personaPrompt = require('../../core/agentRuntime/personaPrompt');
    const { persona } = personaPrompt.normalisePersona(raw);
    const hasContent = !!(persona.who || persona.does.length || persona.doesNot.length
        || persona.tone.chips.length || persona.tone.text);
    if (!hasContent) return null;
    return { who: persona.who, tone: persona.tone, does: persona.does, doesNot: persona.doesNot };
}

function normalizePlan(plan, availableIntegrationIds) {
    delete plan.channels;
    delete plan.suggestedSkills; // legacy field

    // The role as fields (A3). `null` when the model ignored the block — the
    // callers fall back to the prose prompt rather than inventing a role.
    plan.persona = planPersonaFields(plan.persona);

    if (!Array.isArray(plan.capabilities)) plan.capabilities = [];
    if (!plan.avatar) plan.avatar = '🤖';

    // Model tier recommendation (BFSF-201) — validate against the real,
    // selectable tiers; null otherwise so the client only applies a real
    // suggestion. Legacy `smart` (older prompt/plan output) maps to its
    // canonical tier `thinking` so the value passes the save-time tier gate.
    if (plan.model === 'smart') plan.model = 'thinking';
    plan.model = ['fast', 'thinking'].includes(plan.model) ? plan.model : null;

    // Validate integration ids against the user-allowed list (security: drop unknowns).
    if (!Array.isArray(plan.enabledIntegrations)) plan.enabledIntegrations = [];
    plan.enabledIntegrations = plan.enabledIntegrations
        .map(s => String(s || '').trim())
        .filter(id => availableIntegrationIds.includes(id));

    // Skills: each must have at least a name. id may be null/missing.
    if (!Array.isArray(plan.skills)) plan.skills = [];
    plan.skills = plan.skills
        .filter(s => s && typeof s === 'object' && s.name && String(s.name).trim())
        .map(s => ({
            id: s.id || null,
            name: String(s.name).trim(),
            description: String(s.description || '').trim(),
            instructions: String(s.instructions || '').trim(),
        }));

    // Knowledge base ids — coerce to a clean string array. Actual cross-org
    // authorization is enforced at save time by validateAgentConfigReferences;
    // here we only sanitize the shape so the client merge is predictable.
    if (!Array.isArray(plan.knowledge_base_ids)) plan.knowledge_base_ids = [];
    plan.knowledge_base_ids = plan.knowledge_base_ids.map(s => String(s || '').trim()).filter(Boolean);

    // Routine: optional. Validate the cadence enum + day tokens; drop the
    // whole field if it's malformed (the chat panel handles missing routines
    // gracefully, but bad data would break the routine creator on the client).
    if (plan.routine && typeof plan.routine === 'object') {
        const r = plan.routine;
        const VALID_CADENCES = ['hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
        const VALID_DOW = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
        if (!r.title || !r.prompt || !VALID_CADENCES.includes(r.repeatInterval)) {
            delete plan.routine;
        } else {
            plan.routine = {
                title: String(r.title).trim().slice(0, 200),
                prompt: String(r.prompt).trim().slice(0, 4000),
                repeatInterval: r.repeatInterval,
                daysOfWeek: Array.isArray(r.daysOfWeek)
                    ? r.daysOfWeek.map(d => String(d).toLowerCase().slice(0, 3)).filter(d => VALID_DOW.has(d))
                    : null,
                timeOfDay: typeof r.timeOfDay === 'string' && /^\d{2}:\d{2}$/.test(r.timeOfDay) ? r.timeOfDay : null,
                timezone: typeof r.timezone === 'string' && r.timezone.trim() ? r.timezone.trim() : null,
            };
            if (Array.isArray(plan.routine.daysOfWeek) && plan.routine.daysOfWeek.length === 0) {
                plan.routine.daysOfWeek = null;
            }
        }
    } else {
        delete plan.routine;
    }

    return plan;
}

async function generatePlan({ userPrompt, priorPlan, refinement, modelTier, locale, userOrgId, userId, currentConfig = null, skillsAllowed = true }) {
    const tier = modelTier || 'fast';
    const modelId = await resolveModelForTier(`tier:${tier}`, { userOrgId, userId, fallbackTier: 'fast' });
    const tierConfig = await getTierConfig(tier, { userOrgId, userId });

    const [availableIntegrations, existingSkills] = await Promise.all([
        getAvailableIntegrations(userId).catch(() => []),
        (skillsAllowed && userOrgId) ? skillStore.getAvailableSkills(userOrgId, userId).catch(() => []) : Promise.resolve([]),
    ]);
    const availableIds = availableIntegrations.map(i => i.id);

    const messages = [{ role: 'system', content: planSystemPrompt(locale, availableIntegrations, existingSkills, currentConfig, { skillsAllowed }) }];
    if (priorPlan) {
        // When refining a wizard-created agent we have the original prompt and
        // can prime the model with the original-request → prior-plan turn.
        // When refining an EXISTING agent (BuilderSplit flow), userPrompt is
        // empty — sending a `{role:'user', content:''}` makes Anthropic 400 with
        // "user messages must have non-empty content". Embed the prior plan in
        // the user turn instead so there's exactly one non-empty user message.
        const trimmedPrompt = (userPrompt || '').trim();
        if (trimmedPrompt) {
            messages.push({ role: 'user', content: trimmedPrompt });
            messages.push({ role: 'assistant', content: JSON.stringify(priorPlan) });
            messages.push({ role: 'user', content: `Update the plan to address this feedback. Return the full updated JSON only.\n\nFeedback: ${refinement}` });
        } else {
            messages.push({
                role: 'user',
                content:
                    `Here is the current agent configuration as JSON:\n\n` +
                    `${JSON.stringify(priorPlan)}\n\n` +
                    `Update it to address this feedback. Return the full updated JSON only.\n\nFeedback: ${refinement}`,
            });
        }
    } else {
        messages.push({ role: 'user', content: `Build an agent for this request:\n\n${userPrompt}` });
    }

    const result = await llmClient.chat(modelId, messages, {
        temperature: tierConfig?.temperature ?? 0.4,
        // A full refined plan (systemPrompt + several skills-with-instructions +
        // capabilities + routine + KBs) can exceed 4000 tokens and truncate,
        // which fails extractJSON. 8000 fits a realistic plan and stays under
        // every tier's real max.
        maxTokens: Math.min(tierConfig?.maxTokens ?? 4000, 8000),
        budgetTokens: 0,
        reasoningEffort: 'none',
    });

    const text = result?.content || '';
    const plan = extractJSON(text);
    if (!plan || !plan.name) {
        const err = new Error('Could not parse agent plan from model output');
        err.raw = text;
        throw err;
    }

    const normalized = normalizePlan(plan, availableIds);
    // The screen must not show skills that commit will not create. On refine
    // an empty list means "keep what the agent has" (refineMerge.js), so an
    // agent's already-attached skills are not dropped by this.
    if (!skillsAllowed) normalized.skills = [];
    return normalized;
}

/**
 * May this wizard request add skills? Skills are Enterprise; the wizard itself
 * is not. Asked once per request, fails closed (core/skills/creationGate.js).
 */
function skillsAllowedFor(req, userId, orgId) {
    return canCreateSkills({ userId, orgId, session: req.session, req });
}

// Shared error mapping for the plan-generating endpoints. A malformed model
// output (extractJSON failure) sets `err.raw`; surface it as a retryable 422
// `plan_parse_failed` rather than a generic 500 so the client can show a
// "model returned malformed output, please retry" affordance.
function respondPlanError(res, next, err, where) {
    if (err.raw === undefined) return next(err);
    log.error(`Agent wizard ${where} failed:`, err);
    return res.status(422).json({
        error: err.message,
        reason: 'plan_parse_failed',
        rawPreview: typeof err.raw === 'string' ? err.raw.slice(0, 500) : null,
    });
}

// Build the "preserve" echo from the client's current curated config so the
// client can merge deterministically (absent field ⇒ keep current). Crucially
// `model` is echoed VERBATIM (incl. custom tiers), which normalizePlan's
// fast|thinking collapse would otherwise destroy on refine.
function buildPreserved(current) {
    const c = current && typeof current === 'object' ? current : {};
    const attachedSkillIds = Array.isArray(c.attachedSkills)
        ? c.attachedSkills.map(s => (s && s.id) || (typeof s === 'string' ? s : null)).filter(Boolean)
        : (Array.isArray(c.attachedSkillIds) ? c.attachedSkillIds.filter(Boolean) : []);
    return {
        model: typeof c.model === 'string' ? c.model : null,
        enabledIntegrations: Array.isArray(c.enabledIntegrations) ? c.enabledIntegrations : [],
        attachedSkillIds,
        knowledge_base_ids: Array.isArray(c.knowledge_base_ids) ? c.knowledge_base_ids : [],
    };
}

router.post('/wizard/draft', requirePermission('manage_agents'), wizardLimiter, validate({ body: DraftBody }), async (req, res, next) => {
    try {
        const { prompt, modelTier, locale } = req.body;
        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        const skillsAllowed = await skillsAllowedFor(req, userId, userOrgId);
        const plan = await generatePlan({ userPrompt: prompt, modelTier, locale, userOrgId, userId, skillsAllowed });
        res.json({ plan });
    } catch (err) {
        respondPlanError(res, next, err, 'draft');
    }
});

router.post('/wizard/refine', requirePermission('manage_agents'), wizardLimiter, validate({ body: RefineBody }), async (req, res, next) => {
    try {
        const { prompt, plan, refinement, modelTier, locale, current } = req.body;
        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        const currentConfig = current && typeof current === 'object' ? current : null;
        const skillsAllowed = await skillsAllowedFor(req, userId, userOrgId);
        const updated = await generatePlan({ userPrompt: prompt, priorPlan: plan, refinement, modelTier, locale, userOrgId, userId, currentConfig, skillsAllowed });
        // `preserved` lets the client keep curated apps/skills/model/KBs even if
        // the model imperfectly echoes them. See buildPreserved.
        res.json({ plan: updated, preserved: buildPreserved(current) });
    } catch (err) {
        respondPlanError(res, next, err, 'refine');
    }
});

/**
 * The persona (A1c) for a freshly planned agent — FIELDS mode when the plan
 * carries a role, free mode when it does not.
 *
 * WHY FIELDS. A3 makes `persona` the thing an owner edits: five cards, one per
 * field. An agent created in free mode opens those cards READ-ONLY, describing
 * a prompt nobody can adjust without running an AI parse over it first — and
 * since the wizard is how nearly every agent is born, free mode at creation
 * would make the Role tab a read-only screen for the whole product.
 *
 * WHY THIS IS NOT THE REWRITE THE OLD COMMENT WARNED ABOUT. It used to be:
 * "the plan's systemPrompt says more than these fields can hold, so rendering
 * `capabilities` over it throws the rest away". That was true while the fields
 * were GUESSED from `description` + `capabilities`. They are not any more — the
 * plan schema asks the model for `who`/`tone`/`does`/`doesNot` directly, so the
 * render is the model's own words, not a lossy summary of them. When the model
 * ignores the block (`plan.persona` normalises to null) the old behaviour is
 * exactly what happens: free mode over the prose prompt, nothing lost.
 *
 * `unknown` stays 'honest' either way — the narrowest of the three. Note that
 * it no longer drags `strictKnowledge` along on an agent without a knowledge
 * base; see `applyPersonaToConfig`, which is the only place that decides.
 */
function personaFromPlan(plan, locale) {
    const personaPrompt = require('../../core/agentRuntime/personaPrompt');
    const base = typeof locale === 'string' ? locale.toLowerCase().split('-')[0] : '';
    const fields = planPersonaFields(plan.persona);
    const capabilities = Array.isArray(plan.capabilities) ? plan.capabilities : [];
    const shared = { unknown: { mode: 'honest' }, language: base || null };
    const { persona } = personaPrompt.normalisePersona(fields
        ? {
            ...shared,
            who: fields.who || plan.description || '',
            tone: fields.tone,
            does: fields.does.length ? fields.does : capabilities,
            doesNot: fields.doesNot,
            mode: 'fields',
        }
        : {
            ...shared,
            who: plan.description || '',
            does: capabilities,
            mode: 'free',
            freeText: plan.systemPrompt || '',
        });
    // The stored prompt is the persona's own text, not the raw plan string, so
    // the two can never disagree by a stripped control character.
    return { persona, systemPrompt: personaPrompt.renderedPromptFor(persona) };
}

// POST /agents/wizard/commit  { plan, locale }  -> creates the agent, returns it
router.post('/wizard/commit', requirePermission('manage_agents'), wizardLimiter, validate({ body: CommitBody }), async (req, res) => {
    const { plan, locale } = req.body;
    if (!plan.name) return res.status(400).json({ error: 'Plan with name is required' });

    const userId = getEffectiveUserId(req);
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

    // ── Skills: reuse existing by id, create new ones ──────────────
    // Skills are Enterprise. Without them the agent is still created, just
    // without skills: the wizard is how nearly every agent is born, and a
    // plan with skills in it (an old screen, a hand-built request) must not
    // cost a Community user the agent. The response names what was left out.
    let attachedSkillIds = [];
    const createdSkills = [];
    let skillsSkipped = null;
    const plannedSkills = Array.isArray(plan.skills) ? plan.skills.filter(s => s && s.name) : [];
    if (orgId && plannedSkills.length > 0 && !(await skillsAllowedFor(req, userId, orgId))) {
        // A 200 carries no `error` key: the agent WAS created. The sentence
        // goes in `message`, the refusal's machine-readable part alongside.
        const { error: message, ...locked } = skillsLockedBody();
        skillsSkipped = { ...locked, message, names: plannedSkills.map(s => String(s.name)) };
        log.info(`[Wizard commit] skills not available: left out ${plannedSkills.length} planned skill(s)`);
    } else if (orgId && plannedSkills.length > 0) {
        // Best-effort lookup of existing skills — but a failure here must NOT
        // block creation of new ones. Default to empty list on error.
        let orgSkills = [];
        try {
            orgSkills = await skillStore.getAvailableSkills(orgId, userId);
        } catch (lookupErr) {
            log.warn('Wizard: getAvailableSkills failed, will only create new skills:', lookupErr.message);
        }
        const knownIds = new Set((orgSkills || []).map(s => s.id));
        const byName = new Map((orgSkills || []).map(s => [String(s.name || '').toLowerCase().trim(), s.id]));

        for (const s of plannedSkills) {
            // Reuse existing skill by id when valid
            if (s.id && knownIds.has(s.id)) { attachedSkillIds.push(s.id); continue; }

            // Reuse by case-insensitive name match before creating a duplicate
            const nameKey = String(s.name).toLowerCase().trim();
            const matchByName = byName.get(nameKey);
            if (matchByName) { attachedSkillIds.push(matchByName); continue; }

            // Create the skill — isolate failures per skill so one bad
            // entry doesn't drop the rest.
            try {
                const created = await skillStore.createSkill({
                    orgId,
                    userId,
                    name: s.name,
                    description: s.description || '',
                    instructions: (s.instructions || '').slice(0, 4000),
                    workflow: '',
                    rules: '',
                    examples: '',
                    icon: null,
                    isShared: false,
                    dynamicActivation: false,
                    sharedGroups: [],
                });
                if (created?.id) {
                    attachedSkillIds.push(created.id);
                    createdSkills.push(created);
                } else {
                    log.warn('Wizard: createSkill returned no id for', s.name);
                }
            } catch (createErr) {
                log.warn('Wizard: skill create failed for', s.name, ':', createErr.message);
            }
        }
    }
    log.info(`[Wizard commit] attached skills: ${attachedSkillIds.length}, newly created: ${createdSkills.length}`);

    // ── Integrations: validate ids against the user's allow-list ──
    // (defensive — the LLM should already only pick from allowed ones,
    // but never trust the client to round-trip server-validated state)
    const availableIntegrations = await getAvailableIntegrations(userId).catch(() => []);
    const availableIds = new Set(availableIntegrations.map(i => i.id));
    const requested = Array.isArray(plan.enabledIntegrations)
        ? plan.enabledIntegrations.filter(id => availableIds.has(id))
        : [];
    // Apps are OFF BY DEFAULT — store the AI's literal pick (may be empty).
    // Legacy semantic of `null = "all enabled"` is no longer produced here;
    // pre-existing rows are converted by the backfill migration.
    const enabledIntegrations = requested;

    const config = {
        avatar: plan.avatar || '🤖',
        enabledIntegrations,
        knowledge_base_ids: [],
        attachedSkillIds,
        memoryEnabled: false,
        strictKnowledge: false,
        includeSourceReferences: false,
        wizard: {
            capabilities: plan.capabilities || [],
            primaryKbId: null,
        },
    };

    const { persona, systemPrompt } = personaFromPlan(plan, locale);

    const agent = await agentStore.createAgent(
        plan.name,
        plan.description || '',
        systemPrompt !== null ? systemPrompt : (plan.systemPrompt || ''),
        userId,
        null,
        [],
        true,
        true,
        false,
        config,
        orgId,
        [],
        null,
        { persona }
    );

    // ── Optional: AI proposed a routine for this new agent ─────────
    // The wizard plan schema lets the model return an OPTIONAL `routine`
    // block. When present and the user has the `agent_routines` beta we
    // create the AI task atomically with agent creation so the user
    // doesn't need a second round-trip.
    let createdRoutine = null;
    if (agent?.id && plan.routine && typeof plan.routine === 'object') {
        try {
            const { userHasBetaFeature } = require('../../core/entitlements/betaFeatures');
            const allowed = await userHasBetaFeature(userId, 'agent_routines', req.session).catch(() => false);
            if (allowed) {
                const aiTaskStore = require('../../stores/aiTaskStore');
                const { computeRoutineNextRun } = require('../../utils/routineSchedule');
                const r = plan.routine;
                // Shared TZ-aware helper — same one the modal and wizard chat
                // use, so behavior is identical regardless of entry point.
                const nextRunAt = computeRoutineNextRun(r, r.timezone || 'UTC');
                createdRoutine = await aiTaskStore.createTask({
                    userId,
                    agentId: agent.id,
                    title: r.title,
                    prompt: r.prompt,
                    nextRunAt,
                    repeatInterval: r.repeatInterval,
                    modelTier: 'auto',
                    timezone: r.timezone || 'UTC',
                    daysOfWeek: r.daysOfWeek,
                    timeOfDay: r.timeOfDay,
                });
            }
        } catch (routineErr) {
            log.warn('Wizard: routine auto-create failed (non-fatal):', routineErr.message);
        }
    }

    res.json({ agent, createdSkills, routine: createdRoutine, ...(skillsSkipped ? { skillsSkipped } : {}) });
});

module.exports = router;
module.exports.personaFromPlan = personaFromPlan;
module.exports.planPersonaFields = planPersonaFields;

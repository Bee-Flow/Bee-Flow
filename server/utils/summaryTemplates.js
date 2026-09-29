// @typecheck
/**
 * Summary templates — shared, dependency-free.
 *
 * Holds the built-in "Regenerate" summary styles (extracted out of
 * `routes/transcriptions.js` so both the HTTP routes and the new
 * `/api/summary-templates` CRUD can share one source), the system-prompt
 * builder used for every template-driven summary, and the pure resolver that
 * picks which saved template is the default for a given user.
 *
 * No DB, no LLM imports here — the store (`stores/summaryTemplateStore.js`) and
 * the routes layer on top of this. That keeps `pickDefaultTemplate` and
 * `buildSummarySystemPrompt` unit-testable without spinning up Postgres.
 */

const LANG_NAMES = { nl: 'Dutch', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };

/**
 * The five built-in styles. `id` is the wire value the client sends as
 * `{ template }`; `nameKey` is the i18n key for the label; `name` is the
 * English fallback. `prompt` is the instruction block appended after the
 * language preamble (see buildSummarySystemPrompt). Read-only — the UI seeds
 * new custom templates from these but never edits them in place.
 */
const BUILTIN_TEMPLATES = [
    {
        id: 'general',
        nameKey: 'meeting_notes.template_general',
        name: 'General meeting',
        prompt: `Create a concise, well-structured summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Summary
A brief 2-3 sentence overview of what the meeting was about.

## 🔑 Key Topics
- Bullet points of main topics discussed

## ✅ Decisions Made
- Any decisions that were agreed upon (skip if none)

## 📌 Action Items
- Specific tasks assigned to people (skip if none)

## 💡 Key Insights
- Notable ideas, suggestions, or observations

Keep it concise and actionable. Skip empty sections.`,
    },
    {
        id: 'standup',
        nameKey: 'meeting_notes.template_standup',
        name: 'Stand-up',
        prompt: `Create a standup/daily sync summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Daily Sync Summary
Brief overview of the standup meeting.

## ✅ What Was Done
- Per person: what they completed since last standup

## 🚧 In Progress
- Per person: what they're currently working on

## 🚫 Blockers
- Any blockers or impediments mentioned

## 📌 Next Steps
- Specific follow-up actions

Keep it concise. Skip empty sections.`,
    },
    {
        id: 'sales',
        nameKey: 'meeting_notes.template_sales',
        name: 'Sales call',
        prompt: `Create a sales call summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Call Summary
Brief overview: who was on the call, company/prospect name if mentioned.

## 🎯 Customer Needs
- Pain points, requirements, or goals expressed by the prospect

## 💬 Key Discussion Points
- Main topics covered during the call

## ⚠️ Objections & Concerns
- Any pushback, hesitations, or concerns raised

## 📌 Next Steps
- Agreed follow-up actions with owners and timelines

## 📊 Deal Assessment
- Brief assessment of the opportunity

Keep it concise and actionable. Skip empty sections.`,
    },
    {
        id: 'interview',
        nameKey: 'meeting_notes.template_interview',
        name: 'Interview',
        prompt: `Create an interview summary of the meeting transcript.

Format with these sections (use markdown):
## 📋 Interview Summary
Candidate name (if mentioned), role, and overall impression.

## 💪 Strengths
- Key strengths and positive signals from the candidate

## ⚠️ Concerns
- Areas of concern or gaps

## 🔑 Key Responses
- Notable answers to important questions

## 📊 Fit Assessment
- Overall assessment and recommendation

## 📌 Follow-up Actions
- Next steps in the hiring process

Keep it concise and objective. Skip empty sections.`,
    },
    {
        id: 'retrospective',
        nameKey: 'meeting_notes.template_retrospective',
        name: 'Retrospective',
        prompt: `Create a retrospective meeting summary.

Format with these sections (use markdown):
## 📋 Retrospective Summary
Brief overview of what was discussed.

## 🌟 What Went Well
- Positive outcomes and successes

## 🔧 What Could Be Improved
- Areas for improvement

## 💡 Ideas & Suggestions
- Proposed changes or experiments

## 📌 Action Items
- Specific improvement actions with owners

Keep it concise and actionable. Skip empty sections.`,
    },
];

const BUILTIN_BY_ID = Object.fromEntries(BUILTIN_TEMPLATES.map(t => [t.id, t]));

/** Resolve the built-in prompt for a wire `template` key, falling back to general. */
function builtinPrompt(templateId) {
    return (BUILTIN_BY_ID[templateId] || BUILTIN_BY_ID.general).prompt;
}

/**
 * The system prompt for a template-driven summary. Identical construction for
 * built-in and custom templates and for both the Regenerate route and the
 * first-generation default path, so a template behaves the same everywhere.
 */
function buildSummarySystemPrompt(templatePrompt, language) {
    const langName = LANG_NAMES[language] || language;
    return `You are a meeting assistant. Write the summary in ${langName}.

${templatePrompt}`;
}

/**
 * Pick the default template for a user from the flat list of templates visible
 * to them. Pure — no DB. Precedence, most specific first:
 *   personal default ▸ group default (a group the user is in) ▸ org default.
 * Returns the winning template object, or null (→ caller uses the built-in
 * localized first-generation prompt, i.e. no behaviour change).
 *
 * `templates` are camelCase rows as returned by the store's mapRow
 * ({ scope, isDefault, userId, organizationId, groupId, ... }).
 */
function pickDefaultTemplate(templates, { userId = null, orgIds = [], groupIds = [] } = {}) {
    const list = Array.isArray(templates) ? templates.filter(t => t && t.isDefault) : [];
    const orgSet = new Set(orgIds || []);
    const groupSet = new Set(groupIds || []);

    const personal = list.find(t => t.scope === 'user' && t.userId === userId);
    if (personal) return personal;

    // A user can be in several groups; if more than one carries a default,
    // prefer the most recently updated so the choice is deterministic.
    const groupDefaults = list
        .filter(t => t.scope === 'group' && groupSet.has(t.groupId))
        .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    if (groupDefaults.length) return groupDefaults[0];

    const org = list.find(t => t.scope === 'org' && orgSet.has(t.organizationId));
    if (org) return org;

    return null;
}

/**
 * Whether a user (given their org + group context) may see/use a custom
 * template. Pure — used by both the CRUD list filter and the Regenerate route
 * before it applies a `templateId`.
 */
function canAccessTemplate(template, { userId = null, orgIds = [], groupIds = [] } = {}) {
    if (!template) return false;
    if (template.scope === 'user') return template.userId === userId;
    if (template.scope === 'org') return (orgIds || []).includes(template.organizationId);
    if (template.scope === 'group') return (groupIds || []).includes(template.groupId);
    return false;
}

module.exports = {
    LANG_NAMES,
    BUILTIN_TEMPLATES,
    BUILTIN_BY_ID,
    builtinPrompt,
    buildSummarySystemPrompt,
    pickDefaultTemplate,
    canAccessTemplate,
};

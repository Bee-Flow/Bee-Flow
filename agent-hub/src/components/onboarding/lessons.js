// Learning Center lesson catalog.
//
// Each lesson is a short guided walkthrough that runs on the SAME engine as the
// new-user product tour (see OnboardingTour.jsx). A lesson reuses the exact step
// schema documented in tourSteps.js, so anything the intro tour can do — spotlight
// a [data-tour] selector, navigate between views, run an interactive "do it
// yourself" step, fall back to a centered card when a target is missing — a lesson
// can do too.
//
// The original 12-step intro tour is the canonical `getting-started` lesson: its
// steps ARE TOUR_STEPS (no copy), so the first-login auto-start and the "Take the
// tour" button keep running the same sequence.
//
// Lesson descriptor:
//   id          — stable key (React keys, completion map, analytics)
//   group       — 'basics' | 'building' | 'power' | 'admin' (card grouping)
//   icon        — emoji, rendered in the engine's 36px tinted tile (never purple)
//   estMinutes  — rough time, shown on the card
//   titleKey/titleFallback, descKey/descFallback — card copy (fallback always renders)
//   gate        — { permission?: string|string[], feature?: string }. Omit → everyone.
//                 A lesson the user can't access (missing permission OR plan
//                 feature) is hidden entirely (resolveLessons).
//   steps       — array of tour steps (same schema as tourSteps.js)

import { checkPermission } from '../../hooks/usePermissionCheck';
import {
    TOUR_STEPS,
    filterStepsForUser,
    TOUR_SEEN_KEY,
    TOUR_START_EVENT,
    TOUR_ENSURE_SIDEBAR_EVENT,
} from './tourSteps';
import { stepType, STEP_TYPES } from './stepTypes';
import { GENERATED_LESSONS } from './generated/lessons';

export const DEFAULT_LESSON_ID = 'getting-started';

// Engine → page signal so an open Learning Center can flip a card to "Replay"
// the moment a lesson finishes.
export const LESSON_COMPLETE_EVENT = 'beeflow:lesson-complete';

// Page → LessonPlayerHost signal to open a rich (slide/quiz/exercise) lesson in
// the focused player. Pure-tour lessons skip the player and dispatch
// TOUR_START_EVENT straight to the engine instead (see lessonIsPureTour).
export const LESSON_PLAYER_OPEN_EVENT = 'beeflow:open-lesson';

// Re-export the event names so the Learning Center page has a single import
// surface (it dispatches TOUR_START_EVENT and listens for LESSON_COMPLETE_EVENT).
export { TOUR_START_EVENT, TOUR_ENSURE_SIDEBAR_EVENT, TOUR_SEEN_KEY };

/* ── Lesson 2: Writing effective prompts ─────────────────────────────────── */
const PROMPTS_STEPS = [
    {
        id: 'prompts-intro', placement: 'center', icon: '💬',
        titleKey: 'learn.effective-prompts.intro.title', titleFallback: 'Writing effective prompts',
        bodyKey: 'learn.effective-prompts.intro.body',
        bodyFallback: 'A great prompt is context + a clear ask + the format you want back. Four quick tips to get better answers — in any chat.',
    },
    {
        id: 'prompts-where', navigateTo: 'agents', target: '[data-tour="chat-composer"]',
        placement: 'top', optional: true, timeoutMs: 6000, icon: '⌨️',
        titleKey: 'learn.effective-prompts.where.title', titleFallback: 'This is where you ask',
        bodyKey: 'learn.effective-prompts.where.body',
        bodyFallback: 'Type here for quick, free-form questions. For specialised help, pick an agent first — same tips apply.',
    },
    {
        id: 'prompts-context', placement: 'center', icon: '🧭',
        titleKey: 'learn.effective-prompts.context.title', titleFallback: '1. Give context',
        bodyKey: 'learn.effective-prompts.context.body',
        bodyFallback: 'Say who you are and what you are working on — e.g. “I run support for a SaaS company.” Context steers the whole answer.',
    },
    {
        id: 'prompts-specific', placement: 'center', icon: '🎯',
        titleKey: 'learn.effective-prompts.specific.title', titleFallback: '2. Make the ask specific',
        bodyKey: 'learn.effective-prompts.specific.body',
        bodyFallback: 'Instead of “write an email”, try “draft a 3-sentence reply apologising for a late delivery and offering 10% off.”',
    },
    {
        id: 'prompts-format', placement: 'center', icon: '📐',
        titleKey: 'learn.effective-prompts.format.title', titleFallback: '3. Ask for a format, then iterate',
        bodyKey: 'learn.effective-prompts.format.body',
        bodyFallback: 'Request bullet points, a table, or a tone (“friendly”, “formal”). Not quite right? Just say “shorter” or “more detail”.',
    },
    {
        id: 'prompts-done', placement: 'center', icon: '✅',
        titleKey: 'learn.effective-prompts.done.title', titleFallback: 'Try it now',
        bodyKey: 'learn.effective-prompts.done.body',
        bodyFallback: 'Open a chat and give one a go. You can replay this lesson anytime from the Learning Center.',
    },
];

/* ── Lesson 3: Creating an agent (rich: slides + live build + quiz) ───────── */
const CREATE_AGENT_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'ca-what', icon: '🤖',
        titleKey: 'learn.creating-agents.what.title', titleFallback: 'What is an agent?',
        bodyMdKey: 'learn.creating-agents.what.body',
        bodyMdFallback: 'An **agent** is an AI assistant you shape for a specific job. Every agent has three parts:\n\n- **A system prompt** — its role, tone and rules.\n- **Tools** — the things it can actually do (email, calendar, web search…).\n- **Knowledge** — your documents it can answer from.\n\nThe quickest way to start: describe what you want in plain English and let Bee Flow draft it. Nothing is created until you submit.',
    },
    {
        id: 'ca-studio', target: '[data-tour="nav-studio"]', placement: 'right',
        ensureSidebarOpen: true, requiresStudio: true, optional: true, icon: '🛠️',
        titleKey: 'learn.creating-agents.studio.title', titleFallback: 'Studio is home base',
        bodyKey: 'learn.creating-agents.studio.body',
        bodyFallback: 'Your agents live in Studio. Each one has a system prompt, tools, and knowledge. Let’s make one.',
    },
    {
        id: 'ca-describe', navigateTo: 'agentWizard', target: '[data-tour="agent-wizard-prompt"]',
        placement: 'bottom', requiresStudio: true, optional: true, interactive: true, timeoutMs: 8000,
        advanceOn: { input: { minLength: 4 }, targetGone: true },
        actionHintKey: 'learn.creating-agents.describe.hint', actionHintFallback: '👉 Describe your agent…',
        icon: '✍️',
        titleKey: 'learn.creating-agents.describe.title', titleFallback: 'Describe what it should do',
        bodyKey: 'learn.creating-agents.describe.body',
        bodyFallback: 'Type a sentence, e.g. “An assistant that turns meeting notes into action items.” Then press Enter to build it.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'ca-refine', icon: '🎉',
        titleKey: 'learn.creating-agents.refine.title', titleFallback: 'Refine, then publish',
        bodyMdKey: 'learn.creating-agents.refine.body',
        bodyMdFallback: 'Your draft is **private** until you publish it. Next, you’ll tune the system prompt, switch on tools, and attach knowledge in the **Agent Designer** — then publish to share it with your team.',
    },
    {
        // v2: verified hands-on — the lesson isn't done until an agent exists.
        type: STEP_TYPES.ACTION, id: 'ca-do', icon: '🤖',
        checkId: 'agent-created',
        titleKey: 'learn.creating-agents.do.title', titleFallback: 'Make one for real — we’ll verify it',
        instructionKey: 'learn.creating-agents.do.instruction',
        instructionFallback: 'Create an agent of your own — one plain-English sentence in the wizard is enough. The checklist verifies your real workspace, and an agent you built earlier counts immediately.',
        launch: { navigateTo: 'agentWizard', labelFallback: 'Open the agent wizard' },
    },
    {
        type: STEP_TYPES.QUIZ, id: 'ca-quiz', icon: '❓',
        questionKey: 'learn.creating-agents.quiz.q', questionFallback: 'Which three parts shape how an agent behaves?',
        choices: [
            { id: 'a', labelFallback: 'System prompt, tools, and knowledge.', correct: true },
            { id: 'b', labelFallback: 'Its name, its colour, and its avatar.', correct: false },
            { id: 'c', labelFallback: 'The model price, the speed, and the region.', correct: false },
        ],
        explanationFallback: 'An agent is its system prompt (role/tone/rules) + the tools it can use + the knowledge it can draw on.',
    },
];

/* ── Lesson 4: Refining an agent (rich: slides + reliable designer tour + exercise) ── */
const REFINE_PROMPT_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'rp-what', icon: '🛠️',
        titleKey: 'learn.refining-prompt.what.title', titleFallback: 'The three dials of an agent',
        bodyMdKey: 'learn.refining-prompt.what.body',
        bodyMdFallback: 'The **Agent Designer** is where you shape behaviour. You’ll spend most of your time on three dials:\n\n1. **System prompt** — the agent’s role, tone and rules.\n2. **Tools** — what it’s allowed to do.\n3. **Knowledge** — the documents it answers from.\n\nNext we’ll spotlight each one in the real Designer — open an agent to follow along.',
    },
    {
        id: 'rp-open', navigateTo: 'studio/agents', placement: 'center', optional: true, timeoutMs: 6000, icon: '🗂️',
        titleKey: 'learn.refining-prompt.open.title', titleFallback: 'Open an agent',
        bodyKey: 'learn.refining-prompt.open.body',
        bodyFallback: 'Pick any agent in Studio to open its designer. The three things below are what you’ll tune most.',
    },
    {
        id: 'rp-system', target: '[data-tour="agent-system-prompt"]', placement: 'top', optional: true, timeoutMs: 6000, icon: '📝',
        titleKey: 'learn.refining-prompt.system.title', titleFallback: 'The system prompt',
        bodyKey: 'learn.refining-prompt.system.body',
        bodyFallback: 'This sets the agent’s role, tone, and rules. Be specific: who it is, what it always/never does, and how it should respond.',
    },
    {
        id: 'rp-tools', target: '[data-tour="agent-tools"]', placement: 'top', optional: true, timeoutMs: 6000, icon: '🧰',
        titleKey: 'learn.refining-prompt.tools.title', titleFallback: 'Tools & integrations',
        bodyKey: 'learn.refining-prompt.tools.body',
        bodyFallback: 'Give the agent abilities — email, calendar, web search, and more — by switching on the tools it’s allowed to use.',
    },
    {
        id: 'rp-knowledge', target: '[data-tour="agent-knowledge"]', placement: 'top', optional: true, timeoutMs: 6000, icon: '📚',
        titleKey: 'learn.refining-prompt.knowledge.title', titleFallback: 'Knowledge',
        bodyKey: 'learn.refining-prompt.knowledge.body',
        bodyFallback: 'Attach a knowledge base so the agent answers from your documents instead of guessing.',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'rp-ex', exerciseId: 'ex-system-prompt', icon: '🎯',
        titleKey: 'learn.refining-prompt.ex.title', titleFallback: 'Your turn: write a system prompt',
        instructionKey: 'learn.refining-prompt.ex.instruction',
        instructionFallback: 'Write a system prompt for an agent of your choice. Define its role, set a tone, and give it at least one clear rule (something it should always or never do).',
        placeholderFallback: 'e.g. “You are a friendly customer-support assistant for an online bookstore. Always be concise and warm. Never promise refunds — instead, direct the customer to the returns page. If you don’t know an answer, say so and offer to escalate.”',
        passScore: 70, maxAttempts: 4,
    },
    {
        type: STEP_TYPES.QUIZ, id: 'rp-quiz', icon: '❓',
        questionKey: 'learn.refining-prompt.quiz.q', questionFallback: 'An agent keeps answering off-topic and too casually. Where do you look first?',
        choices: [
            { id: 'a', labelFallback: 'The system prompt — tighten its role, tone and rules.', correct: true },
            { id: 'b', labelFallback: 'The agent’s avatar.', correct: false },
            { id: 'c', labelFallback: 'Delete it and start over.', correct: false },
        ],
        explanationFallback: 'Tone and scope live in the system prompt — make the role and rules more specific before anything else.',
    },
];

/* ── Lesson 5: Creating a skill (rich) ───────────────────────────────────── */
const SKILLS_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'sk-intro', icon: '🧩',
        titleKey: 'learn.creating-skills.intro.title', titleFallback: 'Package a reusable skill',
        bodyMdKey: 'learn.creating-skills.intro.body',
        bodyMdFallback: 'A **skill** is a repeatable workflow you teach once and reuse everywhere — attach it to any agent and it triggers when the task fits. A skill has four parts:\n\n- **Instructions** — what to do.\n- **Workflow** — the steps to follow.\n- **Rules** — the dos and don’ts.\n- **Examples** — what good output looks like.',
    },
    {
        id: 'sk-create', navigateTo: 'studio/skills', target: '[data-tour="skill-create"]',
        placement: 'bottom', optional: true, timeoutMs: 6000, icon: '➕',
        titleKey: 'learn.creating-skills.create.title', titleFallback: 'Start a new skill',
        bodyKey: 'learn.creating-skills.create.body',
        bodyFallback: 'This is the Skills library. Create a new skill to open the editor with its four sections.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'sk-attach', icon: '🔗',
        titleKey: 'learn.creating-skills.attach.title', titleFallback: 'Attach it to an agent',
        bodyMdKey: 'learn.creating-skills.attach.body',
        bodyMdFallback: 'Save the skill, then add it to an agent from the **Agent Designer**. From then on, the agent triggers the skill automatically whenever a task matches it — so your best workflow runs the same way every time.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'sk-quiz', icon: '❓',
        questionKey: 'learn.creating-skills.quiz.q', questionFallback: 'What’s the point of a skill?',
        choices: [
            { id: 'a', labelFallback: 'Teach a workflow once and reuse it across agents, consistently.', correct: true },
            { id: 'b', labelFallback: 'Make an agent reply in a different language.', correct: false },
            { id: 'c', labelFallback: 'Speed up the model.', correct: false },
        ],
        explanationFallback: 'A skill packages a repeatable workflow (instructions, steps, rules, examples) so any agent can run it the same way every time.',
    },
];

/* ── Lesson 6: Adding a knowledge base (rich: slides + live create + quiz) ── */
const KNOWLEDGE_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'kb-what', icon: '📚',
        titleKey: 'learn.knowledge-bases.what.title', titleFallback: 'Give agents your knowledge',
        bodyMdKey: 'learn.knowledge-bases.what.body',
        bodyMdFallback: 'Out of the box, an agent only knows general information. A **knowledge base** lets it answer from **your** content — PDFs, docs, spreadsheets — accurately and **with sources**.\n\nHow it works:\n1. Create a knowledge base and upload files.\n2. Bee Flow indexes them so the agent can search inside.\n3. Attach it to an agent under **Knowledge**.',
    },
    {
        id: 'kb-create', navigateTo: 'studio/knowledge', target: '[data-tour="knowledge-create"]',
        placement: 'bottom', optional: true, timeoutMs: 6000, icon: '⬆️',
        titleKey: 'learn.knowledge-bases.create.title', titleFallback: 'Create a knowledge base',
        bodyKey: 'learn.knowledge-bases.create.body',
        bodyFallback: 'Add a knowledge base and upload files — PDFs, docs, spreadsheets. Bee Flow indexes them so agents can search inside.',
    },
    {
        // v2: verified hands-on — a KB with a real document, checked live.
        type: STEP_TYPES.ACTION, id: 'kb-do', icon: '📚',
        checkId: 'kb-with-doc',
        titleKey: 'learn.knowledge-bases.do.title', titleFallback: 'Create one and feed it a document',
        instructionKey: 'learn.knowledge-bases.do.instruction',
        instructionFallback: 'Create a knowledge base and upload one real document — any PDF, doc or spreadsheet. The checklist below verifies your workspace as you go.',
        launch: { navigateTo: 'studio/knowledge', labelFallback: 'Open Knowledge' },
    },
    {
        type: STEP_TYPES.SLIDE, id: 'kb-attach', icon: '🔗',
        titleKey: 'learn.knowledge-bases.attach.title', titleFallback: 'Attach it, then ask away',
        bodyMdKey: 'learn.knowledge-bases.attach.body',
        bodyMdFallback: 'In the **Agent Designer → Knowledge**, attach your knowledge base. Now when you chat with the agent and ask about your content, it answers from your documents and **cites the source** it used.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'kb-quiz', icon: '❓',
        questionKey: 'learn.knowledge-bases.quiz.q', questionFallback: 'Why attach a knowledge base to an agent?',
        choices: [
            { id: 'a', labelFallback: 'So it answers from your own documents, with sources, instead of guessing.', correct: true },
            { id: 'b', labelFallback: 'To make the agent respond faster.', correct: false },
            { id: 'c', labelFallback: 'To change the agent’s name.', correct: false },
        ],
        explanationFallback: 'A knowledge base grounds the agent in your content, so answers are accurate and cite where they came from.',
    },
];

/* ── Lesson 7: Connecting integrations (rich) ────────────────────────────── */
const INTEGRATIONS_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'int-intro', icon: '🔌',
        titleKey: 'learn.connecting-integrations.intro.title', titleFallback: 'Connect your tools',
        bodyMdKey: 'learn.connecting-integrations.intro.body',
        bodyMdFallback: 'Link the apps your team already uses — **email, calendar, drive** and more — so agents can act on your behalf. Once a service is connected, any agent with the matching **tool** switched on can use it: read your calendar, send mail, search your drive.',
    },
    {
        id: 'int-card', navigateTo: 'settings/integrations', target: '[data-tour="integration-card"]',
        placement: 'top', optional: true, timeoutMs: 6000, icon: '🧩',
        titleKey: 'learn.connecting-integrations.card.title', titleFallback: 'Pick a service to connect',
        bodyKey: 'learn.connecting-integrations.card.body',
        bodyFallback: 'Choose a service and connect it securely. Once linked, agents with the matching tool enabled can use it.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'int-quiz', icon: '❓',
        questionKey: 'learn.connecting-integrations.quiz.q', questionFallback: 'After you connect an integration, what makes an agent able to use it?',
        choices: [
            { id: 'a', labelFallback: 'Switching on the matching tool for that agent in the Agent Designer.', correct: true },
            { id: 'b', labelFallback: 'Nothing — every agent uses it automatically.', correct: false },
            { id: 'c', labelFallback: 'Re-installing the app.', correct: false },
        ],
        explanationFallback: 'Connecting the service is step one; the agent also needs the matching tool enabled before it can act on it.',
    },
];

/* ── Lesson 8: Using memory (rich) ───────────────────────────────────────── */
const MEMORY_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'mem-intro', icon: '🧠',
        titleKey: 'learn.using-memory.intro.title', titleFallback: 'Let Bee Flow remember',
        bodyMdKey: 'learn.using-memory.intro.body',
        bodyMdFallback: 'Memory keeps useful **facts and preferences** across conversations, so you don’t repeat yourself every time. Mention something once — “I prefer concise replies”, “our company is called Acme” — and Bee Flow remembers it for next time. You’re always in control: every memory can be reviewed, edited, or removed.',
    },
    {
        id: 'mem-manage', navigateTo: 'settings/memory', target: '[data-tour="memory-manage"]',
        placement: 'top', optional: true, timeoutMs: 6000, icon: '🗃️',
        titleKey: 'learn.using-memory.manage.title', titleFallback: 'Review what’s remembered',
        bodyKey: 'learn.using-memory.manage.body',
        bodyFallback: 'Memories are saved automatically as you chat. Here you can review, edit, or remove anything — you’re always in control.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'mem-quiz', icon: '❓',
        questionKey: 'learn.using-memory.quiz.q', questionFallback: 'How do you get Bee Flow to remember a preference?',
        choices: [
            { id: 'a', labelFallback: 'Just mention it in chat — it’s saved automatically, and you can review it in settings.', correct: true },
            { id: 'b', labelFallback: 'You can’t — it forgets everything between chats.', correct: false },
            { id: 'c', labelFallback: 'Email support to add it manually.', correct: false },
        ],
        explanationFallback: 'Memory is automatic — mention a fact or preference and it persists across chats, fully under your control.',
    },
];

/* ── Lesson 9: Automations & routines (rich) ─────────────────────────────── */
const AUTOMATIONS_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'auto-intro', icon: '⏱️',
        titleKey: 'learn.automations.intro.title', titleFallback: 'Work that runs without you',
        bodyMdKey: 'learn.automations.intro.body',
        bodyMdFallback: 'An **automation** is a workflow that runs on its own: a **trigger** (a schedule, a webhook, an app event…) starts it, **steps** on a visual canvas do the work — integration actions, AI steps, conditions — and the result lands where you point it.\n\nYou don’t have to draw it yourself: **Build with AI** turns a plain-English description into a wired-up flow, shows you the diagram, and dry-runs it before anything goes live.',
    },
    {
        id: 'auto-create', navigateTo: 'studio/routines', target: '[data-tour="routine-create"]',
        placement: 'bottom', optional: true, timeoutMs: 6000, icon: '🗓️',
        titleKey: 'learn.automations.create.title', titleFallback: 'This is where automations live',
        bodyKey: 'learn.automations.create.body',
        bodyFallback: 'Studio → Automations. The + starts a new one, and in the builder you can describe it to the assistant instead of drawing it. The start screen also offers Find repeating work, ready-made Templates, and your run history.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'auto-quiz', icon: '❓',
        questionKey: 'learn.automations.quiz.q', questionFallback: 'What are the three parts every automation has?',
        choices: [
            { id: 'a', labelFallback: 'A trigger, steps on a canvas, and a result.', correct: true },
            { id: 'b', labelFallback: 'An agent, a chat, and a reply.', feedbackFallback: 'That’s a conversation. An automation runs unattended: a trigger starts it, steps do the work.', correct: false },
            { id: 'c', labelFallback: 'A form, a spreadsheet, and an email.', feedbackFallback: 'Those can all appear IN an automation — as its trigger or steps — but the skeleton is trigger → steps → result.', correct: false },
        ],
        explanationFallback: 'Trigger (when it runs) → steps (what it does) → result (where the outcome lands). The full Automate Your Week course goes deep on each.',
    },
];

/* ── Lesson 10: Usage & monitoring (admin, rich) ─────────────────────────── */
const ORG_USAGE_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'usage-intro', icon: '📊',
        titleKey: 'learn.org-usage.intro.title', titleFallback: 'Keep an eye on usage',
        bodyMdKey: 'learn.org-usage.intro.body',
        bodyMdFallback: 'As an admin you can see how your organisation uses Bee Flow — **activity** and where **spend** is going, broken down by source and model over any date range. The Workspace area also holds **Privacy Shield** and monitoring: your controls for PII handling and oversight.',
    },
    {
        id: 'usage-summary', navigateTo: 'settings/organisation/usage', target: '[data-tour="usage-summary"]',
        placement: 'bottom', optional: true, timeoutMs: 6000, icon: '📈',
        titleKey: 'learn.org-usage.summary.title', titleFallback: 'Usage at a glance',
        bodyKey: 'learn.org-usage.summary.body',
        bodyFallback: 'See activity and cost broken down by source and model, over the date range you choose.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'usage-quiz', icon: '❓',
        questionKey: 'learn.org-usage.quiz.q', questionFallback: 'Where do admins track activity, spend, and privacy controls?',
        choices: [
            { id: 'a', labelFallback: 'The Workspace area — usage by source/model plus Privacy Shield and monitoring.', correct: true },
            { id: 'b', labelFallback: 'Only by contacting support.', correct: false },
            { id: 'c', labelFallback: 'In each individual chat.', correct: false },
        ],
        explanationFallback: 'The org Workspace area surfaces usage and cost breakdowns alongside Privacy Shield and monitoring controls.',
    },
];

/* ════════════════════════════════════════════════════════════════════════════
 * Prompt Engineering course — five rich lessons (slides + quizzes + AI-graded
 * exercises). These use the extended step schema (see stepTypes.js): steps carry
 * a `type` of 'slide' | 'quiz' | 'exercise', plus optional 'tour' steps that hand
 * off to the live-app engine. Exercise steps reference a server-side rubric by
 * `exerciseId` (see server/learning/rubrics.js) — the rubric never ships to the
 * client. `passScore` gates the soft pass; `maxAttempts` enables skip-after-N.
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── Lesson: Anatomy of a great prompt ───────────────────────────────────── */
const PROMPT_BASICS_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'pb-anatomy', icon: '🧬',
        titleKey: 'learn.prompt-basics.anatomy.title', titleFallback: 'The anatomy of a great prompt',
        bodyMdKey: 'learn.prompt-basics.anatomy.body',
        bodyMdFallback: 'Almost every strong prompt has **three parts**:\n\n1. **Context** — who you are and what you’re working on.\n2. **A clear task** — exactly what you want done.\n3. **The output format** — how you want the answer back (bullets, a table, a tone, a length).\n\nMiss one and the model has to guess. Include all three and you steer the whole answer.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'pb-compare', icon: '⚖️',
        titleKey: 'learn.prompt-basics.compare.title', titleFallback: 'Vague in, vague out',
        bodyMdKey: 'learn.prompt-basics.compare.body',
        bodyMdFallback: '**Vague:** “write an email about the delay”\n\n**Specific:** “Draft a 3-sentence email to a customer apologising for a 2-day shipping delay, offering 10% off their next order, in a warm but professional tone.”\n\nThe second one names the audience, the task, the length, the offer and the tone — so there’s almost nothing left to guess.',
    },
    {
        // Diagnose before you write: spot WHAT each weak prompt is missing.
        type: STEP_TYPES.SIM, id: 'pb-sim', icon: '🔍',
        titleKey: 'learn.prompt-basics.sim.title', titleFallback: 'Diagnose the weak prompt',
        instructionKey: 'learn.prompt-basics.sim.instruction',
        instructionFallback: 'Each prompt on the left is missing exactly one ingredient. Match it to what’s missing.',
        sim: {
            kind: 'match',
            pairs: [
                { id: 'ctx', left: '“Write a launch announcement for the new feature.” (Which product? For whom?)', right: 'Missing: context', noteFallback: 'The model has no idea who is writing, about what product, for which audience.' },
                { id: 'task', left: '“Here’s our Q3 report and last year’s numbers. Thoughts?”', right: 'Missing: a clear task', noteFallback: 'Plenty of context — but “thoughts?” could mean summarise, compare, critique, forecast…' },
                { id: 'fmt', left: '“Compare our three pricing plans for the sales team.”', right: 'Missing: the output format', noteFallback: 'Task and audience are there — but a table? bullets? one paragraph? Say the shape you want.' },
            ],
        },
    },
    {
        type: STEP_TYPES.QUIZ, id: 'pb-q1', icon: '❓',
        questionKey: 'learn.prompt-basics.q1.q', questionFallback: 'Which prompt will reliably get the most useful first answer?',
        choices: [
            { id: 'a', labelFallback: '“Summarise this.”', feedbackFallback: 'The task is there, but no format and no audience — the model has to guess how long, how deep, for whom.', correct: false },
            { id: 'b', labelFallback: '“Summarise the report below into 5 bullet points a busy executive can read in 30 seconds.”', correct: true },
            { id: 'c', labelFallback: '“Can you help me with this report?”', feedbackFallback: '“Help” isn’t a task — summarise? rewrite? critique? The first ingredient of a strong prompt is a clear ask.', correct: false },
        ],
        explanationFallback: 'Option B names the task (summarise), the format (5 bullets) and the audience (a busy executive) — so the model knows exactly what “good” looks like.',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'pb-ex', exerciseId: 'ex-basics-specific', icon: '🎯',
        titleKey: 'learn.prompt-basics.ex.title', titleFallback: 'Your turn: make it specific',
        instructionKey: 'learn.prompt-basics.ex.instruction',
        instructionFallback: 'Rewrite this weak prompt into a strong one. Start from: “write something about our new feature.” Add context, a specific task, and the format you want back.',
        placeholderFallback: 'e.g. “You’re writing for our SaaS blog. Draft a 150-word announcement of our new dark-mode feature for existing users, in a friendly tone, ending with a one-line call to action.”',
        passScore: 70, maxAttempts: 4,
    },
];

/* ── Lesson: Give context ────────────────────────────────────────────────── */
const PROMPT_CONTEXT_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'pc-why', icon: '🧭',
        titleKey: 'learn.prompt-context.why.title', titleFallback: 'Context steers everything',
        bodyMdKey: 'learn.prompt-context.why.body',
        bodyMdFallback: 'The model doesn’t know your situation unless you tell it. A single sentence of context changes the entire answer.\n\nTry giving it:\n- **Your role** — “I run support for a SaaS company.”\n- **The audience** — “for non-technical small-business owners.”\n- **The goal** — “I want to reduce refund requests.”',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'pc-roles', icon: '🎭',
        titleKey: 'learn.prompt-context.roles.title', titleFallback: 'Set a role for the model too',
        bodyMdKey: 'learn.prompt-context.roles.body',
        bodyMdFallback: 'You can also tell the model **who to be**: “Act as a senior copywriter” or “You are a careful financial analyst.” A role primes its tone, vocabulary and level of caution — a fast way to raise the quality of the first draft.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'pc-q1', icon: '❓',
        questionKey: 'learn.prompt-context.q1.q', questionFallback: 'A prompt gives a generic, off-target answer. What’s the most likely fix?',
        choices: [
            { id: 'a', labelFallback: 'Add who you are, who it’s for, and what you’re trying to achieve.', correct: true },
            { id: 'b', labelFallback: 'Ask the exact same question again, but louder (ALL CAPS).', correct: false },
            { id: 'c', labelFallback: 'Make the prompt as short as possible.', correct: false },
        ],
        explanationFallback: 'Generic answers usually mean missing context. Telling the model your role, audience and goal is the highest-leverage fix.',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'pc-ex', exerciseId: 'ex-context-add', icon: '🎯',
        titleKey: 'learn.prompt-context.ex.title', titleFallback: 'Your turn: add the context',
        instructionKey: 'learn.prompt-context.ex.instruction',
        instructionFallback: 'Take the bare task “suggest three blog post ideas” and add real context — your role, your audience, and your goal — so the ideas come back genuinely on-target.',
        placeholderFallback: 'e.g. “I’m the marketing lead for a B2B accounting tool aimed at freelancers. Suggest three blog post ideas that would attract freelancers worried about tax season and nudge them to try our free trial.”',
        passScore: 70, maxAttempts: 4,
    },
];

/* ── Lesson: Structure & format ──────────────────────────────────────────── */
const PROMPT_STRUCTURE_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'pst-format', icon: '📐',
        titleKey: 'learn.prompt-structure.format.title', titleFallback: 'Ask for the shape you want',
        bodyMdKey: 'learn.prompt-structure.format.body',
        bodyMdFallback: 'Tell the model the **format** and you’ll rarely have to reformat by hand:\n\n- “Reply as a **table** with columns Name, Risk, Action.”\n- “Give me **exactly 5 bullets**, each under 12 words.”\n- “Answer in a **friendly, plain-English** tone.”\n- “Keep it under **100 words**.”',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'pst-delimit', icon: '🧱',
        titleKey: 'learn.prompt-structure.delimit.title', titleFallback: 'Separate instructions from content',
        bodyMdKey: 'learn.prompt-structure.delimit.body',
        bodyMdFallback: 'For longer prompts, keep your **instructions** and the **material** apart so the model never confuses them:\n\n```\nSummarise the text between the lines in 3 bullets.\n---\n<paste your text here>\n---\n```\n\nClear sections beat one long run-on paragraph every time.',
    },
    {
        // Constructing the layout beats reading about it.
        type: STEP_TYPES.SIM, id: 'pst-sim', icon: '🧩',
        titleKey: 'learn.prompt-structure.sim.title', titleFallback: 'Assemble the well-structured prompt',
        instructionKey: 'learn.prompt-structure.sim.instruction',
        instructionFallback: 'Put the five pieces of a long prompt into the order that keeps instructions and material cleanly apart.',
        sim: {
            kind: 'order',
            items: [
                { id: 'role', label: 'Context: “You’re our support lead writing for non-technical customers.”' },
                { id: 'task', label: 'The task: “Summarise the complaints in the text below.”' },
                { id: 'format', label: 'The format: “Exactly 3 bullets, each under 15 words, neutral tone.”' },
                { id: 'delim', label: 'A separator line: ---' },
                { id: 'material', label: 'The pasted material (the complaint emails)' },
            ],
            solution: ['role', 'task', 'format', 'delim', 'material'],
            feedbackFallback: 'Instructions first (context → task → format), then a separator, then the material — so the model never confuses your rules with the content it should process.',
        },
    },
    {
        type: STEP_TYPES.QUIZ, id: 'pst-q1', icon: '❓',
        questionKey: 'learn.prompt-structure.q1.q', questionFallback: 'You keep having to reformat the model’s answers by hand. Best first move?',
        choices: [
            { id: 'a', labelFallback: 'State the exact output format in the prompt (table / bullet count / length / tone).', correct: true },
            { id: 'b', labelFallback: 'Accept it — the model can’t follow formatting requests.', feedbackFallback: 'Models follow format instructions remarkably well — the usual problem is that nobody stated one.', correct: false },
            { id: 'c', labelFallback: 'Switch to a different app.', feedbackFallback: 'Same model, same behaviour, anywhere. The fix is in the prompt: state the structure, length and tone you want.', correct: false },
        ],
        explanationFallback: 'Models follow formatting instructions well — the trick is to actually state them: the structure, the length, and the tone.',
    },
    {
        // Optional "try it live" — opens the real chat composer. Marked optional so
        // a missing anchor degrades to a centered card and never blocks the lesson.
        type: STEP_TYPES.TOUR, id: 'pst-trylive', navigateTo: 'agents',
        target: '[data-tour="chat-composer"]', placement: 'top', optional: true, timeoutMs: 6000, icon: '⌨️',
        titleKey: 'learn.prompt-structure.trylive.title', titleFallback: 'This is where you ask',
        bodyKey: 'learn.prompt-structure.trylive.body',
        bodyFallback: 'This is the chat composer. After the lesson, paste a structured prompt here and watch how cleanly the answer comes back.',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'pst-ex', exerciseId: 'ex-structure-format', icon: '🎯',
        titleKey: 'learn.prompt-structure.ex.title', titleFallback: 'Your turn: specify the format',
        instructionKey: 'learn.prompt-structure.ex.instruction',
        instructionFallback: 'Write a prompt that asks the model to compare three project-management tools — and pin down the output format precisely (a table, named columns, a row limit, and a tone).',
        placeholderFallback: 'e.g. “Compare Asana, Trello and Linear for a 5-person startup. Reply as a table with columns Tool, Best for, Price, One catch. Keep each cell under 10 words and stay neutral.”',
        passScore: 70, maxAttempts: 4,
    },
];

/* ── Lesson: Iterate to perfection ───────────────────────────────────────── */
const PROMPT_ITERATING_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'pit-mindset', icon: '🔁',
        titleKey: 'learn.prompt-iterating.mindset.title', titleFallback: 'The first answer is a draft',
        bodyMdKey: 'learn.prompt-iterating.mindset.body',
        bodyMdFallback: 'Great results rarely come from the first prompt — they come from a quick **follow-up**. The model remembers the conversation, so you can steer with tiny nudges instead of rewriting from scratch.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'pit-moves', icon: '🛠️',
        titleKey: 'learn.prompt-iterating.moves.title', titleFallback: 'High-leverage follow-ups',
        bodyMdKey: 'learn.prompt-iterating.moves.body',
        bodyMdFallback: 'Keep a few refinements in your back pocket:\n\n- “Make it **shorter** / **more detailed**.”\n- “More **formal** / more **casual**.”\n- “Add a concrete **example**.”\n- “**Why** did you choose that? Now redo it avoiding X.”\n- “Give me **two more options**.”',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'pit-q1', icon: '❓',
        questionKey: 'learn.prompt-iterating.q1.q', questionFallback: 'The answer is 90% right but too long and a bit stiff. What do you do?',
        choices: [
            { id: 'a', labelFallback: 'Start a brand-new chat and rewrite the whole prompt.', correct: false },
            { id: 'b', labelFallback: 'Reply in the same chat: “Cut this to half the length and make the tone warmer.”', correct: true },
            { id: 'c', labelFallback: 'Give up and edit it all by hand.', correct: false },
        ],
        explanationFallback: 'A short follow-up in the same conversation is faster and keeps all the context — no need to start over.',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'pit-ex', exerciseId: 'ex-iterating-refine', icon: '🎯',
        titleKey: 'learn.prompt-iterating.ex.title', titleFallback: 'Your turn: write the follow-up',
        instructionKey: 'learn.prompt-iterating.ex.instruction',
        instructionFallback: 'Imagine the model just wrote a product description that’s accurate but generic, too long, and salesy. Write the single follow-up message you’d send to fix it — be specific about what to change.',
        placeholderFallback: 'e.g. “Cut this to 60 words, drop the hype words (‘revolutionary’, ‘game-changing’), lead with the one benefit a busy parent cares about, and end with a plain call to action.”',
        passScore: 70, maxAttempts: 4,
    },
];

/* ── Lesson: Advanced techniques ─────────────────────────────────────────── */
const PROMPT_ADVANCED_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'pad-fewshot', icon: '🧪',
        titleKey: 'learn.prompt-advanced.fewshot.title', titleFallback: 'Show, don’t just tell (few-shot)',
        bodyMdKey: 'learn.prompt-advanced.fewshot.body',
        bodyMdFallback: 'When you need a very specific style or pattern, give **one or two examples** of input → output. The model matches the pattern far more reliably than from a description alone.\n\n```\nTurn features into benefits. Examples:\n“256-bit encryption” → “Your data stays private.”\n“Offline mode” → “Works even with no signal.”\nNow do: “Auto-save every 5 seconds” →\n```',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'pad-reasoning', icon: '🪜',
        titleKey: 'learn.prompt-advanced.reasoning.title', titleFallback: 'Ask for a plan, then the work',
        bodyMdKey: 'learn.prompt-advanced.reasoning.body',
        bodyMdFallback: 'For anything multi-step, ask the model to **think first**: “Before answering, outline your approach in 3 steps, then carry it out.” You catch wrong assumptions early — and on big tasks, “give me the plan first, I’ll approve it” saves a lot of redo.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'pad-q1', icon: '❓',
        questionKey: 'learn.prompt-advanced.q1.q', questionFallback: 'You need outputs in a very particular format the model keeps missing. Most reliable technique?',
        choices: [
            { id: 'a', labelFallback: 'Include one or two worked examples of the exact input→output you want (few-shot).', correct: true },
            { id: 'b', labelFallback: 'Repeat “please use the right format” several times.', correct: false },
            { id: 'c', labelFallback: 'Make the temperature as high as possible.', correct: false },
        ],
        explanationFallback: 'A couple of concrete examples (few-shot prompting) pin down a pattern far better than describing it in words.',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'pad-ex', exerciseId: 'ex-advanced-technique', icon: '🎯',
        titleKey: 'learn.prompt-advanced.ex.title', titleFallback: 'Your turn: use an advanced technique',
        instructionKey: 'learn.prompt-advanced.ex.instruction',
        instructionFallback: 'Write a prompt that uses few-shot examples OR an explicit step-by-step plan to get a hard task right. Pick any task you like — just make the technique visible in your prompt.',
        placeholderFallback: 'e.g. “Classify each support message as Bug / Billing / How-to. Examples: ‘I was charged twice’ → Billing; ‘the app crashes on save’ → Bug. Now classify: …”',
        passScore: 70, maxAttempts: 4,
    },
];

/* ── Lesson: Anatomy of an automation (task-first: quiz → slides → sim) ───── */
const AUTOMATION_ANATOMY_STEPS = [
    {
        // Task-first: commit to a prediction before anything is explained.
        type: STEP_TYPES.QUIZ, id: 'aa-predict', icon: '🤔',
        questionKey: 'learn.automation-anatomy.predict.q',
        questionFallback: 'Every morning someone on your team pastes yesterday’s support tickets into a chat and asks for a summary. What’s the Bee Flow way to make that stop?',
        choices: [
            { id: 'a', labelFallback: 'An automation — a schedule trigger fetches the tickets, an AI step summarises, the result gets delivered.', correct: true },
            { id: 'b', labelFallback: 'A better prompt, saved somewhere handy.', feedbackFallback: 'A better prompt still needs a human to paste and send it every morning. The point of an automation is that NOBODY has to.', correct: false },
            { id: 'c', labelFallback: 'An agent with the tickets attached as knowledge.', feedbackFallback: 'An agent answers when someone asks. Nothing here asks by itself every morning — that’s exactly what a trigger is for.', correct: false },
        ],
        explanationFallback: 'Recurring work with no human in the loop = an automation: a trigger (every morning), steps (fetch → summarise), a result (delivered to the team).',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'aa-what', icon: '⚙️',
        titleKey: 'learn.automation-anatomy.what.title', titleFallback: 'What makes an automation',
        bodyMdKey: 'learn.automation-anatomy.what.body',
        bodyMdFallback: 'Every automation has the same skeleton:\n\n- **A trigger** — when it runs. The canvas literally starts with “**Start with a trigger**”.\n- **Steps** — what it does, drawn as connected nodes on a visual canvas.\n- **A result** — where the outcome lands: an email, a notification, a document, a table.\n\nAn automation is **DRAFT** while you build, **LIVE** once you activate it, **PAUSED** when you stop it. Activating needs a trigger and at least one step — the builder won’t let a half-flow go live.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'aa-triggers', icon: '⏰',
        titleKey: 'learn.automation-anatomy.triggers.title', titleFallback: 'Six kinds of trigger',
        bodyMdKey: 'learn.automation-anatomy.triggers.body',
        bodyMdFallback: 'These are the actual choices on the canvas:\n\n- **On a schedule** — a fixed time, over and over. Weekly digests, morning briefings.\n- **On webhook call** — an HTTP request from another system starts the flow the moment something happens there.\n- **On app event** — something happens in a connected app (a mail arrives, a file lands).\n- **On form submission** — publish a form; every submission runs the flow.\n- **Trigger manually** — run it from a button when you choose.\n- **When an agent calls it** — expose the flow as a tool an AI agent can use mid-chat.\n\nRule of thumb: doing it *every Monday* → schedule. *Waiting* for something to happen → webhook or app event.',
    },
    {
        // The interactive thing IS the question: classify real scenarios.
        type: STEP_TYPES.SIM, id: 'aa-sim-triggers', icon: '🎯',
        titleKey: 'learn.automation-anatomy.sim.title', titleFallback: 'Match the scenario to its trigger',
        instructionKey: 'learn.automation-anatomy.sim.instruction',
        instructionFallback: 'Tap a scenario on the left, then the trigger that fits on the right.',
        sim: {
            kind: 'match',
            pairs: [
                { id: 'schedule', left: 'A revenue digest every Friday at 16:00', right: 'On a schedule', noteFallback: 'Fixed, recurring moments are always a schedule.' },
                { id: 'webhook', left: 'Your payment provider reports a failed charge', right: 'On webhook call', noteFallback: 'External systems push the news the moment it happens — that’s a webhook.' },
                { id: 'app_event', left: 'An email with an invoice lands in the shared inbox', right: 'On app event', noteFallback: 'Something happening inside a connected app = an app event.' },
                { id: 'form', left: 'A customer fills in your intake questionnaire', right: 'On form submission', noteFallback: 'Publish a form and every submission carries its answers into the flow.' },
                { id: 'agent_call', left: 'Your support agent needs to look up an order mid-chat', right: 'When an agent calls it', noteFallback: 'A flow can be a TOOL — the agent decides when to call it.' },
            ],
        },
    },
    {
        type: STEP_TYPES.SLIDE, id: 'aa-steps', icon: '🧱',
        titleKey: 'learn.automation-anatomy.steps.title', titleFallback: 'The steps between trigger and result',
        bodyMdKey: 'learn.automation-anatomy.steps.body',
        bodyMdFallback: 'Between the trigger and the result you compose steps from the palette:\n\n- **AI step** — summarise, draft, classify, extract: the reasoning work.\n- **Actions** — your connected apps: send mail, create tasks, write files.\n- **Condition** — keep, split or branch on a rule (“only when the amount is above €500”).\n- **Repeat for each** — loop over a list, one item at a time.\n- **Ask someone to approve** — pause the run until a human decides.\n- **Privacy Shield** — detect and mask personal data before it travels further.\n\nPlus **Wait**, **Notification**, **Edit data**, **Call a web service**, **Make a document**, and more. Small steps chain into real workflows.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'aa-quiz-steps', icon: '❓',
        questionKey: 'learn.automation-anatomy.quiz-steps.q',
        questionFallback: 'Invoices over €500 need a human OK before they’re archived; smaller ones can go straight through. Which two steps make that happen?',
        choices: [
            { id: 'a', labelFallback: 'Condition + Ask someone to approve.', correct: true },
            { id: 'b', labelFallback: 'Wait + Notification.', feedbackFallback: 'Wait only delays; Notification only tells. Neither DECIDES (Condition) nor blocks for a human verdict (Ask someone to approve).', correct: false },
            { id: 'c', labelFallback: 'Two AI steps in a row.', feedbackFallback: 'AI can flag the big ones, but “a human must sign off” is exactly what Ask someone to approve exists for — the run pauses until they decide.', correct: false },
        ],
        explanationFallback: 'Condition splits the flow on the amount; Ask someone to approve pauses the expensive branch until a human decides.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'aa-dryrun', icon: '🧪',
        titleKey: 'learn.automation-anatomy.dryrun.title', titleFallback: 'Dry-run before you trust it',
        bodyMdKey: 'learn.automation-anatomy.dryrun.body',
        bodyMdFallback: 'The **Run flow ▾** menu gives you two very different buttons:\n\n- **Dry-run (preview)** — *“No real actions — safe preview.”* Watch every step execute with nothing sent, written, or changed.\n- **Run live** — *“Executes every step for real.”* It even asks you to confirm first.\n\nThe habit that separates pros from surprises: **dry-run until it looks right, activate, then check the Runs view after the first few real runs.** Treat a new automation like a new colleague — trust, but verify the first week.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'aa-quiz', icon: '❓',
        questionKey: 'learn.automation-anatomy.quiz.q', questionFallback: 'Your new automation sends payment reminders to real customers. What’s the right first run?',
        choices: [
            { id: 'a', labelFallback: 'A dry-run — watch each step’s output with no emails actually sent.', correct: true },
            { id: 'b', labelFallback: 'Run live — it’s the only way to know it really works.', feedbackFallback: 'A dry-run executes the same flow and shows each step’s output — WITHOUT emailing real customers a test by mistake.', correct: false },
            { id: 'c', labelFallback: 'Activate it and wait for the schedule.', feedbackFallback: 'Then your first test happens unattended, on real customers. Dry-run now, activate when the preview looks right.', correct: false },
        ],
        explanationFallback: 'Dry-run first, every time the steps have real-world side effects. Then activate and verify the first few runs in the Runs view.',
    },
];

/* ── Lesson: Meet the builder (tour of the real Automations studio) ────────── */
const AUTOMATION_BUILDER_TOUR_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'abt-intro', icon: '🗺️',
        titleKey: 'learn.automation-builder-tour.intro.title', titleFallback: 'Let’s walk the real thing',
        bodyMdKey: 'learn.automation-builder-tour.intro.body',
        bodyMdFallback: 'Concepts are done — time to see where the work happens. We’ll step into **Studio → Automations** and point at the real controls, so when you build one you already know the room.\n\nNothing in this walkthrough creates or changes anything.',
    },
    {
        id: 'abt-tabs', navigateTo: 'studio/routines', target: '[data-tour="automation-start-tabs"]',
        placement: 'bottom', requiresStudio: true, optional: true, timeoutMs: 8000, icon: '🚪',
        titleKey: 'learn.automation-builder-tour.tabs.title', titleFallback: 'Four ways in',
        bodyKey: 'learn.automation-builder-tour.tabs.body',
        bodyFallback: 'The start screen: All automations (your building blocks sit in the list beside it), Find repeating work (Bee Flow scans for candidates), Templates (pre-wired flows), and Runs (everything that happened). To describe one in plain language, press + and tell the builder’s assistant.',
    },
    {
        id: 'abt-create', target: '[data-tour="routine-create"]',
        placement: 'bottom', requiresStudio: true, optional: true, timeoutMs: 6000, icon: '➕',
        titleKey: 'learn.automation-builder-tour.create.title', titleFallback: 'Or start from a blank canvas',
        bodyKey: 'learn.automation-builder-tour.create.body',
        bodyFallback: 'The + opens a new automation. The canvas starts with “Choose a trigger”, and a ribbon of steps to add. The arrow next to + makes a building block instead.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'abt-views', icon: '🪟',
        titleKey: 'learn.automation-builder-tour.views.title', titleFallback: 'Inside the builder: four views',
        bodyMdKey: 'learn.automation-builder-tour.views.body',
        bodyMdFallback: 'Once an automation is open, the header switches between:\n\n- **Editor** — the canvas where you design the flow.\n- **Runs** — what happened each time it ran, step by step.\n- **Settings** — name, description, notifications.\n- **Saved versions** — earlier versions you can go back to.\n\nNext to them: **Run flow ▾** (dry-run or live) and the status pill — **DRAFT / LIVE / PAUSED** — with **Activate**. Activate stays disabled until the flow has a trigger and at least one step.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'abt-quiz', icon: '❓',
        questionKey: 'learn.automation-builder-tour.quiz.q',
        questionFallback: 'Your automation ran last night and you want to see exactly what each step did. Where do you look?',
        choices: [
            { id: 'a', labelFallback: 'The Runs view — every run, step by step, with each step’s output.', correct: true },
            { id: 'b', labelFallback: 'Settings.', feedbackFallback: 'Settings holds the name and notification choices — history lives in Runs.', correct: false },
            { id: 'c', labelFallback: 'Saved versions.', feedbackFallback: 'Versions are snapshots of the DESIGN over time. What a run actually DID lives in Runs.', correct: false },
        ],
        explanationFallback: 'Runs is the flight recorder: every execution, its status, and each step’s input and output.',
    },
];

/* ── Lesson: Assemble the flow (interactive canvas sim, ramped tasks) ──────── */

// Shared trigger options so every scenario shows the same real palette.
const SIM_TRIGGER_OPTIONS = [
    { id: 'manual', label: 'Trigger manually', desc: 'Run from a button click' },
    { id: 'form', label: 'On form submission', desc: 'Publish a form; every submission runs this' },
    { id: 'schedule', label: 'On a schedule', desc: 'Run at a fixed time, over and over' },
    { id: 'webhook', label: 'On webhook call', desc: 'Run when an HTTP request arrives' },
    { id: 'app_event', label: 'On app event', desc: 'Run when something happens in a connected app' },
];

const AUTOMATION_BUILD_SIM_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'abs-intro', icon: '🏗️',
        titleKey: 'learn.automation-build-sim.intro.title', titleFallback: 'You build the flows now',
        bodyMdKey: 'learn.automation-build-sim.intro.body',
        bodyMdFallback: 'Three briefs, exactly like requests a colleague would hand you. For each one: **pick the trigger, add the steps in order**, and check your flow. It mirrors the real canvas — trigger on top, steps chained below, result at the end.\n\nWrong guesses are free and each one tells you *why* — that’s the fastest way to learn this.',
    },
    {
        type: STEP_TYPES.SIM, id: 'abs-build', icon: '⚙️',
        titleKey: 'learn.automation-build-sim.build.title', titleFallback: 'Assemble each automation',
        instructionKey: 'learn.automation-build-sim.build.instruction',
        instructionFallback: 'Read the brief, pick the one right trigger, then tap steps into the rail in the order they should run.',
        sim: {
            kind: 'flow-build',
            scenarios: [
                {
                    id: 'digest',
                    briefFallback: '“Every Friday at 16:00, collect this week’s closed deals from the CRM, have AI write a 5-bullet summary, and email it to the sales channel.”',
                    trigger: {
                        options: SIM_TRIGGER_OPTIONS,
                        correct: 'schedule',
                        feedback: {
                            webhook: 'Nothing external calls in here — Friday 16:00 is the clock’s job. That’s a schedule.',
                            manual: 'Manual means someone must remember every Friday. The brief says it should just happen.',
                            app_event: 'No app event announces “it’s Friday afternoon” — a schedule does.',
                            form: 'Nobody submits a form here — the calendar starts this one.',
                        },
                    },
                    steps: {
                        palette: [
                            { id: 'fetch', label: 'Get this week’s closed deals (CRM)' },
                            { id: 'summarise', label: 'AI step: write a 5-bullet summary' },
                            { id: 'send', label: 'Send email to the sales channel' },
                            { id: 'approve', label: 'Ask someone to approve' },
                            { id: 'wait', label: 'Wait' },
                        ],
                        solution: ['fetch', 'summarise', 'send'],
                        feedback: {
                            approve: 'The brief doesn’t ask for a human sign-off — approval would stall the digest every week.',
                            wait: 'There’s nothing to wait for — the schedule already decides the moment.',
                        },
                    },
                },
                {
                    id: 'triage',
                    briefFallback: '“When a new support email arrives, have AI decide whether it’s urgent. Urgent ones should notify the on-call person; the rest becomes a task in the queue.”',
                    trigger: {
                        options: SIM_TRIGGER_OPTIONS,
                        correct: 'app_event',
                        feedback: {
                            schedule: 'A schedule would batch-check the inbox. The brief says WHEN a mail arrives — react to the event itself.',
                            manual: '“When a new email arrives” can happen at 3 AM — nobody is there to press a button.',
                            form: 'The customer sends an email, not a form. The connected inbox raises the event.',
                            webhook: 'Close — but the mailbox is a connected app, so its events arrive as app events, no webhook plumbing needed.',
                        },
                    },
                    steps: {
                        palette: [
                            { id: 'classify', label: 'AI step: is this urgent?' },
                            { id: 'condition', label: 'Condition: split urgent / normal' },
                            { id: 'notify', label: 'Notify the on-call person' },
                            { id: 'task', label: 'Create a task in the queue' },
                            { id: 'document', label: 'Make a document' },
                        ],
                        solution: ['classify', 'condition', 'notify', 'task'],
                        feedback: {
                            document: 'Nobody asked for a document — the outputs here are a notification and a task.',
                        },
                    },
                },
                {
                    id: 'invoice',
                    briefFallback: '“When our intake form is submitted with an invoice, extract the amount and supplier with AI. A human must approve it, and only then is it archived to the drive — and finance gets notified.”',
                    trigger: {
                        options: SIM_TRIGGER_OPTIONS,
                        correct: 'form',
                        feedback: {
                            schedule: 'Submissions arrive whenever suppliers send them — reacting per submission beats checking on a clock.',
                            app_event: 'The brief names OUR intake form — form submissions carry their answers straight into the flow.',
                            webhook: 'A webhook could work if another system posted it — but this is Bee Flow’s own form, which is its own trigger.',
                            manual: '“When the form is submitted” is the moment — no button-pressing involved.',
                        },
                    },
                    steps: {
                        palette: [
                            { id: 'extract', label: 'AI step: extract amount + supplier' },
                            { id: 'approve', label: 'Ask someone to approve' },
                            { id: 'archive', label: 'Archive the invoice to the drive' },
                            { id: 'notify', label: 'Notify finance' },
                            { id: 'repeat', label: 'Repeat for each' },
                        ],
                        solution: ['extract', 'approve', 'archive', 'notify'],
                        feedback: {
                            repeat: 'One submission = one invoice — there’s no list to loop over.',
                        },
                    },
                },
            ],
        },
    },
    {
        type: STEP_TYPES.QUIZ, id: 'abs-quiz', icon: '❓',
        questionKey: 'learn.automation-build-sim.quiz.q',
        questionFallback: 'In the invoice flow, why does “Ask someone to approve” sit BEFORE the archive step, not after?',
        choices: [
            { id: 'a', labelFallback: 'The run pauses at approval — steps after it only happen once the human says yes.', correct: true },
            { id: 'b', labelFallback: 'Order doesn’t matter, the canvas just looks tidier.', feedbackFallback: 'Order is the whole game: steps run top to bottom, and approval PAUSES the run. After the archive step, the invoice would already be archived — approved or not.', correct: false },
            { id: 'c', labelFallback: 'Approval steps must always be the second step.', feedbackFallback: 'There’s no fixed position — approval goes exactly before the actions it must protect.', correct: false },
        ],
        explanationFallback: 'Steps run in order, and an approval blocks everything after it until a human decides — so it must sit before the actions it guards.',
    },
];

/* ── Lesson: Build one for real (verified hands-on challenge) ──────────────── */
const AUTOMATION_HANDS_ON_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'aho-brief', icon: '🎓',
        titleKey: 'learn.automation-hands-on.brief.title', titleFallback: 'Your mission: a real automation',
        bodyMdKey: 'learn.automation-hands-on.brief.body',
        bodyMdFallback: 'Time to build one that actually exists when you’re done. Any idea works — start tiny:\n\n- a **weekly digest** of anything you track,\n- a **daily reminder** with an AI-written summary,\n- or open **Templates** and adapt a pre-wired flow.\n\nEasiest path: press **+**, open the **Assistant** beside the canvas and describe the trigger and what should happen, in your own words. Then **dry-run it** from the Run flow ▾ menu.\n\nThis step verifies your real workspace: the checklist below ticks itself as you go, and anything you’ve already built counts immediately.',
    },
    {
        type: STEP_TYPES.ACTION, id: 'aho-do', icon: '🏗️',
        checkId: 'automation-first',
        titleKey: 'learn.automation-hands-on.do.title', titleFallback: 'Build it — we’ll verify it',
        instructionKey: 'learn.automation-hands-on.do.instruction',
        instructionFallback: 'Open the Automations studio and build your flow. Use the minimize button (–) up top to tuck this lesson away while you work — it keeps checking in the corner.',
        launch: { navigateTo: 'studio/routines', labelFallback: 'Open Automations' },
    },
    {
        type: STEP_TYPES.SLIDE, id: 'aho-next', icon: '🚀',
        titleKey: 'learn.automation-hands-on.next.title', titleFallback: 'From dry-run to trusted',
        bodyMdKey: 'learn.automation-hands-on.next.body',
        bodyMdFallback: 'You’ve built and previewed a real flow. The rest of the road:\n\n1. **Activate** when the dry-run looks right — the pill flips to **LIVE**.\n2. **Check the Runs view** after the first few real runs — treat it like reviewing a new colleague’s first week.\n3. **Iterate fearlessly** — every save is a version you can roll back in **Saved versions**, and you can **Pause** anytime.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'aho-quiz', icon: '❓',
        questionKey: 'learn.automation-hands-on.quiz.q',
        questionFallback: 'You changed a live automation and want yesterday’s working design back. What saves you?',
        choices: [
            { id: 'a', labelFallback: 'Saved versions — restore an earlier version of the flow.', correct: true },
            { id: 'b', labelFallback: 'Nothing — changes to live automations are final.', feedbackFallback: 'Every save is kept: Saved versions lets you compare and restore earlier designs.', correct: false },
            { id: 'c', labelFallback: 'Delete it and rebuild from memory.', feedbackFallback: 'No need — Saved versions keeps the history so you can go back instead of rebuilding.', correct: false },
        ],
        explanationFallback: 'Saved versions is the undo across sessions: earlier versions of the routine you can inspect and restore.',
    },
];

/* ── Lesson: Design your own automation (rich: slide + AI-coached exercise) ── */
const AUTOMATION_PRACTICE_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'ap-brief', icon: '📝',
        titleKey: 'learn.automation-practice.brief.title', titleFallback: 'A good brief beats a good diagram',
        bodyMdKey: 'learn.automation-practice.brief.body',
        bodyMdFallback: 'Because you build automations by describing them, the quality of your description IS the quality of your automation. A strong brief names:\n\n- **The trigger** — when should it run?\n- **The source** — what data does it read?\n- **The work** — what should happen with it (including any conditions)?\n- **The destination** — where does the result go, and who is told?\n\nWeak: “automate my reports”. Strong: “Every Friday at 16:00, collect this week’s closed deals from the CRM, have AI write a 5-bullet summary, and email it to the sales channel.”',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'ap-ex', exerciseId: 'ex-automation-brief', icon: '🎯',
        titleKey: 'learn.automation-practice.ex.title', titleFallback: 'Your turn: brief an automation',
        instructionKey: 'learn.automation-practice.ex.instruction',
        instructionFallback: 'Describe an automation you would actually use, in plain English. Include when it should run (the trigger), what data it works with, what should happen, and where the result should go.',
        placeholderFallback: 'e.g. “Every weekday at 08:30, read yesterday’s new entries from our feedback form, group them by theme, have AI draft a short digest with the top 3 issues, and post it to the product channel. Skip the digest when there are no new entries.”',
        passScore: 70, maxAttempts: 4,
    },
    {
        // Debugging is a skill of its own — drill the order of operations.
        type: STEP_TYPES.SIM, id: 'ap-debug', icon: '🩺',
        titleKey: 'learn.automation-practice.debug.title', titleFallback: 'A live run just failed — what’s your play?',
        instructionKey: 'learn.automation-practice.debug.instruction',
        instructionFallback: 'Put the debugging moves in the order a pro would make them.',
        sim: {
            kind: 'order',
            items: [
                { id: 'runs', label: 'Open the Runs view and find the failed run' },
                { id: 'step', label: 'See which step errored and read its input/output' },
                { id: 'fix', label: 'Fix that step on the canvas' },
                { id: 'dryrun', label: 'Dry-run to confirm the fix' },
                { id: 'live', label: 'Let it run live again' },
            ],
            solution: ['runs', 'step', 'fix', 'dryrun', 'live'],
            feedbackFallback: 'Diagnose before you touch anything: Runs shows WHICH step failed and on what data. Fix, prove it with a dry-run, then trust it live again.',
        },
    },
    {
        type: STEP_TYPES.QUIZ, id: 'ap-quiz', icon: '❓',
        questionKey: 'learn.automation-practice.quiz.q', questionFallback: 'Your new automation ran for the first time last night. What’s the right next step?',
        choices: [
            { id: 'a', labelFallback: 'Check its run history to confirm it did what you expected.', correct: true },
            { id: 'b', labelFallback: 'Nothing — automations never need checking.', correct: false },
            { id: 'c', labelFallback: 'Delete and rebuild it to be safe.', correct: false },
        ],
        explanationFallback: 'Run history shows exactly what each run did. Verify the first few runs of any new automation before relying on it.',
    },
];

/* ════════════════════════════════════════════════════════════════════════════
 * Cowork course — three lessons for the "describe it once, it runs on its own"
 * surface: what it is (with a live tour), writing briefs the composer can
 * schedule (AI-graded), and a verified hands-on first cowork.
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── Lesson: Meet Cowork ──────────────────────────────────────────────────── */
const COWORK_BASICS_STEPS = [
    {
        // Task-first: pick the right tool before Cowork is explained.
        type: STEP_TYPES.QUIZ, id: 'cwb-predict', icon: '🤔',
        questionKey: 'learn.cowork-basics.predict.q',
        questionFallback: 'You want a competitor round-up waiting for you every Monday morning — without asking for it each week. Which surface is built for that?',
        choices: [
            { id: 'a', labelFallback: 'Cowork — describe it once, and it runs on its own every week.', correct: true },
            { id: 'b', labelFallback: 'Chat — just ask again every Monday.', feedbackFallback: 'Chat answers when YOU show up. The whole point here is that the work happens without you — that’s Cowork.', correct: false },
            { id: 'c', labelFallback: 'Memory — Bee Flow will remember to do it.', feedbackFallback: 'Memory keeps facts and preferences; it never runs work by itself. Running unattended work is exactly Cowork’s job.', correct: false },
        ],
        explanationFallback: 'Recurring or later-scheduled work you describe once = Cowork. It runs unattended and reports back to your notifications.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'cwb-what', icon: '🤝',
        titleKey: 'learn.cowork-basics.what.title', titleFallback: 'A colleague, not a chat',
        bodyMdKey: 'learn.cowork-basics.what.body',
        bodyMdFallback: '**Cowork** is where you hand work over instead of talking it through:\n\n> *“What can Bee Flow take off your plate? Describe it once. It runs on its own — now, later, or every week.”*\n\nOne message is the whole setup. Bee Flow reads your brief, gives it a title and a schedule, runs it unattended — **now, at a moment you pick, or on a repeat** — and the result lands in your **notifications**.\n\nThe mental model: **Chat** answers you here, in the conversation. **Cowork** goes away and does the work.',
    },
    {
        id: 'cwb-nav', target: '[data-tour="nav-cowork"]', placement: 'right',
        ensureSidebarOpen: true, optional: true, timeoutMs: 6000, icon: '🧭',
        titleKey: 'learn.cowork-basics.nav.title', titleFallback: 'Cowork lives right under New Chat',
        bodyKey: 'learn.cowork-basics.nav.body',
        bodyFallback: 'The badge counts what’s currently running or scheduled. Let’s open it.',
    },
    {
        id: 'cwb-composer', navigateTo: 'cowork', target: '[data-tour="cowork-composer"]',
        placement: 'top', optional: true, timeoutMs: 8000, icon: '📝',
        titleKey: 'learn.cowork-basics.composer.title', titleFallback: 'One box is the whole setup',
        bodyKey: 'learn.cowork-basics.composer.body',
        bodyFallback: 'Describe the work here — “Bee Flow runs it and reports back.” The button reads Run when it starts now, Schedule when it starts later.',
    },
    {
        id: 'cwb-chips', target: '[data-tour="cowork-options"]', placement: 'top',
        optional: true, timeoutMs: 6000, icon: '🎛️',
        titleKey: 'learn.cowork-basics.chips.title', titleFallback: 'Three chips steer everything',
        bodyKey: 'learn.cowork-basics.chips.body',
        bodyFallback: 'When (now, tonight, next Monday, a moment you pick) · Repeat (once, every day, every weekday, …) · and who runs it — plain Bee Flow or one of your agents.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'cwb-chips-detail', icon: '🎛️',
        titleKey: 'learn.cowork-basics.chips-detail.title', titleFallback: 'The chips, precisely',
        bodyMdKey: 'learn.cowork-basics.chips-detail.body',
        bodyMdFallback: '- **When** — *Run now*, *In an hour*, *Tonight*, *Tomorrow morning*, *Next Monday*, or *Pick a moment…* with a date and time.\n- **Repeat** — *Once* up to *Every year*, including the workhorse: **Every weekday**. Repeating work keeps running until you pause it.\n- **Run as agent** — an agent brings its own skills, knowledge and connected apps to the job. No agent = a plain prompt run.\n\nOne rule to remember: **a chip you set always wins** over whatever the AI reads from your brief. The AI fills in blanks — it never overrules you.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'cwb-quiz', icon: '❓',
        questionKey: 'learn.cowork-basics.quiz.q',
        questionFallback: 'A cowork ran while you were in a meeting. Where is the result?',
        choices: [
            { id: 'a', labelFallback: 'In your notifications — and the full run history sits on the item in Cowork.', correct: true },
            { id: 'b', labelFallback: 'It waits in an open chat window.', feedbackFallback: 'Cowork doesn’t need a chat open — it runs unattended and delivers to your notifications, with history kept on the item.', correct: false },
            { id: 'c', labelFallback: 'It’s emailed to your manager.', feedbackFallback: 'Results go to YOU: the notification center, plus the item’s own run history in Cowork.', correct: false },
        ],
        explanationFallback: 'Every run delivers to your notification center, and each cowork item keeps its full run history — open it anytime.',
    },
];

/* ── Lesson: Briefs that schedule themselves (AI-graded) ──────────────────── */
const COWORK_BRIEFS_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'cwr-compose', icon: '🪄',
        titleKey: 'learn.cowork-briefs.compose.title', titleFallback: 'Your words become the schedule',
        bodyMdKey: 'learn.cowork-briefs.compose.body',
        bodyMdFallback: 'When you send a brief, Bee Flow’s composer reads it and derives the setup for you:\n\n- **a title** — so the list stays scannable,\n- **the schedule** — “every weekday at 8:30” or “tomorrow morning” straight from your words (*morning* = 08:00, *tonight* = 18:00),\n- **the agent** — but only when your brief actually names one.\n\nAnd the golden rule from last lesson still holds: **any chip you set yourself wins**. Say “every Friday” in the brief but click *Once* — it runs once.',
    },
    {
        type: STEP_TYPES.SIM, id: 'cwr-sim', icon: '🎯',
        titleKey: 'learn.cowork-briefs.sim.title', titleFallback: 'What will this brief do?',
        instructionKey: 'learn.cowork-briefs.sim.instruction',
        instructionFallback: 'Match each brief to what Cowork will actually set up.',
        sim: {
            kind: 'match',
            pairs: [
                { id: 'now', left: '“Summarise this quarter’s churn numbers.”', right: 'Runs once, right now', noteFallback: 'No timing words at all → it just runs, and the result lands in your notifications.' },
                { id: 'weekday', left: '“Every weekday at 8:30, digest yesterday’s support tickets.”', right: 'Repeats Mon–Fri at 08:30', noteFallback: '“Every weekday” + a time is everything the composer needs for a repeating schedule.' },
                { id: 'tonight', left: '“Tonight, draft the follow-up mail for today’s demo calls.”', right: 'Runs once at 18:00 today', noteFallback: 'Vague times map to sensible moments — “tonight” means 18:00.' },
                { id: 'agent', left: '“Have the Support agent triage the new tickets every morning.”', right: 'Repeats daily, run by the Support agent', noteFallback: 'Naming an agent in the brief hands the job to that agent — with its skills and apps.' },
            ],
        },
    },
    {
        type: STEP_TYPES.SLIDE, id: 'cwr-good', icon: '✍️',
        titleKey: 'learn.cowork-briefs.good.title', titleFallback: 'What makes a brief good',
        bodyMdKey: 'learn.cowork-briefs.good.body',
        bodyMdFallback: 'The test: **could a colleague run with this while you’re offline?** You won’t be there to answer follow-up questions. A strong brief names:\n\n1. **The work** — what should actually be produced. *“A 5-bullet digest of new feedback”*, not *“look at feedback”*.\n2. **The detail that makes it useful** — what to focus on, include, or skip.\n3. **The timing** — when, or how often.\n\n**Weak:** “keep an eye on our competitors” — on what? how often? what counts as news?\n**Strong:** “Every Monday at 9:00, check our three main competitors’ pricing pages and changelogs, and give me the changes since last week in 5 bullets — say ‘no changes’ if there are none.”',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'cwr-ex', exerciseId: 'ex-cowork-brief', icon: '🎯',
        titleKey: 'learn.cowork-briefs.ex.title', titleFallback: 'Your turn: write the brief',
        instructionKey: 'learn.cowork-briefs.ex.instruction',
        instructionFallback: 'Write a real cowork brief — something you’d genuinely hand over. Name the work, the detail that makes the result useful, and when (or how often) it should run.',
        placeholderFallback: 'e.g. “Every Friday at 15:00, go through this week’s closed support tickets, pull out the top 3 recurring problems with a one-line example each, and note anything customers threatened to churn over.”',
        passScore: 70, maxAttempts: 4,
    },
    {
        type: STEP_TYPES.QUIZ, id: 'cwr-quiz', icon: '❓',
        questionKey: 'learn.cowork-briefs.quiz.q',
        questionFallback: 'Your brief says “every Friday”, but you set the Repeat chip to Once. What happens?',
        choices: [
            { id: 'a', labelFallback: 'It runs once — a chip you set always beats what the AI reads from the brief.', correct: true },
            { id: 'b', labelFallback: 'It repeats every Friday — the brief is the boss.', feedbackFallback: 'Other way round: the AI only fills in what you left open. A chip you touched is YOUR decision, and it wins.', correct: false },
            { id: 'c', labelFallback: 'It refuses to run until the conflict is resolved.', feedbackFallback: 'No conflict dialogs — your chip simply wins and the brief’s timing words are ignored.', correct: false },
        ],
        explanationFallback: 'Chips you set are decisions; the brief is context. The AI fills in the blanks and never overrules you.',
    },
];

/* ── Lesson: Your first cowork (verified hands-on) ────────────────────────── */
const COWORK_HANDS_ON_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'cwh-brief', icon: '🎓',
        titleKey: 'learn.cowork-hands-on.brief.title', titleFallback: 'Hand something over for real',
        bodyMdKey: 'learn.cowork-hands-on.brief.body',
        bodyMdFallback: 'Pick something small you actually want done — the brief you wrote last lesson is perfect. Ideas:\n\n- a **summary** of anything you’d otherwise compile by hand,\n- a **draft** you write every week anyway,\n- a **check** on something you keep forgetting to check.\n\nLeave **When** on *Run now* so it runs immediately and you can watch the result arrive. The checklist below verifies your real Cowork list — and anything you’ve already created counts.',
    },
    {
        type: STEP_TYPES.ACTION, id: 'cwh-do', icon: '🤝',
        checkId: 'cowork-first',
        titleKey: 'learn.cowork-hands-on.do.title', titleFallback: 'Create it — we’ll verify it',
        instructionKey: 'learn.cowork-hands-on.do.instruction',
        instructionFallback: 'Open Cowork, describe the work, and send it. Use the minimize button (–) up top to tuck this lesson away while you work — it keeps checking in the corner.',
        launch: { navigateTo: 'cowork', labelFallback: 'Open Cowork' },
    },
    {
        type: STEP_TYPES.SLIDE, id: 'cwh-manage', icon: '🗂️',
        titleKey: 'learn.cowork-hands-on.manage.title', titleFallback: 'Running the stable',
        bodyMdKey: 'learn.cowork-hands-on.manage.body',
        bodyMdFallback: 'Open any item in the list and you’re in control:\n\n- **Run now** — fire it on demand, whatever its schedule.\n- **Pause / Resume** — repeating work keeps running until you pause it.\n- **Edit** — reword the instruction, move the schedule, change which apps it may use.\n- **History** — every run, with *run by you* vs *on schedule*, duration, and the full result.\n\nTwo more things worth knowing: the **Chat ⇄ Cowork switch** in any chat header turns a conversation into a cowork on the spot, and there’s a **slot limit** (10 by default) — finish or delete old ones to make room.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'cwh-quiz', icon: '❓',
        questionKey: 'learn.cowork-hands-on.quiz.q',
        questionFallback: 'Your weekly cowork produced a mediocre result this morning. What’s the strongest fix?',
        choices: [
            { id: 'a', labelFallback: 'Edit the item: sharpen the instruction with what was missing, then Run now to test it.', correct: true },
            { id: 'b', labelFallback: 'Delete it and swear off automation.', feedbackFallback: 'The brief just needs sharpening — Edit the instruction, Run now to test, and the next scheduled run inherits the fix.', correct: false },
            { id: 'c', labelFallback: 'Wait a week and hope Monday’s run is better.', feedbackFallback: 'Nothing improves on its own — Edit with the missing detail and prove it with Run now, today.', correct: false },
        ],
        explanationFallback: 'Edit is the feedback loop: sharpen the instruction, test immediately with Run now, and every future run benefits.',
    },
];

/* ── Lesson: Users, groups & access (admin, rich: slides + quiz) ──────────── */
const ADMIN_ACCESS_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'ac-roles', icon: '🛡️',
        titleKey: 'learn.admin-access.roles.title', titleFallback: 'Who can do what',
        bodyMdKey: 'learn.admin-access.roles.body',
        bodyMdFallback: 'Access in Bee Flow has three layers:\n\n- **Org role** — *admin* runs the organisation (users, plan, settings); *member* uses the workspace.\n- **Groups** — collect people by team or function. Permissions and feature access attach to groups, not individuals.\n- **Permissions** — fine-grained abilities (manage agents, manage knowledge, see monitoring…), granted through groups.\n\nManage all of this in **Settings → Organisation → Users & Groups**.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'ac-grants', icon: '✅',
        titleKey: 'learn.admin-access.grants.title', titleFallback: 'Grants only add — they never take away',
        bodyMdKey: 'learn.admin-access.grants.body',
        bodyMdFallback: 'Bee Flow’s access model is **grant-only**: a group grant can give its members *more* than the org default, never less. A user’s effective access is the org baseline **plus** everything their groups grant — capped by what the subscription plan includes.\n\nPractical pattern: keep the org default modest, then create groups like *Builders* (manage agents & knowledge) or *Ops* (monitoring) and add people to the group that matches their job.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'ac-quiz', icon: '❓',
        questionKey: 'learn.admin-access.quiz.q', questionFallback: 'A member needs to build agents, but the org default doesn’t allow it. What’s the right move?',
        choices: [
            { id: 'a', labelFallback: 'Add them to a group that grants agent-building permissions.', correct: true },
            { id: 'b', labelFallback: 'Make them an org admin.', correct: false },
            { id: 'c', labelFallback: 'Share an admin’s login with them.', correct: false },
        ],
        explanationFallback: 'Grants flow through groups — give the smallest grant that does the job. Org admin is for running the organisation, not for building agents.',
    },
];

/* ── Lesson: Running a healthy hive (admin, rich: slides + quiz + exercise) ── */
const ADMIN_GOVERNANCE_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'ag-watch', icon: '📊',
        titleKey: 'learn.admin-governance.watch.title', titleFallback: 'Watch usage before it surprises you',
        bodyMdKey: 'learn.admin-governance.watch.body',
        bodyMdFallback: '**Settings → Organisation → Usage & Monitoring** shows what your organisation actually consumes: requests, tokens and cost per user and per agent over time.\n\nMake it a habit:\n- Skim it **weekly** — spikes usually mean a runaway automation or an unusually heavy workflow.\n- Compare **per-user** numbers — wildly uneven usage is a coaching opportunity, not a policing one.\n- Check it **after enabling something new** — a new integration or beta feature shows up here first.',
    },
    {
        type: STEP_TYPES.SLIDE, id: 'ag-rollout', icon: '🚀',
        titleKey: 'learn.admin-governance.rollout.title', titleFallback: 'Roll out features deliberately',
        bodyMdKey: 'learn.admin-governance.rollout.body',
        bodyMdFallback: 'New capabilities (beta features, integrations) are enabled per organisation and granted to groups — which means you can roll out gradually:\n\n1. **Pilot** — enable for one small group; ask them to use it for a week.\n2. **Review** — check usage and ask the pilots what worked.\n3. **Broaden** — grant the next groups, with a one-line “what this is for” note.\n\nThe Academy helps here too: point new users at the Learning Center courses, and track who completed what in the **Academy** tab.',
    },
    {
        type: STEP_TYPES.QUIZ, id: 'ag-quiz', icon: '❓',
        questionKey: 'learn.admin-governance.quiz.q', questionFallback: 'Token usage doubled this week. What’s the best first step?',
        choices: [
            { id: 'a', labelFallback: 'Open Usage & Monitoring and find which user or agent changed.', correct: true },
            { id: 'b', labelFallback: 'Disable AI for the whole organisation.', correct: false },
            { id: 'c', labelFallback: 'Ignore it — costs even out eventually.', correct: false },
        ],
        explanationFallback: 'Diagnose before acting: per-user and per-agent breakdowns usually point straight at the source — often a new automation doing more than intended.',
    },
    {
        type: STEP_TYPES.EXERCISE, id: 'ag-ex', exerciseId: 'ex-admin-rollout', icon: '🎯',
        titleKey: 'learn.admin-governance.ex.title', titleFallback: 'Your turn: plan a rollout',
        instructionKey: 'learn.admin-governance.ex.instruction',
        instructionFallback: 'Write a short rollout plan for introducing a new Bee Flow capability (pick any — e.g. automations or a new integration) to your organisation. Name who pilots it first, how you’ll check it’s working, and how you’ll expand from there.',
        placeholderFallback: 'e.g. “Week 1: enable automations for the 4-person ops team; they each build one real automation. Week 2: review their run history and usage in monitoring, collect feedback in a 30-minute call. Week 3: grant the support and sales groups, share the two best automations as examples, and point newcomers at the Academy course.”',
        passScore: 70, maxAttempts: 4,
    },
];

/* ── Capstone: the Hive Master challenge (v2) ────────────────────────────────
 * Trailhead-superbadge style: business requirements only, no step-by-step. The
 * single action step verifies real artifacts across features via the composite
 * 'hive-master' check; criteria the learner can't satisfy (permissions/plan)
 * are gated out per-criterion in actionChecks.js.
 * ──────────────────────────────────────────────────────────────────────────── */
const HIVE_MASTER_STEPS = [
    {
        type: STEP_TYPES.SLIDE, id: 'hm-brief', icon: '👑',
        titleKey: 'learn.hive-master.brief.title', titleFallback: 'The requirements — the how is yours',
        bodyMdKey: 'learn.hive-master.brief.body',
        bodyMdFallback: 'No walkthrough this time. Earn **Hive Master** by having these exist, for real, in your workspace:\n\n1. **An automation on a schedule that has actually run** — any subject; a dry-run counts.\n2. **A cowork item working for you** — something you genuinely delegated.\n3. **A builder artifact** — an agent of your own, *or* a knowledge base with at least one document *(skipped automatically if your role can’t build these)*.\n\nEverything you’ve already built counts. Use any course, template, or **Ask AI** — real work is the exam.',
    },
    {
        type: STEP_TYPES.ACTION, id: 'hm-do', icon: '🏆',
        checkId: 'hive-master',
        titleKey: 'learn.hive-master.do.title', titleFallback: 'Prove it',
        instructionKey: 'learn.hive-master.do.instruction',
        instructionFallback: 'The checklist verifies your real workspace and updates as you build. Dock or minimize this lesson and go make things exist.',
        launch: { navigateTo: 'studio/routines', labelFallback: 'Open Automations' },
    },
    {
        type: STEP_TYPES.SLIDE, id: 'hm-done', icon: '🐝',
        titleKey: 'learn.hive-master.done.title', titleFallback: 'You run a working hive',
        bodyMdKey: 'learn.hive-master.done.body',
        bodyMdFallback: 'That wasn’t a quiz — those are **real, running things** that keep working after this lesson closes. Keep the habit:\n\n- check **run history** the way you’d check on a new colleague,\n- **pause** anything you stop trusting, and\n- when something repeats twice, **automate or delegate it** the same day.',
    },
];

/* ── The catalog ─────────────────────────────────────────────────────────────
 * NOTE: the `gate` fields and the full id list are mirrored server-side in
 * server/learning/courseCatalog.js (LESSON_GATES / LESSON_IDS) so the server can
 * compute completion against the lessons a user can actually see. Keep both in
 * lockstep when adding or re-gating a lesson.
 * ──────────────────────────────────────────────────────────────────────────── */
const HAND_WRITTEN_LESSONS = [
    {
        id: DEFAULT_LESSON_ID, group: 'basics', icon: '👋', estMinutes: 1,
        titleKey: 'learn.getting-started.title', titleFallback: 'Getting started',
        descKey: 'learn.getting-started.desc',
        descFallback: 'A one-minute tour of the basics — chat, agents, and where everything lives.',
        gate: {},
        steps: TOUR_STEPS, // reuse the intro tour verbatim — single source of truth
    },
    {
        id: 'effective-prompts', group: 'basics', icon: '💬', estMinutes: 3,
        titleKey: 'learn.effective-prompts.title', titleFallback: 'Writing effective prompts',
        descKey: 'learn.effective-prompts.desc',
        descFallback: 'Get better answers in chat — context, a clear ask, and the right format.',
        gate: {},
        steps: PROMPTS_STEPS,
    },

    /* ── Prompt Engineering course lessons (rich: slides + quiz + exercise) ── */
    {
        id: 'prompt-basics', group: 'basics', icon: '🧬', estMinutes: 5,
        titleKey: 'learn.prompt-basics.title', titleFallback: 'Anatomy of a great prompt',
        descKey: 'learn.prompt-basics.desc',
        descFallback: 'The three ingredients of every strong prompt — with a hands-on rewrite.',
        gate: {},
        steps: PROMPT_BASICS_STEPS,
    },
    {
        id: 'prompt-context', group: 'basics', icon: '🧭', estMinutes: 5,
        titleKey: 'learn.prompt-context.title', titleFallback: 'Give it context',
        descKey: 'learn.prompt-context.desc',
        descFallback: 'Role, audience and goal — the highest-leverage thing you can add.',
        gate: {},
        steps: PROMPT_CONTEXT_STEPS,
    },
    {
        id: 'prompt-structure', group: 'basics', icon: '📐', estMinutes: 5,
        titleKey: 'learn.prompt-structure.title', titleFallback: 'Structure & format',
        descKey: 'learn.prompt-structure.desc',
        descFallback: 'Ask for the exact shape you want back and stop reformatting by hand.',
        gate: {},
        steps: PROMPT_STRUCTURE_STEPS,
    },
    {
        id: 'prompt-iterating', group: 'basics', icon: '🔁', estMinutes: 4,
        titleKey: 'learn.prompt-iterating.title', titleFallback: 'Iterate to perfection',
        descKey: 'learn.prompt-iterating.desc',
        descFallback: 'Steer the first draft to great with quick, targeted follow-ups.',
        gate: {},
        steps: PROMPT_ITERATING_STEPS,
    },
    {
        id: 'prompt-advanced', group: 'basics', icon: '🧪', estMinutes: 6,
        titleKey: 'learn.prompt-advanced.title', titleFallback: 'Advanced techniques',
        descKey: 'learn.prompt-advanced.desc',
        descFallback: 'Few-shot examples and step-by-step reasoning for the hard tasks.',
        gate: {},
        steps: PROMPT_ADVANCED_STEPS,
    },
    {
        id: 'creating-agents', group: 'building', icon: '🤖', estMinutes: 7,
        titleKey: 'learn.creating-agents.title', titleFallback: 'Creating an agent',
        descKey: 'learn.creating-agents.desc',
        descFallback: 'Build a custom agent from a plain-English description.',
        gate: { permission: 'manage_agents' },
        steps: CREATE_AGENT_STEPS,
    },
    {
        id: 'refining-prompt', group: 'building', icon: '🛠️', estMinutes: 4,
        titleKey: 'learn.refining-prompt.title', titleFallback: 'Refining an agent',
        descKey: 'learn.refining-prompt.desc',
        descFallback: 'Tune the system prompt, tools, and knowledge in the Agent Designer.',
        gate: { permission: 'manage_agents' },
        steps: REFINE_PROMPT_STEPS,
    },
    {
        id: 'creating-skills', group: 'building', icon: '🧩', estMinutes: 4,
        titleKey: 'learn.creating-skills.title', titleFallback: 'Creating a skill',
        descKey: 'learn.creating-skills.desc',
        descFallback: 'Package reusable instructions, workflow, rules and examples.',
        gate: { permission: 'manage_skills', feature: 'skills' },
        steps: SKILLS_STEPS,
    },
    {
        id: 'knowledge-bases', group: 'building', icon: '📚', estMinutes: 6,
        titleKey: 'learn.knowledge-bases.title', titleFallback: 'Adding a knowledge base',
        descKey: 'learn.knowledge-bases.desc',
        descFallback: 'Give agents your own documents to answer from.',
        gate: { permission: ['manage_knowledge', 'manage_agents'] },
        steps: KNOWLEDGE_STEPS,
    },
    {
        id: 'connecting-integrations', group: 'power', icon: '🔌', estMinutes: 3,
        titleKey: 'learn.connecting-integrations.title', titleFallback: 'Connecting integrations',
        descKey: 'learn.connecting-integrations.desc',
        descFallback: 'Connect email, calendar and the apps your team already uses.',
        gate: { feature: 'integrations' },
        steps: INTEGRATIONS_STEPS,
    },
    {
        id: 'using-memory', group: 'power', icon: '🧠', estMinutes: 2,
        titleKey: 'learn.using-memory.title', titleFallback: 'Using memory',
        descKey: 'learn.using-memory.desc',
        descFallback: 'Let Bee Flow remember facts and preferences across chats.',
        gate: {},
        steps: MEMORY_STEPS,
    },
    {
        id: 'automations', group: 'power', icon: '⏱️', estMinutes: 3,
        titleKey: 'learn.automations.title', titleFallback: 'Automations & routines',
        descKey: 'learn.automations.desc',
        descFallback: 'Run agents on a schedule — briefings, reports, and more.',
        gate: { feature: 'automations' },
        steps: AUTOMATIONS_STEPS,
    },
    {
        id: 'org-usage', group: 'admin', icon: '📊', estMinutes: 3,
        titleKey: 'learn.org-usage.title', titleFallback: 'Usage & monitoring',
        descKey: 'learn.org-usage.desc',
        descFallback: 'Track spend and activity across your organisation.',
        gate: { permission: 'manage_users' },
        steps: ORG_USAGE_STEPS,
    },
    {
        id: 'automation-anatomy', group: 'power', icon: '⚙️', estMinutes: 7,
        titleKey: 'learn.automation-anatomy.title', titleFallback: 'Anatomy of an automation',
        descKey: 'learn.automation-anatomy.desc',
        descFallback: 'Triggers, steps and dry-runs — learned by matching real scenarios.',
        gate: { feature: 'automations' },
        steps: AUTOMATION_ANATOMY_STEPS,
    },
    {
        id: 'automation-builder-tour', group: 'power', icon: '🗺️', estMinutes: 4,
        titleKey: 'learn.automation-builder-tour.title', titleFallback: 'Meet the builder',
        descKey: 'learn.automation-builder-tour.desc',
        descFallback: 'A guided walk through the real Automations studio and its controls.',
        gate: { feature: 'automations' },
        steps: AUTOMATION_BUILDER_TOUR_STEPS,
    },
    {
        id: 'automation-build-sim', group: 'power', icon: '🏗️', estMinutes: 8,
        titleKey: 'learn.automation-build-sim.title', titleFallback: 'Assemble the flow',
        descKey: 'learn.automation-build-sim.desc',
        descFallback: 'Build three automations on an interactive canvas — trigger, steps, order.',
        gate: { feature: 'automations' },
        steps: AUTOMATION_BUILD_SIM_STEPS,
    },
    {
        id: 'automation-hands-on', group: 'power', icon: '🎓', estMinutes: 10,
        titleKey: 'learn.automation-hands-on.title', titleFallback: 'Build one for real',
        descKey: 'learn.automation-hands-on.desc',
        descFallback: 'Create, trigger and dry-run a real automation — verified in your workspace.',
        gate: { feature: 'automations' },
        steps: AUTOMATION_HANDS_ON_STEPS,
    },
    {
        id: 'automation-practice', group: 'power', icon: '📝', estMinutes: 8,
        titleKey: 'learn.automation-practice.title', titleFallback: 'Design your own automation',
        descKey: 'learn.automation-practice.desc',
        descFallback: 'Brief an automation worth building, and drill the debugging routine.',
        gate: { feature: 'automations' },
        steps: AUTOMATION_PRACTICE_STEPS,
    },
    {
        id: 'cowork-basics', group: 'power', icon: '🤝', estMinutes: 5,
        titleKey: 'learn.cowork-basics.title', titleFallback: 'Meet Cowork',
        descKey: 'learn.cowork-basics.desc',
        descFallback: 'Hand work over instead of chatting it through — a live tour included.',
        gate: {},
        steps: COWORK_BASICS_STEPS,
    },
    {
        id: 'cowork-briefs', group: 'power', icon: '✍️', estMinutes: 6,
        titleKey: 'learn.cowork-briefs.title', titleFallback: 'Briefs that schedule themselves',
        descKey: 'learn.cowork-briefs.desc',
        descFallback: 'Write briefs Cowork can run unattended — graded by the AI coach.',
        gate: {},
        steps: COWORK_BRIEFS_STEPS,
    },
    {
        id: 'cowork-hands-on', group: 'power', icon: '🚀', estMinutes: 6,
        titleKey: 'learn.cowork-hands-on.title', titleFallback: 'Your first cowork',
        descKey: 'learn.cowork-hands-on.desc',
        descFallback: 'Create and run a real cowork — verified in your workspace.',
        gate: {},
        steps: COWORK_HANDS_ON_STEPS,
    },
    {
        id: 'admin-access-control', group: 'admin', icon: '🛡️', estMinutes: 4,
        titleKey: 'learn.admin-access.title', titleFallback: 'Users, groups & access',
        descKey: 'learn.admin-access.desc',
        descFallback: 'Org roles, groups and the grant-only access model.',
        gate: { permission: 'manage_users' },
        steps: ADMIN_ACCESS_STEPS,
    },
    {
        id: 'admin-governance', group: 'admin', icon: '📈', estMinutes: 6,
        titleKey: 'learn.admin-governance.title', titleFallback: 'Running a healthy hive',
        descKey: 'learn.admin-governance.desc',
        descFallback: 'Usage monitoring habits and deliberate feature rollouts.',
        gate: { permission: 'manage_users' },
        steps: ADMIN_GOVERNANCE_STEPS,
    },
    {
        id: 'hive-master', group: 'power', icon: '👑', estMinutes: 15,
        titleKey: 'learn.hive-master.title', titleFallback: 'Hive Master challenge',
        descKey: 'learn.hive-master.desc',
        descFallback: 'The capstone: requirements only, no walkthrough — prove it in your real workspace.',
        gate: { feature: 'automations' },
        steps: HIVE_MASTER_STEPS,
    },

];

// THE lesson catalog. The authored curriculum (generated/lessons.js, 2026-09)
// is authoritative: a hand-written lesson survives only when the curriculum did
// not re-author that id — today that is the intro tour (getting-started) and its
// legacy sibling (effective-prompts). Without this filter the two copies would
// both sit in the array and getLesson() would return the older, shallower one.
const GENERATED_LESSON_IDS = new Set(GENERATED_LESSONS.map((l) => l.id));

export const LESSONS = [
    ...HAND_WRITTEN_LESSONS.filter((l) => !GENERATED_LESSON_IDS.has(l.id)),
    ...GENERATED_LESSONS,
];


/* ── Server-provided lessons (org-authored, Phase 3) ─────────────────────────
 * Published org courses arrive with their lesson docs inline via
 * GET /ai/learning/catalog (already sanitized: quiz keys stripped + serverGraded,
 * exercise rubrics replaced by an exerciseId). They register here at runtime so
 * getLesson()/the player resolve them exactly like built-ins. Org ids are
 * 'orgl-…' so they can never shadow a bundled lesson.
 * ──────────────────────────────────────────────────────────────────────────── */
const serverLessons = new Map();

export function registerServerLessons(lessonDocs) {
    (lessonDocs || []).forEach((doc) => {
        if (!doc || !doc.id) return;
        serverLessons.set(doc.id, {
            id: doc.id,
            group: 'org',
            icon: doc.icon || '📘',
            estMinutes: doc.estMinutes || 5,
            titleFallback: doc.title || doc.id,
            descFallback: doc.desc || '',
            gate: {},
            steps: Array.isArray(doc.steps) ? doc.steps : [],
            source: 'org',
        });
    });
}

/* ── Lookups & resolvers ─────────────────────────────────────────────────── */

export function getLesson(lessonId) {
    return LESSONS.find((l) => l.id === lessonId)
        || serverLessons.get(lessonId)
        || ephemeralLessons.get(lessonId);
}

// True when the user may see/launch this lesson. Hides BOTH permission-gated and
// plan/license-gated lessons the user can't access. `hasFeature` is optional: in
// engine context (no license provider) it's undefined and feature gates are
// treated as visible — the Learning Center page is the authoritative filter.
//
// The two halves read differently on purpose, and the asymmetry is the whole
// point of the gate:
//   • `permission` is ANY-of — it answers "can you reach this screen at all",
//     and a screen usually has more than one role that opens it (org_admin OR
//     manage_users both open Users & groups). `permissionsAll` is the other
//     shape of the same question, for a lesson that hands the learner two
//     separate powers: attaching a skill to an agent is manage_skills AND
//     manage_agents, and ANY-of would show it to someone holding one.
//   • `feature` is ALL-of — it answers "is every capability this lesson makes
//     you USE actually in your plan". A lesson that walks you through Playbooks
//     touches Automations *and* App Studio; showing it to an org that only
//     licenses one of them teaches a screen they cannot open. So a gate may
//     name a list, and every entry must be present.
// Mirrored server-side in server/learning/courseCatalog.js (gatePasses).
export function lessonVisible(lesson, user, hasFeature) {
    const gate = lesson?.gate || {};
    if (gate.permission && !checkPermission(user, gate.permission)) return false;
    if (gate.permissionsAll && !gate.permissionsAll.every((p) => checkPermission(user, p))) return false;
    if (gate.feature && typeof hasFeature === 'function') {
        const required = Array.isArray(gate.feature) ? gate.feature : [gate.feature];
        if (!required.every((f) => hasFeature(f))) return false;
    }
    return true;
}

// The lessons to show on the Learning Center page, filtered by permission + plan.
export function resolveLessons(user, { hasFeature } = {}) {
    return LESSONS.filter((l) => lessonVisible(l, user, hasFeature));
}

// True when every step of a lesson is a live-app tour step. Such lessons skip the
// LessonPlayer entirely and dispatch TOUR_START_EVENT straight to the engine, so
// the legacy 10 lessons behave exactly as before.
export function lessonIsPureTour(lesson) {
    const steps = lesson?.steps || [];
    return steps.length > 0 && steps.every((s) => stepType(s) === STEP_TYPES.TOUR);
}

export function lessonIdIsPureTour(lessonId) {
    return lessonIsPureTour(getLesson(lessonId));
}

/* ── Ephemeral tour registry ──────────────────────────────────────────────────
 * A rich lesson mixes inline steps (slide/quiz/exercise, rendered by the
 * LessonPlayer) with live-app tour steps (rendered by OnboardingTour). To replay
 * just the tour sub-segment through the existing engine WITHOUT changing it, the
 * player registers that contiguous run of tour steps here under a throwaway id and
 * dispatches TOUR_START_EVENT with it. resolveLessonSteps() returns the registered
 * steps for that id; the engine plays them and fires LESSON_COMPLETE_EVENT, which
 * the player listens for to resume. The id is recognisable (EPHEMERAL_PREFIX) so
 * markLessonComplete() can skip persisting it as a real lesson.
 * ──────────────────────────────────────────────────────────────────────────── */
export const EPHEMERAL_PREFIX = '__eph_';
const ephemeralTours = new Map();
let ephemeralCounterSeed = 0;

export function isEphemeralLessonId(id) {
    return typeof id === 'string' && id.startsWith(EPHEMERAL_PREFIX);
}

export function registerEphemeralTour(steps) {
    const id = `${EPHEMERAL_PREFIX}${++ephemeralCounterSeed}`;
    ephemeralTours.set(id, Array.isArray(steps) ? steps : []);
    return id;
}

export function clearEphemeralTour(id) {
    if (id) ephemeralTours.delete(id);
}

/* ── Ephemeral lesson registry (review & practice sessions) ───────────────────
 * A review/practice session is a throwaway lesson assembled at runtime (mistake
 * items + stale items + AI-generated practice) and played through the normal
 * LessonPlayer. It registers here under the SAME '__eph_' prefix as tour
 * segments, so markLessonComplete/saveStepState keep skipping persistence with
 * zero changes — the session's answers are written back to their ORIGIN steps
 * instead (learningProgress.recordReviewOutcome). `kind: 'review'` lets the
 * player show the review completion screen and run mastery stamping.
 * ──────────────────────────────────────────────────────────────────────────── */
const ephemeralLessons = new Map();

export function registerEphemeralLesson({ titleFallback, icon = '🔁', kind = 'review', steps }) {
    const id = `${EPHEMERAL_PREFIX}lesson_${++ephemeralCounterSeed}`;
    ephemeralLessons.set(id, {
        id,
        group: 'review',
        icon,
        estMinutes: Math.max(1, (steps || []).length),
        titleKey: 'learn.review.session_title',
        titleFallback: titleFallback || 'Review session',
        gate: {},
        steps: Array.isArray(steps) ? steps : [],
        kind,
        ephemeral: true,
    });
    return id;
}

export function clearEphemeralLesson(id) {
    if (id) ephemeralLessons.delete(id);
}

// The steps the engine should run for a lesson, with the same requiresStudio
// filter the intro tour applies. Ephemeral ids resolve from the registry first;
// otherwise falls back to the getting-started lesson for an unknown id so a stale
// event can never run an empty tour.
export function resolveLessonSteps(lessonId, user) {
    if (isEphemeralLessonId(lessonId)) {
        return filterStepsForUser(ephemeralTours.get(lessonId) || [], user);
    }
    const lesson = getLesson(lessonId) || getLesson(DEFAULT_LESSON_ID);
    return filterStepsForUser(lesson?.steps || [], user);
}

// The full ordered step list for a rich lesson, as the LessonPlayer should render
// it (inline steps + tour steps interleaved). Same requiresStudio filtering as the
// engine so a member never sees a Studio-only step they can't action.
export function resolveLessonPlayerSteps(lessonId, user) {
    const lesson = getLesson(lessonId) || getLesson(DEFAULT_LESSON_ID);
    return filterStepsForUser(lesson?.steps || [], user);
}

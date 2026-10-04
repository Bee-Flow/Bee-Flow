// Practice topic registry — what the AI practice generator may write questions
// about, and the ground truth it is grounded in.
//
// Keyed by BUILT-IN lesson id (every key must exist in courseCatalog.LESSON_IDS
// — practiceTopics.test.js enforces it). The generator's prompt is assembled
// ONLY from these server-owned summaries/facts plus the whitelisted lesson ids
// — never from client-supplied text — so a learner can't steer generation.
// Facts deliberately mirror real UI copy (learners see those exact labels).

const GEN = require('./catalog.generated');

const LEGACY_PRACTICE_TOPICS = {
    'prompt-basics': {
        title: 'Anatomy of a great prompt',
        summary: 'Strong prompts combine context, a clear specific task, and the desired output format.',
        facts: [
            'The three parts of a strong prompt: context (who/what), a clear task, and the output format.',
            'Vague prompts ("write something about our feature") force the model to guess; specific prompts name audience, length and tone.',
            'Missing any of the three parts lowers answer quality more than wording style does.',
        ],
    },
    'prompt-context': {
        title: 'Give the prompt context',
        summary: 'Role, audience and goal are the highest-leverage additions to any prompt.',
        facts: [
            'Context means: your role, the audience the output is for, and the goal it should achieve.',
            'Setting a role for the model ("Act as a senior copywriter") primes tone, vocabulary and caution.',
            'Generic, off-target answers usually signal missing context, not a bad model.',
        ],
    },
    'prompt-structure': {
        title: 'Structure & format',
        summary: 'Stating the exact output shape (table, bullet count, length, tone) removes manual reformatting.',
        facts: [
            'Ask for the output shape explicitly: a table with named columns, exactly N bullets, a word limit, a tone.',
            'For longer prompts, separate instructions from the material with delimiters so the model never confuses them.',
            'Models follow formatting instructions well — the trick is actually stating them.',
        ],
    },
    'prompt-iterating': {
        title: 'Iterate to perfection',
        summary: 'The first answer is a draft; short targeted follow-ups in the same conversation beat rewriting from scratch.',
        facts: [
            'The model remembers the conversation, so follow-ups like "shorter", "warmer", "add an example" steer cheaply.',
            'A 90%-right answer needs a targeted follow-up in the same chat, not a brand-new prompt.',
            'Naming what to change (length target, words to drop, what to lead with) beats "make it better".',
        ],
    },
    'prompt-advanced': {
        title: 'Advanced prompting techniques',
        summary: 'Few-shot examples and ask-for-a-plan-first reasoning solve tasks plain instructions miss.',
        facts: [
            'Few-shot: one or two worked input→output examples pin down a pattern better than describing it.',
            'For multi-step work, ask the model to outline its approach first, then carry it out — catches wrong assumptions early.',
            'Few-shot is the most reliable fix when outputs keep missing a very specific format.',
        ],
    },
    'effective-prompts': {
        title: 'Writing effective prompts',
        summary: 'Better chat answers come from context, a specific ask, and a stated format.',
        facts: [
            'A great prompt is context + a clear ask + the format you want back.',
            'Iterate with short follow-ups instead of restarting the conversation.',
        ],
    },
    'creating-agents': {
        title: 'Creating an agent',
        summary: 'An agent is a system prompt + tools + knowledge, drafted from a plain-English description in Studio.',
        facts: [
            'Every agent has three parts: a system prompt (role, tone, rules), tools (what it may do), and knowledge (documents it answers from).',
            'The agent wizard drafts an agent from one plain-English sentence; drafts stay private until published.',
            'Agents live in Studio; publishing shares an agent with the team.',
        ],
    },
    'refining-prompt': {
        title: 'Refining an agent',
        summary: 'The Agent Designer tunes the three dials: system prompt, tools, knowledge.',
        facts: [
            'Off-topic or wrong-tone behaviour is fixed in the system prompt first — role, tone and explicit rules.',
            'Tools grant abilities (email, calendar, web search); knowledge grounds answers in your documents.',
            'A good system prompt states what the agent always does and never does.',
        ],
    },
    'creating-skills': {
        title: 'Creating a skill',
        summary: 'A skill packages a reusable workflow — instructions, steps, rules, examples — attachable to any agent.',
        facts: [
            'A skill has four parts: instructions, workflow, rules, and examples of good output.',
            'Attached to an agent, a skill triggers automatically when a task matches it.',
            'Skills make your best workflow run the same way every time, across agents.',
        ],
    },
    'knowledge-bases': {
        title: 'Knowledge bases',
        summary: 'Upload documents so agents answer from your content, with sources.',
        facts: [
            'A knowledge base holds uploaded files (PDFs, docs, spreadsheets) that Bee Flow indexes for search.',
            'Attach a knowledge base in the Agent Designer under Knowledge; the agent then cites the sources it used.',
            'Without a knowledge base an agent only knows general information.',
        ],
    },
    'connecting-integrations': {
        title: 'Connecting integrations',
        summary: 'Connect a service once, then enable the matching tool per agent.',
        facts: [
            'Connecting an integration (email, calendar, drive) is step one; an agent also needs the matching TOOL switched on before it can act on it.',
            'Integrations are connected in Settings → Integrations.',
        ],
    },
    'using-memory': {
        title: 'Using memory',
        summary: 'Bee Flow remembers facts and preferences across chats, fully user-controlled.',
        facts: [
            'Mention a fact or preference once in chat and it persists across conversations.',
            'Every memory can be reviewed, edited, or removed in Settings → Memory.',
        ],
    },
    'automations': {
        title: 'Automations & automations',
        summary: 'An automation is a trigger plus steps on a visual canvas that runs without you.',
        facts: [
            'An automation = ONE trigger + steps on a canvas, ending in a result. Statuses: DRAFT, LIVE, PAUSED.',
            'You can build by describing the automation in plain English: the assistant beside the builder\'s canvas wires the steps.',
            'Dry-run previews an automation with no real actions; check run history after the first live runs.',
        ],
    },
    'automation-anatomy': {
        title: 'Anatomy of an automation',
        summary: 'Trigger kinds, step palette, dry-run vs live, and the DRAFT/LIVE/PAUSED lifecycle.',
        facts: [
            'Trigger kinds (UI labels): Trigger manually, On form submission, On a schedule, On webhook call, On app event, When an agent calls it, From a Studio App.',
            'Only webhook and app-event triggers can be ADDITIONAL triggers; the rest replace the primary one.',
            'Flow steps include: Condition (keep/split/branch), Repeat for each, Wait, Ask someone to approve, Privacy Shield, Notification, Call a web service, Make a document.',
            '"Run flow" offers Dry-run (preview, no real actions) and Run live (executes every step for real).',
            'Recurring time-based work wants a schedule trigger; reacting to an external system wants a webhook.',
        ],
    },
    'automation-builder-tour': {
        title: 'The automations builder',
        summary: 'The Studio → Automations surface: start screen tabs, canvas, views, activation.',
        facts: [
            'The start screen has four tabs: All automations, Find repeating work, Templates, and Runs. Building blocks (reusable Steps) sit in the automations list, and describing an automation in plain English happens in the assistant beside the builder\'s canvas.',
            'The builder has four views: Editor (canvas), Settings, Runs, and Saved versions.',
            'Activate needs a trigger AND at least one step; the empty canvas says "Start with a trigger".',
            'The schedule picker offers Every N minutes / Hourly / Daily / Weekly / Monthly / Advanced with a timezone and a preview of the next 3 firing times.',
        ],
    },
    'automation-build-sim': {
        title: 'Assembling automations',
        summary: 'Choosing the right trigger and ordering the right steps for a scenario.',
        facts: [
            'Pick the trigger from WHEN the work should start: recurring → schedule, external event → webhook, a person submits data → form.',
            'Steps run in order: fetch/collect before AI processing, AI processing before sending/archiving.',
            'Approval steps ("Ask someone to approve") pause the run until a person decides.',
        ],
    },
    'automation-practice': {
        title: 'Designing automations',
        summary: 'A strong automation brief names the trigger, the source data, the work, and the destination.',
        facts: [
            'A buildable brief answers: when does it run, what data does it read, what happens to it, where does the result land.',
            'After the first run, check run history to confirm the automation did what you expected.',
            'Dry-run before activating; treat a new automation like a new colleague — trust, but verify the first week.',
        ],
    },
    'cowork-basics': {
        title: 'Cowork basics',
        summary: 'Cowork runs described work on its own — now, later, or repeating — and reports to notifications.',
        facts: [
            'Cowork sits in the sidebar under New Chat; the chat header has a Chat ⇄ Cowork switch.',
            'Chat answers you here in the conversation; Cowork runs on its own and delivers the result to your notifications.',
            'The composer has three chips: When (Run now, In an hour, Tonight, Tomorrow morning, Next Monday, Pick a moment), Repeat (Once up to Every year), and Run as agent.',
            'There is a per-user slot limit (default 10 cowork items).',
        ],
    },
    'cowork-briefs': {
        title: 'Writing cowork briefs',
        summary: 'One plain-language brief; the AI composer derives title, instruction and schedule — chips win over inference.',
        facts: [
            'The composer derives the title, the instruction and the schedule from your brief in one step.',
            'Any chip you set yourself wins over what the AI infers from the brief text.',
            'Vague times map to fixed hours: morning → 08:00, midday → 12:00, evening → 18:00.',
            'A good brief says what to do, what to use, and when — like delegating to a colleague.',
        ],
    },
    'cowork-hands-on': {
        title: 'Running cowork',
        summary: 'Managing cowork items: run history, edit, pause/resume, run now, delete.',
        facts: [
            'Each cowork item shows its run history — every run with status, timing and the result.',
            'Items can be edited, paused/resumed, run now, or deleted; repeating work keeps running until paused.',
            'Results land in the notification center with an "Open in Cowork" action.',
        ],
    },
    'org-usage': {
        title: 'Usage & monitoring',
        summary: 'Admins track activity and spend per user, agent and model over time.',
        facts: [
            'Settings → Organisation → Usage & Monitoring breaks down requests, tokens and cost by source and model over a date range.',
            'A sudden spend spike usually means a runaway automation or an unusually heavy workflow — diagnose before acting.',
        ],
    },
    'admin-access-control': {
        title: 'Users, groups & access',
        summary: 'Org roles, groups, and grant-only permissions capped by the plan.',
        facts: [
            'Access has three layers: org role (admin/member), groups, and fine-grained permissions granted through groups.',
            'Grants only ADD — a group grant can give more than the org default, never less.',
            'The right way to let a member build agents is a group that grants it, not making them an org admin.',
        ],
    },
    'admin-governance': {
        title: 'Running a healthy organisation',
        summary: 'Usage-monitoring habits and deliberate, staged feature rollouts.',
        facts: [
            'Skim usage weekly; check it after enabling anything new.',
            'Roll out new capabilities in stages: pilot with a small group, review usage and feedback, then broaden.',
        ],
    },
};

const PRACTICE_TOPICS = { ...LEGACY_PRACTICE_TOPICS, ...GEN.PRACTICE_TOPICS };

function getPracticeTopic(lessonId) {
    return PRACTICE_TOPICS[lessonId] || null;
}

const PRACTICE_LESSON_IDS = Object.keys(PRACTICE_TOPICS);

module.exports = { PRACTICE_TOPICS, getPracticeTopic, PRACTICE_LESSON_IDS };

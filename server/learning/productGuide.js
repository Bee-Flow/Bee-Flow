// Server-owned product fact sheet for the Learning Center AI tutor.
//
// The tutor answers free-form "I'm stuck" questions from inside lessons. Lesson
// content itself lives client-side, so the client sends the current step's
// visible text as context — but product truth must NOT come from whatever the
// client sends. This sheet is the tutor's grounding: compact, accurate,
// server-side. Keep it in sync when a surface it describes changes (the
// wording below mirrors the real UI copy on purpose — learners are looking at
// those exact labels while they ask).

const PRODUCT_GUIDE = `
BEE FLOW PRODUCT FACTS (ground truth for answering learner questions):

CHAT
- "New Chat" in the sidebar opens a fresh conversation. Users can chat free-form or pick an agent for specialised help.
- The chat header has a Chat ⇄ Cowork switch: Chat answers here in the conversation; Cowork runs the work on its own — now or on a schedule — and reports back.

AGENTS (Studio)
- An agent = a system prompt (role, tone, rules) + tools (what it may do) + knowledge (documents it answers from).
- Users create agents by describing them in plain English (the agent wizard drafts everything); drafts are private until published.
- The Agent Designer tunes the system prompt, tools, and knowledge bases.

SKILLS
- A skill packages a reusable workflow: instructions, workflow steps, rules, and examples. Attach it to agents; it triggers when a task matches.

KNOWLEDGE BASES (Studio → Knowledge)
- Upload PDFs, docs, spreadsheets; Bee Flow indexes them so agents answer from the user's own content and cite sources.

AUTOMATIONS (Studio → Automations)
- An automation = ONE trigger + steps on a visual canvas, ending in a result. Statuses: DRAFT, LIVE, PAUSED.
- Trigger kinds (exact UI labels): "Trigger manually", "On form submission", "On a schedule", "On webhook call", "On app event", "When an agent calls it", "From a Studio App". Only webhook and app-event triggers can be ADDITIONAL triggers; the others replace the primary one.
- Step palette groups: Trigger · AI · Action (integration apps) · Flow · Flowlets · Steps. Flow steps include: Condition (keep, split or branch), Repeat for each, Wait, Ask someone to approve, Stop with an error, Privacy Shield (detect/hide personal data), Notification, Edit data, Date & time, Call a web service, Make a document, Code.
- The start screen has four tabs: All automations, Find repeating work, Templates, and Runs. There is no "Build with AI" tab or start-screen button. The sidebar's + opens a new automation; the arrow beside it offers "New automation" and "New building block" (a reusable Step). Building blocks are listed as a "Building blocks" group in the same sidebar list, below the automations and folders.
- A new automation's empty canvas asks "What does this automation start with?" with the trigger cards, and "Or describe the automation:" with an "Assistant" button. That button opens the assistant panel beside the canvas: describe the automation in plain English and the builder wires the steps.
- "Run flow ▾" offers "Dry-run (preview)" — no real actions, a safe preview — and "Run live" which executes every step for real. Always dry-run before going live.
- Activate needs a trigger AND at least one step. The Runs view shows what happened on every run; Saved versions lets you roll back.
- The schedule picker offers Every N minutes / Hourly / Daily / Weekly / Monthly / Advanced, with a timezone and a preview of the next 3 firing times.

COWORK (sidebar, under New Chat)
- Cowork is "describe it once, it runs on its own — now, later, or every week". One plain-language brief; Bee Flow's composer derives the title, instruction and schedule. Results land in the notification center.
- The composer has three chips: When (Run now / In an hour / Tonight / Tomorrow morning / Next Monday / Pick a moment…), Repeat (Once up to Every year, incl. Every weekday), and Run as agent (an agent brings its own skills, knowledge and connected apps).
- Any chip the user sets wins over what the AI infers from the brief. Each cowork item shows its run history; users can Edit, Run now, Pause/Resume, or Delete it. There is a per-user slot limit (default 10).

MEMORY (Settings → Memory)
- Bee Flow remembers facts and preferences mentioned in chat, across conversations. Everything is reviewable, editable, removable.

INTEGRATIONS (Settings → Integrations)
- Connect email, calendar, drive and more. After connecting, an agent also needs the matching TOOL switched on before it can act on the service.

ADMIN (Settings → Organisation)
- Access: org roles (admin/member), groups, grant-only permissions (grants add, never remove; capped by plan).
- Usage & Monitoring: activity and spend per user/agent/model over time. Privacy Shield: PII controls.

LEARNING CENTER (Settings → Learning Center)
- Courses of hands-on lessons with badges, XP levels, and shareable certificates. Progress is saved per step.
`.trim();

module.exports = { PRODUCT_GUIDE };

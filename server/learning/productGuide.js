// @typecheck strict
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
- An empty chat's header has a Chat ⇄ Cowork switch (it disappears after the first message): Chat answers here in the conversation; Cowork mode creates a task straight from the chat with the older When / Repeat chips. The Cowork page itself is the main way in.

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
- Cowork does recurring work for you while you do something else. Each job is a "task". The home asks "What should be done for you?": the user types ONE sentence and chooses "Show what I understood" (this creates nothing). "Start from a template" begins from a colleague's template.
- A card "This is what I understood" answers with four lines, each changeable before anything exists: What (the task's name), When (day and time; "Which day?" when the sentence did not say), Uses (chips of the apps the sentence names; none named: Cowork picks them while setting up), Sends to ("Me" plus every e-mail address written in the sentence; "Show me each message first" is ticked when it sends to someone else). Editing the sentence re-reads it but keeps lines changed by hand.
- "Set up and test" creates the task, sets up fixed steps and tests them once on real data, sending nothing ("Setting up the steps" · "Testing once, nothing is sent" · "Ready for your check"). A card under "Needs you" says "The steps are ready and tested. Check them once." with "Open and approve". The task does NOT run for real until its steps are approved; the first approval shows "This is what you would have received" with "Approve" and "Change something". Where the organisation has no fixed steps the button reads "Start" and the AI works the task out on every run. If set-up fails, a card offers "Try setting up again" or "Let the AI work it out every run".
- The home lists "Needs you", "Your tasks", "Shared with you" (when not empty) and "Teamwork". The gear opens "Cowork preferences"; administrators also see "Admin rules". Status words: Done, Failed, Needs you, Scheduled, Running, Testing, Paused, Nothing to do ("Nothing to do" is a run that found nothing, not a failure).
- A task opens as a page: "Run for real now", "Pause", "Share" (a disabled button says why underneath); then Settings with four rows, each with "Change" (no Edit screen): What (name, sentence, Target to track), When (schedule or what starts it), Uses (Apps it may use, How it works: "The AI works it out every run" / "An agent of yours does it" / "Fixed steps", What it remembers, Spending limit), Sends to (who receives it — changed by saying it in the sentence under What — and one "Ask me" choice: "Ask me before every change or message", "Show me each message first", "Don't ask", which opens after 10 runs let through and applies to fixed steps only). Then Steps ("Test, sends nothing", "Compare with last month"), People (Share, Send each result to a colleague's task, Save as template / Export as file, Give this task away), History (Runs, Changes, Proof of each run, and "Delete this task" at the bottom).
- A failure is always a card under "Needs you" in plain words with one action ("Sign in again", "Fix it for me", "See what is wrong", "Run it again"); the raw error is under "Technical details". Results also land in the notification center (category Cowork). Limit: 10 tasks per person.

MEMORY (Settings → Memory)
- Bee Flow remembers facts and preferences mentioned in chat, across conversations. Everything is reviewable, editable, removable.

INTEGRATIONS (Settings → Connections)
- Connect email, calendar, drive and more. After connecting, an agent also needs the matching TOOL switched on before it can act on the service.

ADMIN (Settings → Organisation)
- Access: org roles (admin/member), groups, grant-only permissions (grants add, never remove; capped by plan).
- Usage & Monitoring: activity and spend per user/agent/model over time. Privacy Shield: PII controls.

LEARNING CENTER (Settings → Learning Center)
- Courses of hands-on lessons with badges, XP levels, and shareable certificates. Progress is saved per step.
`.trim();

module.exports = { PRODUCT_GUIDE };

# Fact sheet — PROMPTING (audience: everyday users)

Area status: **EXISTS, and it is substantial.** Prompting is taught as a full course
("Prompt Engineering", 5 lessons, 23 steps) inside the Learning Center, with 5 AI-graded
exercises backed by server-side rubrics, AI-generated practice questions, a review engine
and a badge. Around it sit the real product surfaces where a prompt is actually typed
(chat composer, model-depth tiers, knowledge grounding, Privacy Shield, Skills, Cowork).

Source of truth read for this sheet:
- `agent-hub/src/components/onboarding/lessons.js` (lesson + step definitions, l. 51-98 and 380-600)
- `agent-hub/src/components/onboarding/courses.js` + `server/learning/courseCatalog.js` (course structure)
- `server/learning/rubrics.js` (the 9 exercise rubrics, 6 of them prompt-craft)
- `server/routes/ai/learning.js` (coach, tutor, practice, catalog, achievements, org-overview)
- `server/learning/practiceTopics.js`, `server/learning/productGuide.js`, `server/learning/progressValidation.js`
- `agent-hub/src/pages/settings/LearningCenterSection.jsx` + `pages/settings/learning/*` (redesigned shell, uncommitted 2026-09-14)
- `agent-hub/src/components/onboarding/player/*` (LessonPlayer, ExerciseStep, QuizStep, SimStep, TutorPanel)
- `agent-hub/src/components/chat/InputArea.jsx`, `DlpPreviewModal.jsx`, `components/licensing/tierMeta.js`

---

## 1. What this feature is for

Two layers, and lesson authors must not blur them:

1. **The teaching layer — "Prompt Engineering" course** in Settings → Learning Center
   ("Bee Flow Academy"). Five short lessons that each mix teaching slides, an interactive
   simulation, a multiple-choice check and one free-text exercise that an **AI coach grades
   0-100** against a rubric the learner never sees. Finishing all five earns the badge
   **Prompt Smith ✍️** and 500-750 XP.
2. **The practice layer — the product's own prompting surfaces.** Where the learner types
   the prompt (chat composer), how deep the answer runs (depth tiers), what the prompt is
   grounded on (knowledge bases, attachments, memory), what happens to personal data in a
   prompt (Privacy Shield / DLP), and how a good prompt gets reused (Skills, agent system
   prompt, Cowork brief, routine AI step).

The course teaches generic prompt craft, but every lesson lands in a Bee Flow surface: the
"Structure & format" lesson literally walks the learner to the chat composer
(`[data-tour="chat-composer"]`, "This is where you ask").

---

## 2. Screens, with the real UI strings

### 2.1 Settings → Learning Center (nav label: **"Learning Center"**)
- Reached via Settings; nav key `settings.learning_center` = **"Learning Center"** with a
  graduation-cap icon (`pages/settings/settingsNavItems.jsx`).
- **Desktop only.** `SETTINGS_DESKTOP_ONLY_TABS = ['integrations', 'learning']` — the tab is
  not rendered on a phone. Say "on your laptop" in any lesson that sends someone here.
- Left rail (300px) subtitle: **"Bee Flow Academy · {courses} courses · {lessons} lessons"**.
  Search box: **"Search lesson, course or badge…"**. Filter chips: **"All"** / **"Available"**.
  Rail nav: **"Overview"**, **"Review"**, **"Achievements"**, then path headings and the
  course list, then **"Capstone"** and the XP line ("{xp} XP · {n} to {level}").
- Header carries the path chip: **"Path: {path}"**, dialog **"What do you want to get good at?"**
  / **"Your pick reorders the courses below — everything stays available."** / **"Skip for now"**.
  The three paths (`learningPaths.js`): **"Everyday work"** 💬 (foundations → **prompting** →
  cowork), **"Build agents & automations"** 🛠️, **"Run the workspace"** 🛡️.
  *Prompt Engineering is the second course on the Everyday work path — the default home of this
  audience.*
- Overview: hero **"Continue learning"** / **"Everything you can see is complete"**,
  **"Continue · lesson {n} of {total}"**, **"Start review"** / **"Nothing to review yet"**,
  then **"Curriculum"** with **"Filter by level"** / **"All levels"**, per-course
  **"Certificate {a}/{b}"**, legend **"mastered" / "complete" / "locked"**, and two play
  buttons per lesson: **"Play"** and **"Beside the app"**
  (title: *"Dock to the side — use the app while you learn"*).

### 2.2 Course screen — "Prompt Engineering"
- Back link **"Back to the overview"**; chip **"{a} of {b} lessons · {min} min"**;
  tabs **"Lessons"** and **"About this course"**; buttons **"Practice with AI"** and
  **"Continue with lesson {n}"**.
- Course copy (real): title **"Prompt Engineering"**, description
  *"Write prompts that get great answers — context, structure, iteration and advanced
  techniques, with hands-on practice graded by an AI coach."*, icon 💬, level *beginner*,
  track *Foundations*, badge **"Prompt Smith"**.
- Lesson table columns: **"Lesson" · "Steps" · "Duration" · "Plays"**; row actions
  **"Play"**, **"Beside the app"**, **"Replay"**, **"Practice"**
  (*"A fresh round of AI-generated questions on this lesson"*), expander **"Lesson details"**.
- Step-kind hints in the table: **"several answers" / "one answer" / "AI coach scores 0–100" /
  "build it yourself" / "for real, in the app" / "spotlight in the app" / "read"**.
- Right-hand panels: **"Progress"**, **"{n} XP earned"**, **"On completion:"** badge,
  **"Counts toward"** certificate, **"What counts as mastered"** →
  *"Every quiz and simulation right first try, nothing revealed. Mistakes land in your
  review — a right answer there clears them here again."*, and **"Help on the way"** →
  *"The AI tutor gives a hint first, the answer only after"*,
  *"Hint ladder on the exercise: three rungs"*,
  *"Getting stuck is not a wall: after a few tries you may skip an exercise"*.
- Visibility line: **"You see all {n} lessons"** or
  **"You see {a} of {b} lessons — {n} need a permission or plan feature you do not have"**.

### 2.3 The lesson player
- Opens as a centered window or **docked** beside the app. Chrome: step counter
  **"Step {n} of {total}"**, **"Ask AI"** (*"Stuck? Ask the AI coach about this step"*),
  **"Dock to the side"** / **"Expand to a centered window"**, **"Minimize"**
  (*"Collapse the lesson while you work — it keeps checking"*), **"Close"**,
  **"Back"** / **"Next"** / **"Finish lesson"**, blocked-state line
  **"Complete this step to continue"**.
- Minimised pill: **"Lesson in progress — click to return"**, **"Continue"**,
  **"Open the lesson again"**.
- End screen: **"Lesson complete!"**, **"{a} of {b} steps"**, **"Mastered"** +
  *"Every quiz and simulation first try, the exercise without a hint. Nothing revealed."*,
  **"Badge earned"**, **"You completed {course}."**, **"Next lesson: {title}"**,
  **"Back to the course"** / **"Back to the Learning Center"**.
- **"Ask AI" panel (TutorPanel):** header **"AI tutor"** + *"gives a hint first, the answer
  only after"*, input **"Ask a question about this step…"**, button **"Send"**,
  spinner **"Thinking…"**.

### 2.4 Exercise step (the AI coach) — the heart of this area
- Free-text `textarea` (5 rows, min-height 110px) with the lesson's placeholder example.
- Buttons: **"Submit for review"** → after the first try **"Submit again"**; while grading
  **"Reviewing…"**; **"Get a hint"** (hint renders as **"Hint: "** + one sentence);
  **"Skip this one"** appears only after `maxAttempts` (4) failed attempts.
- Verdict: a circular **score ring 0-100** (dash "—" if the coach is unavailable) plus
  **"Great work — you nailed it!"** on a pass, **"Close — tighten it up and resubmit"** on a
  miss, **"Coach unavailable"** on an error, and two lists: **"What worked"** and
  **"To improve"** (max 4 bullets each).

### 2.5 Quiz + simulation steps
- Quiz: **"Check answer"**, **"Try again"**, **"Checking…"**, **"Correct! "** /
  **"Not quite. "**, **"Nice — continue below."**, multi-select hint **"Select all that apply."**
- Sim (two kinds are used in the prompt course):
  - *match* (`pb-sim`): **"Diagnose the weak prompt"** — "Each prompt on the left is missing
    exactly one ingredient. Match it to what's missing." Pass line: **"All matched — nice
    pattern-spotting."**
  - *order* (`pst-sim`): **"Assemble the well-structured prompt"** — "Put the five pieces of a
    long prompt into the order that keeps instructions and material cleanly apart."
    Buttons **"Check"** and (after 2 attempts) **"Show solution"**; wrong order shows
    *"Not quite — the highlighted piece is the first one out of place."*; right order:
    **"Exactly right."**

### 2.6 Where the prompt is actually typed — the chat composer
- Placeholder **"Message AI..."** in direct chat, **"Message {name}..."** with an agent,
  **"Reply to thread..."** inside a thread. Form label "Chat message input".
- Composer controls that change how a prompt behaves:
  **"Knowledge"** (*"What this chat is grounded on"* → **"Grounded on {names}"**),
  **"Skills"** (*"Reusable instruction packs for this chat"*),
  **"Apps"** (*"What this chat may reach — Drive, Gmail, and the rest"*),
  **"Web search"**, **"Memory"**, **"Add photos & files"**, **"Create image, music, video"**,
  **"Voice mode"**, sources pill **"{count} sources"** (*"What this chat can look things up in"*),
  and the depth pill (*"The depth the next answer runs at"*, with an agent:
  *"The depth this agent runs at"*), showing **"Auto · {tier}"** when Auto picks.
- Depth tiers as the user sees them (`tierMeta.js`): **Auto** "Optimal choice" · **Fast**
  "Quick answers" · **Think** "Complex problems" · **Deep Thinking** "Advanced reasoning" ·
  **Write** "Long-form content" · plus the beta **Flow** and **Swarm** tiers.
- Knowledge panel: **"Knowledge bases"**, *"Pick one or more to ground this chat."*,
  empty state **"No knowledge bases available. Create one in the Knowledge Bases section."**,
  errors like **"A chat can use at most {count} knowledge bases."**

### 2.7 Privacy Shield / DLP on a prompt
Modal **"Sensitive content detected"**, subtitle **"This prompt will be sent to"** + the model
(badge **"external"**), **"Detected items"** (source chips *pii* / *custom*),
checkbox **"Remember my choice for this conversation"**, actions **"Block"**,
**"Send anyway"** (*"Send the prompt unchanged"*) and **"Redact and send"**.

---

## 3. The five lessons, step by step (exact content)

Course `course-prompting`, track `foundations`, prereqs: none, badge `badge-prompt-smith`.

| # | Lesson id | Title (UI) | Steps | Est. | Step types |
|---|-----------|-----------|-------|------|------------|
| 1 | `prompt-basics` | **Anatomy of a great prompt** 🧬 | 5 | 5 min | slide, slide, sim(match), quiz, exercise |
| 2 | `prompt-context` | **Give it context** 🧭 | 4 | 5 min | slide, slide, quiz, exercise |
| 3 | `prompt-structure` | **Structure & format** 📐 | 6 | 5 min | slide, slide, sim(order), quiz, tour, exercise |
| 4 | `prompt-iterating` | **Iterate to perfection** 🔁 | 4 | 4 min | slide, slide, quiz, exercise |
| 5 | `prompt-advanced` | **Advanced techniques** 🧪 | 4 | 6 min | slide, slide, quiz, exercise |

Plus a sixth, older, **course-less** lesson: `effective-prompts` — **"Writing effective
prompts"** 💬, 3 min, 6 pure-tour steps ("1. Give context", "2. Make the ask specific",
"3. Ask for a format, then iterate", "Try it now"). It is a *pure tour* lesson, so it never
opens the player — it drives the spotlight engine over the real app.

### Lesson 1 — Anatomy of a great prompt
- Slide **"The anatomy of a great prompt"**: three parts — **Context**, **A clear task**,
  **The output format**. "Miss one and the model has to guess."
- Slide **"Vague in, vague out"**: vague *"write an email about the delay"* vs specific
  *"Draft a 3-sentence email to a customer apologising for a 2-day shipping delay, offering
  10% off their next order, in a warm but professional tone."*
- Sim (match): three weak prompts → **"Missing: context" / "Missing: a clear task" /
  "Missing: the output format"**.
- Quiz: correct answer = *"Summarise the report below into 5 bullet points a busy executive
  can read in 30 seconds."*
- Exercise `ex-basics-specific` — **"Your turn: make it specific"**: rewrite
  *"write something about our new feature."*

### Lesson 2 — Give it context
- Slides: **"Context steers everything"** (role / audience / goal) and **"Set a role for the
  model too"** ("Act as a senior copywriter", "You are a careful financial analyst").
- Quiz: a generic answer → the fix is *"Add who you are, who it's for, and what you're trying
  to achieve."*
- Exercise `ex-context-add` — add role, audience and goal to *"suggest three blog post ideas"*.

### Lesson 3 — Structure & format
- Slides: **"Ask for the shape you want"** (table with named columns, "exactly 5 bullets, each
  under 12 words", tone, "under 100 words") and **"Separate instructions from content"**
  (instructions, then `---`, then the pasted material).
- Sim (order): the solution order is **context → task → format → separator → material**.
- Quiz: keep reformatting by hand → *"State the exact output format in the prompt (table /
  bullet count / length / tone)."*
- **Tour step** `pst-trylive`: navigates to the chat page and spotlights the composer —
  **"This is where you ask"**, *"This is the chat composer. After the lesson, paste a
  structured prompt here and watch how cleanly the answer comes back."* Marked `optional`
  with a 6000 ms timeout, so a missing anchor degrades to a centered card.
- Exercise `ex-structure-format` — compare three project-management tools with a pinned
  output format.

### Lesson 4 — Iterate to perfection
- Slides: **"The first answer is a draft"** and **"High-leverage follow-ups"**
  (shorter / more detailed, formal / casual, add an example, "why did you choose that?",
  "give me two more options").
- Quiz: 90 % right but long and stiff → reply in the same chat *"Cut this to half the length
  and make the tone warmer."*
- Exercise `ex-iterating-refine` — write the one follow-up that fixes a generic, too-long,
  salesy product description.

### Lesson 5 — Advanced techniques
- Slides: **"Show, don't just tell (few-shot)"** (feature→benefit worked examples) and
  **"Ask for a plan, then the work"** ("Before answering, outline your approach in 3 steps,
  then carry it out").
- Quiz: a format the model keeps missing → *few-shot examples*.
- Exercise `ex-advanced-technique` — a prompt that visibly uses few-shot **or** an explicit
  step-by-step plan.

### The rubrics (server-side, never shipped to the browser)
`server/learning/rubrics.js`. Every prompt-course rubric has **passScore 70** and three
criteria; the exercise step sets **maxAttempts 4**.

| exerciseId | Lesson | Criteria the grader scores against |
|---|---|---|
| `ex-basics-specific` | prompt-basics | adds context · states a specific unambiguous task · specifies format/length/tone |
| `ex-context-add` | prompt-context | names the writer's role/company · names the audience · states a goal |
| `ex-structure-format` | prompt-structure | clear structure (table / fixed bullets) · named columns or per-item content · length and/or tone constraint |
| `ex-iterating-refine` | prompt-iterating | targets length + generic + salesy · concrete actionable direction · a refinement, not a restart |
| `ex-advanced-technique` | prompt-advanced | visibly applies few-shot or step-by-step · technique fits the task · specific enough to follow |
| `ex-system-prompt` | **refining-prompt** (Agent Builder course, gated on `manage_agents`) | role/identity · tone · at least one always/never rule |

Two more rubrics are prompt-shaped but live in other courses: `ex-cowork-brief`
(cowork-briefs) and `ex-automation-brief` (automation-practice).

---

## 4. Concepts a learner must understand

- **Prompt** — the message you send. In Bee Flow it is whatever sits in the composer plus
  everything the composer attaches (knowledge, skills, apps, files, memory).
- **The three ingredients** — context, a clear task, an output format. Missing any one is
  what the first lesson's sim makes the learner diagnose.
- **Context** — your role, the audience, the goal. The product's own summary:
  *"Generic, off-target answers usually signal missing context, not a bad model."*
- **Role prompting** — telling the model who to be ("Act as a senior copywriter"); it primes
  tone, vocabulary and caution.
- **Output format** — the shape you demand back: a table with named columns, exactly N
  bullets, a word cap, a tone.
- **Delimiters** — a separator line (`---`) between your instructions and the pasted
  material so the model can't confuse rules with content.
- **Iteration / follow-up** — steering the existing answer in the same conversation instead
  of rewriting the prompt. The conversation is the memory; a follow-up is cheaper than a restart.
- **Few-shot** — one or two worked input→output examples; the most reliable fix when a
  specific format keeps being missed.
- **Plan-first / step-by-step** — asking for an outline before the work on multi-step tasks.
- **System prompt** — an agent's standing instructions (role + tone + always/never rules).
  Different from a chat prompt: it applies to every conversation with that agent.
- **Skill** — a saved, reusable instruction pack you attach to a chat or agent
  ("Reusable instruction packs for this chat"); the product's answer to "where do I save a
  prompt that worked?". Instructions are capped at 4000 characters.
- **Depth tier** — how hard the model thinks about this prompt (Fast / Think / Deep Thinking /
  Write / Auto). A prompt asking for a plan usually deserves a deeper tier.
- **Grounding** — attaching knowledge bases so the answer comes from your own documents with
  citations, instead of from the model's general knowledge.
- **Cowork brief** — a prompt written for unattended execution: what to produce, the detail
  that makes it useful, and when/how often it runs.
- **AI coach / rubric / passScore** — the coach grades a submission 0-100 against hidden
  criteria; ≥70 passes. The rubric stays on the server so it can't leak and the endpoint
  can't be turned into a free LLM.
- **Mastery** — every quiz and sim right on the first try, nothing revealed (and, per the
  player's own copy, the exercise without a hint). Worth +50 XP per lesson.

---

## 5. End-to-end workflows (exactly as a user clicks)

### W1 — Take the Prompt Engineering course
1. Open **Settings** → **Learning Center** (desktop; the tab does not exist on a phone).
2. If the path dialog appears (**"What do you want to get good at?"**), choose
   **"Everyday work"** — Prompt Engineering moves to the front. Or **"Skip for now"**.
3. In the left rail under **Everyday work**, click **Prompt Engineering**.
4. Read the **"About this course"** tab if you want the badge/certificate context, then
   switch back to **"Lessons"**.
5. On the row **"Anatomy of a great prompt"** click **"Play"** (or **"Beside the app"** to
   dock the player at the right and keep using Bee Flow).
6. Read slide 1 and 2, clicking **"Next"** each time.
7. On **"Diagnose the weak prompt"** drag/tap each weak prompt onto the ingredient it is
   missing, until **"All matched — nice pattern-spotting."**
8. Answer the quiz and press **"Check answer"**; a wrong pick shows **"Not quite. "** and you
   press **"Try again"**.
9. On **"Your turn: make it specific"**, type your rewrite and press **"Submit for review"**.
10. Read the score ring, **"What worked"** and **"To improve"**. Below 70 → edit and
    **"Submit again"**; stuck → **"Get a hint"**; after 4 tries the **"Skip this one"**
    button appears.
11. Press **"Finish lesson"**. The end screen shows the XP, and on the last lesson of the
    course the **"Badge earned"** panel with **Prompt Smith**.
12. Click **"Next lesson: Give it context"** and repeat for lessons 2-5.

### W2 — Write your first structured prompt in chat (the payoff)
1. Click **"New Chat"** in the sidebar.
2. Set the depth pill to **Fast** for a routine rewrite, or **Think** / **Deep Thinking**
   when you asked for a plan or analysis.
3. (Optional) Click **"Knowledge"** and pick the knowledge base the answer must be grounded
   on — the composer then reads **"Grounded on {names}"**.
4. In **"Message AI..."** type the four blocks in order: context → task → format → `---` →
   pasted material.
5. Send. Read the first answer as a **draft**.
6. Reply in the same chat with one targeted follow-up ("Cut to 120 words, drop the hype
   words, lead with the delivery date").
7. When the answer is right, keep the thread: the conversation is where the context lives.

### W3 — Get unstuck mid-lesson (AI tutor + hint)
1. On any step, click **"Ask AI"** in the player header.
2. Type the question in **"Ask a question about this step…"** and press **"Send"**.
3. The tutor answers in 2-5 sentences, grounded in the server-side product fact sheet — it
   nudges, it does not write your exercise answer.
4. On an exercise specifically, press **"Get a hint"** for one sentence prefixed **"Hint: "**.
5. Still stuck after 4 submissions → **"Skip this one"**; the lesson still completes (the
   exercise is a soft gate), but you forfeit mastery.

### W4 — Practice and review to make it stick
1. In the rail click **"Review"**, or on the overview hero **"Start review"**.
2. The session is built from your **mistakes** (a failed quiz, a quiz passed after wrong
   tries, a sim revealed or solved in more than one check) plus lessons that have gone
   **stale** (completed more than 14 days ago).
3. A session is at most **6 items**; answer each, then **"Finish review"**.
4. Alternatively open the course and press **"Practice with AI"** (or the row's
   **"Practice"**): the server generates fresh multiple-choice questions for that lesson
   from its own topic facts.
5. A right answer in review clears the matching mistake and can re-stamp mastery.

### W5 — Turn a prompt that works into something reusable
1. In chat, refine until an answer is right.
2. For a one-off repeat: keep the conversation and reply again.
3. For a recurring prompt shape: click **"Skills"** in the composer and attach an existing
   instruction pack — creating one needs `manage_skills` + the Skills feature.
4. For a standing behaviour: put role, tone and always/never rules in an **agent's System
   Prompt** (Studio → Agent Designer; needs `manage_agents`). This is exactly the
   `ex-system-prompt` exercise in the *Refining an agent* lesson.
5. For unattended work: switch the chat header to **Cowork** and write the brief — what to
   produce, the detail that makes it useful, when/how often (rubric `ex-cowork-brief`).

### W6 — Prompt with personal data (the Bee Flow-specific move)
1. Paste a customer e-mail or CV text into the composer.
2. If Privacy Shield is on for the org, **"Sensitive content detected"** appears, listing
   **"Detected items"** and naming the model the prompt would go to (**"external"** badge).
3. Choose **"Redact and send"** (names and numbers are masked before it leaves),
   **"Send anyway"**, or **"Block"**.
4. Optionally tick **"Remember my choice for this conversation"**.
5. Teach the habit: describe the case, don't paste the person — the prompt is just as good
   with "a customer" as with a name.

---

## 6. Defaults, limits and numbers

Coach / exercises
- **passScore 70** on every prompt rubric; the score is an integer clamped to 0-100.
- **maxAttempts 4** per exercise before **"Skip this one"** appears.
- Submission cap **4000 characters** (server truncates, then trims).
- A submission shorter than **3 characters** is refused without an LLM call:
  *"Give it a try first — write your prompt in the box and submit it for review."*
- Coach rate limit: **20 requests per 60 s per user** (grade and hint share it).
- Identical resubmission (same user + exercise + mode + locale + text) → cached verdict for
  **10 minutes**, no second LLM call; cache holds **500** entries per replica.
- Grading call: `maxTokens 600`, `temperature 0.2`; hint call `maxTokens 200`,
  `temperature 0.5`; both forced to JSON. Feedback truncated to **800 chars**, at most **4**
  strengths and **4** improvements.
- Model tier: the client always sends **`fast`**; the server allows `fast`, `standard`,
  `auto` and deliberately excludes `thinking`.
- Server ledger per user (`learning_exercises_user_<id>`): attempts, passed, bestScore,
  firstSeenAt, firstPassedAt. Advisory only — it does not yet gate certificates.

Tutor ("Ask AI")
- Question cap **1000 chars**, step context cap **2000 chars**, answer truncated to
  **2000 chars**; same 20/min limiter.

Practice
- **10 generations per hour** per user; grading **60 per minute**.
- Default **3** questions, maximum **6** (`MAX_ITEMS`), 3-4 choices, exactly one correct.
- A practice set lives **24 hours** (`expiresAt`); an expired set returns 404 and the UI says
  **"This practice set has expired — start a fresh review from the Learning Center."**

Review / mastery / XP
- Stale after **14 days** (`REVIEW_STALE_DAYS`); a session is **6 items**
  (`REVIEW_SESSION_SIZE`); mastery allows at most **1 attempt** per graded step
  (`MASTERY_MAX_ATTEMPTS`).
- Sims offer **"Show solution"** only from the **2nd** failed check onward.
- XP: **100** per completed lesson, **250** per completed course, **50** per mastered lesson.
  The prompt course is therefore 500 XP (750 with the course bonus, up to 1000 fully mastered).
- Levels: Larva 0 · Worker Bee 300 · Forager 800 · Guard Bee 1500 · Beekeeper 2500.
  XP is derived from progress, never stored — *"No leaderboard, no streaks."*
- Player layout: docked by default only for lessons containing action/tour steps (so
  **Structure & format** docks; the other four open as a window), **420 px** wide, always a
  window below 768 px viewport width; the choice is remembered per user.

Progress blob
- Stored server-side as `learning_progress_user_<id>` and mirrored in per-user
  localStorage. Caps: **40** steps per lesson, **2048 bytes** per step state, **64** chars
  per step id, **256 KB** per blob, future timestamps tolerated up to **24 h**.
- Writes **merge** (a stale device can't erase another device's progress); unknown lesson
  ids are dropped.

Chat-side numbers worth quoting
- Skill instructions max **4000 characters**.
- Knowledge bases per chat capped (message: *"A chat can use at most {count} knowledge
  bases."*).
- `GET /agents/conversations/all` returns the **50** most recent conversations.

---

## 7. What happens on failure

- **Coach unavailable** (no model configured, LLM error, unparseable JSON): the learner is
  never 500'd. They get `score: null`, the ring shows **"—"**, and a friendly line —
  *"The AI coach is unavailable right now — you can retry or skip ahead."*,
  *"We couldn't grade that automatically — give it another go, or skip ahead."*, or
  *"The AI coach hit a snag — you can retry or skip ahead."*
- **Rate limited (429)**: *"You're going quickly! Wait a moment, then try again — or skip
  ahead."* (tutor: *"You're going quickly! Give it a few seconds, then ask again."*)
- **Network error**: *"Couldn't reach the AI coach — check your connection, then retry or
  skip ahead."*; the hint falls back to a canned line: *"Add concrete context (who it's for,
  the goal) and pin down the exact output format."*
- **Unknown exerciseId** → HTTP 404 `{"error":"Unknown exercise"}` (the rubric catalog is the
  allow-list).
- **Practice generation fails / rate-limited** → `{ error: 'practice_unavailable', items: [] }`
  and the review session silently falls back to the bundled quiz items (soft timeout 4000 ms).
- **Learning module not installed** → `/ai/learning/*` 404s; **plan without the capability** →
  403 `feature_locked` and the Settings tab is hidden entirely.
- **Progress write too large** → 400 `too_large`; oversized or unknown entries are dropped
  rather than failing the save.
- **Exercise is a soft gate**: skipping still satisfies the step
  (`SATISFYING_STATUSES.exercise = ['passed','skipped']`), so a broken coach can never trap a
  learner in the course.

---

## 8. Permission and licence gates

- **The five prompt lessons carry `gate: {}` — no permission, no feature.** Every member who
  can open the Learning Center sees the whole Prompt Engineering course. This is the key
  fact for an everyday-audience lesson: nothing here needs an admin.
- **Learning Center itself**: `useCan('learning_center')` in the frontend hides the nav item
  and the page; the server mounts the router behind
  `requireModule('learning')` **and** `requireCapability('learning_center')`.
  `learning_center` sits in the **community** tier (`server/license/tiers.js`), so
  self-hosted installs keep it; on cloud the subscription's `allowed_beta_features` decides
  (GA beta, `core/entitlements/betaFeatures.js`).
- **Neighbouring prompt content that IS gated** (`server/learning/courseCatalog.js` LESSON_GATES,
  mirrored in `lessons.js`):
  - `refining-prompt` (the **system prompt** exercise) → `permission: manage_agents`
  - `creating-agents` → `manage_agents`; `creating-skills` → `manage_skills` + feature `skills`
  - `knowledge-bases` → `manage_knowledge` **or** `manage_agents`
  - `org-usage`, `admin-*` → `manage_users`
  - Cowork lessons are deliberately ungated (Cowork carries no licence gate).
- **Roles** (`server/config/orgRoles.json`): a plain **member** has only `use_notebooks` and
  `use_datatables` — so a member sees the prompt course but not the agent/system-prompt
  lessons. `agent_editor` / `agent_admin` / `org_admin` carry `manage_agents` and
  `manage_skills`.
- **Org-authored prompt courses**: `learning_custom_content` (Beta, org-admin only, requires
  the Learning Center) lets admins write their own courses with their own AI-graded
  exercises in **Settings → Organisation → Academy**; rubrics and quiz keys stay server-side.
- **Org learning overview** (`GET /ai/learning/org-overview`) requires
  `requirePrimaryOrgAdmin()`.
- Permission checks in code to grep: `useCan('learning_center')`, `checkPermission(user, gate.permission)`
  (`lessons.js` → `lessonVisible`), `gatePasses()` (server), `requireCapability`,
  `requireModule`, `requirePermission('manage_skills')`, `requirePrimaryOrgAdmin`.

---

## 9. How prompting connects to the rest of Bee Flow

- **Chat** — the destination of every prompt lesson; lesson 3 physically walks there.
- **Depth tiers** — "ask for a plan first" pairs with **Think** / **Deep Thinking**.
- **Knowledge bases** — a prompt grounded on your own documents needs far less context typed
  by hand; the composer says **"Grounded on {names}"**.
- **Memory** — remembered facts fill in standing context so it doesn't have to be retyped.
- **Skills** — "reusable instruction packs": the productised version of a prompt you keep
  pasting.
- **Agents** — the system prompt is a prompt with a longer lifetime (role + tone +
  always/never rules); covered by `ex-system-prompt` in *Refining an agent*.
- **Cowork** — a brief is a prompt for unattended work; `ex-cowork-brief` grades exactly
  that (concrete deliverable, the detail that makes it useful, when/how often).
- **Automations / routines** — the AI step inside a flow carries a prompt; `ex-automation-brief`
  grades trigger + data + work + destination.
- **Privacy Shield / DLP** — prompts are the main place personal data leaves a workspace;
  the redact-or-block modal is part of prompt hygiene.
- **Usage & Monitoring** — every coach and practice call is logged to the usage store as
  agent `learning-coach` / `learning-practice`, source `learning_coach` / `learning_practice`,
  so Academy usage shows up in the org's spend view.
- **Certificates** — the prompt course counts toward **Bee Flow AI Certified — Foundations**
  (together with Bee Flow Foundations) and toward **Bee Flow AI Practitioner** (any 4 courses).

---

## 10. Common mistakes (learner-facing and author-facing)

Learner mistakes the course itself calls out:
1. Asking "help me with this" — "help" is not a task.
2. Pasting material with no instruction separator, so the model treats the rules as content.
3. Never stating a format, then reformatting every answer by hand.
4. Starting a brand-new chat to fix an answer that was already 90 % right.
5. Vague follow-ups ("make it better") instead of naming length, words to drop and what to
   lead with.
6. Repeating "please use the right format" instead of showing one worked example.
7. Generic context ("for everyone, to be helpful") — the rubric explicitly refuses to pass it.
8. Pasting a customer's name, e-mail or full document when a description would do.
9. Writing a Cowork brief you would have to clarify later — nobody will be there to answer.

Author mistakes to avoid when writing lessons about this area:
- **Do not promise a three-rung hint ladder.** The course screen's copy says *"Hint ladder on
  the exercise: three rungs"*, but `ExerciseStep.jsx` ships a single **"Get a hint"** button
  (and an identical resubmission returns the cached hint for 10 minutes). Describe it as
  "a hint on request".
- Do not call the exercise a hard gate: it can always be skipped after 4 attempts, and a
  skip still completes the lesson.
- Do not say the Learning Center is in the sidebar — it is a **Settings** tab, desktop only.
- Do not tell learners the coach sees the rubric criteria in the UI; the rubric is server-only.
- Do not send an everyday learner to the *system prompt* exercise: it lives in
  `refining-prompt`, gated on `manage_agents`.
- Do not use the `standard` tier in any example (project convention: `fast` is the default,
  `standard` is never used).
- Quote lesson text from `lessons.js` fallbacks or `i18n/en-defaults.js` — those are the real
  strings; the Dutch UI is translated at runtime, so never invent an NL label.

---

## 11. Three scenarios for Van Dijk Groep (Dutch SME)

**A. Procurement — comparing three suppliers (lesson 3, Structure & format).**
Bas from inkoop has three quotes for steel profiles. Weak prompt: *"welke offerte is de
beste?"*. Strong prompt built the taught way: context (*"Ik ben inkoper bij Van Dijk Groep,
een installatiebedrijf met 60 medewerkers; we kopen staalprofielen voor een project van
6 weken"*), task (*"vergelijk de drie offertes hieronder"*), format (*"antwoord als tabel met
kolommen Leverancier, Prijs excl. btw, Levertijd, Risico, Advies; maximaal 10 woorden per cel,
neutrale toon"*), then `---` and the three quote texts. Follow-up (lesson 4):
*"Zet Levertijd voorop en voeg één regel toe: wat ik moet vragen voordat ik teken."*
Bee Flow specifics to weave in: attach the quotes as files or ground the chat on the
**Knowledge** base "Leveranciers"; set the depth pill to **Think** because this is a
comparison, not a rewrite; if a quote contains a contact person's name, choose
**"Redact and send"**.

**B. HR — a vacancy text and a rejection letter (lessons 1, 2 and 5).**
Anouk from HR needs a vacancy for a *servicemonteur*. Lesson 2 in practice: role (*"Ik doe HR
bij Van Dijk Groep"*), audience (*"mbo-4 monteurs van 25-40 in de regio Zwolle die nu bij een
grote installateur werken"*), goal (*"meer sollicitaties van mensen met F-gassen certificaat"*).
Lesson 5 in practice: few-shot — paste two earlier vacancies that worked and say *"schrijf de
nieuwe in dezelfde toon"*. For the rejection letters: **never paste the applicant's CV or
name**; describe the case (*"een kandidaat zonder F-gassen certificaat"*) and let the template
come back with `[naam]` placeholders. If Privacy Shield flags a pasted CV, the honest move is
**"Block"** and rewrite the prompt without the person. A recurring monthly "wervingsupdate" is
the moment to switch from chat to a **Cowork brief**.

**C. Sales — a quote follow-up sequence (lessons 1, 4 and Skills).**
Jeroen in sales writes follow-ups after a quote goes out. First prompt: context (*"Ik ben
accountmanager bij Van Dijk Groep, we hebben een offerte voor een warmtepompinstallatie van
€ 18.000 uitgebracht aan een VvE"*), task (*"schrijf een opvolgmail na 5 werkdagen stilte"*),
format (*"maximaal 120 woorden, vriendelijk-zakelijk, één concrete vraag aan het eind, geen
kortingen noemen"*). The first answer comes back too salesy; the taught follow-up is
*"Halveer de lengte, schrap 'vrijblijvend' en 'uniek', begin met de opleverdatum en eindig met
één vraag."* Once the shape is right, that becomes a **Skill** ("Opvolgmail offerte") so the
whole sales team reuses it — creating it needs `manage_skills`, so Jeroen asks the org admin,
which is a natural bridge to the Agent Builder track.

---

## 12. API endpoints a "did the learner do it?" check can call

All paths are relative to the API origin as the frontend calls them (`API_BASE` is the server
origin, **no `/api` prefix on the `/ai` and `/agents` routers**; `/api/...` routes are mounted
separately). Every one below requires an authenticated session (`requireAuth` /
`req.session.user`). The `/ai/learning/*` routes additionally need the `learning` module and
the `learning_center` capability.

| Method | Path | What the JSON contains | Auth / gate |
|---|---|---|---|
| GET | `/ai/user-settings` | Big settings object; the field to read is **`learningProgress`** = `{ [lessonId]: { completedAt, masteredAt?, steps: { [stepId]: { status, score, attempts, submission, feedback, strengths, improvements, answeredAt, wrongChoiceIds } } } }`. For prompting check `prompt-basics`…`prompt-advanced` and the exercise step ids `pb-ex`, `pc-ex`, `pst-ex`, `pit-ex`, `pad-ex` (status `passed` / `failed` / `skipped` + `score`). Owner = the session user (server reads `learning_progress_user_<id>`; no other user's row is reachable). | `requireAuth` |
| POST | `/ai/user-settings` | Writes `learningProgress` (merged + sanitized), `learningProgressReset`, `learningPath`. | `requireAuth` |
| GET | `/ai/learning/catalog` | `{ version: '2026.1', tracks, courses: [{ id, track, title, lessonIds, prereqCourseIds, badge: { id, title } }], certificates, lessonGates, lessonIds, practiceLessonIds }` — plus published org courses when entitled. Cached `private, max-age=300`. Use it to resolve which lessons the Prompt Engineering badge needs. | `requireAuth` + module + capability |
| GET | `/ai/learning/achievements` | `{ badges: [...recomputed server-side...], certificates: [{ certificateId, title, level, eligible, issued, isPublic, progress, issuedAt?, ...urls }], version }`. **`badge-prompt-smith` present ⇒ all visible prompt lessons complete.** Scoped to the calling user. | `requireAuth` + module + capability |
| POST | `/ai/learning/coach` | Body `{ exerciseId, mode: 'grade'\|'hint', submission, modelTier, locale }` → `{ score, passed, feedback, strengths[], improvements[] }` or `{ hint }`. Not a list endpoint, but it is what stamps the server-side attempt ledger. | `requireAuth`, 20/min |
| POST | `/ai/learning/tutor` | `{ question, lessonId, stepId, stepContext, locale }` → `{ answer }`. | `requireAuth`, 20/min |
| POST | `/ai/learning/practice/generate` \| `/practice/grade` | `{ practiceId, items[], expiresAt }` / `{ correct, explanation, correctChoiceIds? }`. | `requireAuth`, 10/h and 60/min |
| GET | `/ai/learning/org-overview` | Per-member rows for the caller's own org: user id/name, completed courses, badges, certificates (ids, levels, dates — never serials) and `lastActivity`. The only endpoint that can verify **someone else's** progress. 60 s cached. | `requireAuth` + `requirePrimaryOrgAdmin()` |
| GET | `/ai/direct/conversations` | Array of the caller's direct chats: `id, title, model_tier, project_id, shared_scope, pinned, labels_json, created_at, updated_at`. Owner is implicit (filtered on `user_id`). Good for "did they actually open a chat and send something". | `requireAuth` |
| GET | `/agents/conversations/all` | Up to **50** most recent agent conversations: `id, agent_id, user_id, title, project_id, pinned, labels_json, created_at, updated_at, agent_name, agent_avatar`. Has an explicit **owner field** (`user_id`). | session user (`getEffectiveUserId`) |
| GET | `/api/cowork` | `{ schedules: [{ id, title, prompt, agentId, agentName, nextRunAt, lastRunAt, repeatInterval, isActive, runCount, ... }] }` — used by the Cowork action check (`created` / `ran`). Verifies a written brief. | `requireAuth` |
| GET | `/api/skills` | Array of skills visible to the caller, each with `canEdit` and `lastTest {status, adviceCount, ranAt}`. Verifies "turned a prompt into a reusable instruction pack". | `requireAuth` (+ `skills` capability on the mount) |
| GET | `/agents` | Bare array of agents; rows carry `owner_id` and `is_published`. Used by `evaluateAgentCreated` to prove an own (non-`system`/`swarm`) agent exists — relevant only to the gated system-prompt lesson. | `requireAuth` |

Note: there is **no** endpoint that lists the exercise attempt ledger
(`learning_exercises_user_<id>` is written by the coach route but never served), and there is
no per-lesson "completed" endpoint beyond the `learningProgress` blob. A verification check
for prompting should therefore read `GET /ai/user-settings` → `learningProgress` (per-step
detail, including the coach score) and/or `GET /ai/learning/achievements` (the
`badge-prompt-smith` badge).

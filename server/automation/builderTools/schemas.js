/**
 * Builder-agent tool schemas (§WS5, extracted verbatim from builderTools.js).
 * NOTE: applyToolCall mutates this array in place (scope/forEach/error-branch
 * injection) via the imported reference — same object, so the mutation is shared.
 */

const BINDING_HINT = 'Each input value must be a binding: {"kind":"literal","value":...} OR {"kind":"ref","path":"steps.<id>.output.<field>"} OR {"kind":"template","value":"... {{steps.x.output.y}} ..."} OR {"kind":"expr","value":"<restricted-js>"}.';

// Derived from the trigger-source declarations rather than typed out here: the
// hand-written lists had drifted into promising events that no longer exist.
const { providerList: APP_EVENT_PROVIDERS, eventList: APP_EVENT_EVENTS } =
    require('../triggerSources/describe').describeSourcesForPrompt();

// Likewise derived rather than typed out: the apps an `app_pick` question can
// offer come from the same registry the submit route validates against
// (automation/formPickSources.js), so the model is never told about a source
// the server would then refuse.
const PICK_SOURCES = require('../formPickSources').catalog()
    .map(sc => `${sc.id} (${sc.label})`).join(', ');

const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'builder_propose_trigger',
            description: `Set or replace the automation trigger. ALWAYS call this first when starting a new draft.

KIND OPTIONS:
  - schedule     — fires on a cron timer (5-field cron, minute hour dom month dow).
  - manual       — fires only when the user clicks "Run".
  - webhook      — fires on inbound HTTPS POST to a signed URL.
  - form         — Bee Flow hosts a public page; every submission is one run. Declare the questions in \`form.fields\`; answers arrive as trigger.output.<fieldName>.
  - app_event    — fires when a connected service emits an event (see appProvider for what this install offers).

SCHEDULE EXAMPLES:
  - weekly Monday 9am Europe/Amsterdam → {kind:"schedule",cron:"0 9 * * 1",tz:"Europe/Amsterdam"}
  - first Monday of the month at 9am  → {kind:"schedule",cron:"0 9 1-7 * 1",tz:"Europe/Amsterdam"}

APP_EVENT TRIGGERS (pick the most specific; use filters to narrow):

  ── Gmail ──
  • mail.new — fires on every new email. Most-asked Gmail trigger.
    Filters: from, to, cc, subjectContains, subjectRegex, labelIds[],
             excludeLabelIds[], hasAttachment, excludeFromSelf, maxAgeMinutes.
    Payload: {messageId, threadId, from, to, cc, subject, date, snippet,
             labelIds, sizeEstimate, historyId}.
    EXAMPLE — only emails from your boss:
      {kind:"app_event",appProvider:"gmail",appEvent:"mail.new",
       filter:{from:"boss@example.com",excludeFromSelf:true}}
    **Replying**: when adding a gmail_compose step to reply, ALWAYS bind
    replyToMessageId: trigger.output.messageId. Without it Gmail renders
    the reply as a fresh standalone email instead of inline in the
    original conversation — even if you also pass threadId.
    NOTE — "in the last 24 hours" is NOT a filter for mail.new because it
    fires on every newly-arrived message in real time. For "every morning
    summarise yesterday's email", use a schedule trigger + a gmail_search
    step with q:"newer_than:1d" instead.

  • label.added — fires when a label is applied (manually or by a Gmail
    filter rule). Useful for "when I label something 'urgent', do X".
    Filters: labelId (REQUIRED), from, subjectContains, excludeLabelIds[].
    Payload: {messageId, threadId, addedLabelIds, from, to, subject,
             snippet, labelIds, date}.
    EXAMPLE: {kind:"app_event",appProvider:"gmail",appEvent:"label.added",
             filter:{labelId:"Label_3"}}

  ── Google Calendar ──
  • event.changed — fires when any event in the user's primary calendar
    is created, updated, or cancelled.
    Filters: calendarId, statusEquals ("confirmed"/"cancelled"),
             attendeeEmailContains.
    Payload: {eventId, summary, description, start, end, status,
             calendarId, organizer, attendees, htmlLink}.

  • event.upcoming — fires N minutes BEFORE an event starts. Best for
    "remind me 15 min before any meeting" workflows.
    Filters: leadMinutes (default 15), calendarId, includeAllDay (default
             false), attendeeEmailContains.
    Payload: same as event.changed plus {minutesUntilStart}.
    EXAMPLE: {kind:"app_event",appProvider:"google-calendar",
             appEvent:"event.upcoming",filter:{leadMinutes:15}}

  ── Google Drive ──
  • file.new — fires when a file is created (not modified) in the user's
    Drive.
    Filters: folderId, mimeType, nameContains, excludeOwnUploads.
    Payload: {fileId, name, mimeType, parents, createdTime, owners,
             webViewLink}.
    EXAMPLE — PDFs landing in /Invoices folder:
      {kind:"app_event",appProvider:"google-drive",appEvent:"file.new",
       filter:{folderId:"<drive-folder-id>",mimeType:"application/pdf"}}

  ── Nextcloud ──
  Two delivery mechanisms, and the choice is NOT free:

    webhook — Nextcloud pushes to the Bee Flow ExApp within seconds. Only
              possible for Files, system tags, Calendar, Forms and Tables:
              those are the only event classes Nextcloud exposes to webhooks.
    poller  — read off the activity feed on the ~60s poll tick. No connector
              needed.

    bot     — Talk chat events, delivered by the Bee Flow Talk bot. The bot only
              sees conversations a moderator has added it to, so tell the user
              to add "Bee Flow" to the conversation they mean.

  Share has NONE of these. Nextcloud does not expose share.created to webhooks
  and there is no poller for it, so a routine triggered on it WILL NEVER FIRE.
  Do not propose it. If the user asks
  for "when a file is shared", say plainly that Nextcloud cannot notify us of
  that yet, and offer a scheduled routine that polls with the matching read
  tool instead (e.g. a daily schedule + nextcloud_list_shares).

  ── Deck (webhook) ──
  • deck.card.created / deck.card.changed / deck.card.deleted
    Payload: {cardId, boardId, stackId, title, description, done, archived,
             duedate, labels[], assignedUsers[], actor, datetime}.
             "done" is a completion TIMESTAMP or null — truthy when finished.
  • deck.card.completed / deck.card.moved
    Derived by the connector from the same update event, by comparing against
    the last state it saw for that card. deck.card.moved also carries
    previousStackId. A card the connector has never seen before produces only
    deck.card.changed — so these are reliable in steady state but do not fire
    on the very first change after a connector restart. Say so if the user is
    building something where a single missed transition matters.

  ── Files (webhook; file.new / file.changed also have a poller) ──
  • file.new / file.changed / file.deleted / file.renamed
    Filters: inFolder (path prefix), extension, nameContains,
             excludeOwnUploads, any[]/none[]/expr/age (rich filter DSL).
    Payload: {id, path, name, extension, kind, actor, datetime, link}.
             file.renamed also carries {oldPath}.
             Paths are user-relative ("/Documents/x.pdf").
             NOTE: file.deleted carries no id — Nextcloud omits it once the
             node is gone. Bind path, not id.
    EXAMPLE — PDFs landing in /Invoices:
      {kind:"app_event",appProvider:"nextcloud",appEvent:"file.new",
       filter:{inFolder:"/Invoices",extension:"pdf"}}

  • file.tagged — fires when a system tag is assigned to a file.
    Filters: tagId (NUMERIC id — get it from nextcloud_list_tags).
    Payload: {fileId, objectIds, tagId, tagIds, objectType, actor, datetime}.
    NOTE: Nextcloud's tag event carries ids only — there is NO tag name and NO
    file path in it. Never filter on a tag name here; look the id up first.
    nextcloud_read_file takes a PATH, not an id: to reach the contents, call
    nextcloud_find_files_by_tag with trigger.output.tagId (its items carry
    path AND id — pick the item whose id equals trigger.output.fileId), then
    nextcloud_read_file with that path; for a download URL use
    nextcloud_direct_link with trigger.output.fileId.

  ── Forms (webhook) ──
  • forms.submitted — fires when someone submits a Nextcloud Form.
    Filters: formId, formHash, titleContains, submittedByEquals.
    Payload: {formId, formHash, formTitle, formOwner, submissionId,
             submittedBy, submittedAt, actor, datetime}.
    The answers are NOT in the trigger payload. Follow it with
    nextcloud_forms_get_submissions bound to trigger.output.formId and
    trigger.output.submissionId — that returns answers keyed by question text,
    so later steps can bind {{steps.<id>.output.submissions[0].answers.<Question>}}.
    EXAMPLE:
      {kind:"app_event",appProvider:"nextcloud",appEvent:"forms.submitted",
       filter:{formId:51}}

  ── Tables (webhook) ──
  • tables.row.added / tables.row.updated
    Filters: tableId, actorEquals, and a value test on one column:
             columnId (NUMERIC) + valueEquals | valueContains, plus
             changedOnly:true to fire only when that column actually changed
             (tables.row.updated only).
    Payload: {tableId, rowId, values, actor, datetime}; tables.row.updated
             also carries {previousValues}.
    NOTE: values are keyed by NUMERIC column id in the trigger payload, because
    the event carries no column titles. Get ids from
    nextcloud_tables_list_columns. (The nextcloud_tables_* ACTION tools are the
    other way round — they take and return column titles.)
    EXAMPLE — a status column flipping to "approved":
      {kind:"app_event",appProvider:"nextcloud",appEvent:"tables.row.updated",
       filter:{tableId:34,columnId:13,valueEquals:"approved",changedOnly:true}}

  ── Sharing ──
  • share.received (poller) — fires when something is shared WITH the user.
    Filters: actorEquals, nameContains, kindEquals ("file"/"folder").
    Payload: {activityId, path, name, kind, actor, datetime, link}.
  • share.created — NO PRODUCER, see the warning above.

  ── Calendar ──
  • calendar.event.upcoming (poller) — fires N minutes before an event starts.
    This is the one to use for meeting prep; it is the only calendar trigger
    with the event details in its payload.
    Filters: leadMinutes (default 15), calendarId, summaryContains.
    Payload: {uid, calendarId, summary, startsAt, endsAt, location, attendees,
             minutesUntilStart, actor, datetime}.

  • calendar.event.created / calendar.event.changed (webhook)
    Filters: calendarId.
    Payload: {uid, objectUri, calendarId, calendarUri, actor, datetime}.
    NOTE: Nextcloud's calendar webhook carries object METADATA only — summary,
    startsAt, endsAt and location arrive NULL. Do not filter on summaryContains
    here and do not bind trigger.output.summary. Follow the trigger with
    nextcloud_calendar_get_event (calendar: trigger.output.calendarUri,
    uid: trigger.output.uid) to read the actual event.

  ── Talk (bot) ──
  Both require the "Bee Flow" bot to be added to the conversation. Say so when
  proposing one — otherwise the routine activates and stays silent.

  • talk.message.received — fires on every message in a conversation the bot is in.
    Filters: roomToken, roomNameContains, actorEquals, messageContains,
             excludeOwnMessages.
    Payload: {messageId, roomToken, roomName, actor, actorName, message,
             isMarkdown, inReplyTo, datetime}.
    EXAMPLE — react to questions in one room:
      {kind:"app_event",appProvider:"nextcloud",appEvent:"talk.message.received",
       filter:{roomToken:"a1b2c3d4",messageContains:"?"}}

  • talk.reaction.added — fires when someone reacts to a message with an emoji.
    Filters: roomToken, roomNameContains, actorEquals, reaction (a single
             emoji), includeRemoved (default false — un-reacting does not fire).
    Payload: {messageId, roomToken, roomName, actor, actorName, reaction,
             removed, datetime}.
    Use this for reacting to a 👍 as an EVENT, not as an approval gate: to make
    a routine wait for a person's decision, call builder_add_approval, which
    pauses the run in place and records who decided and why.

  ── Generic (poller) ──
  • activity.new — power-user catch-all over the activity feed.
    Filters: type, objectNameContains, actorEquals.
    Payload: {activityId, type, subject, message, actor, objectName, link,
             datetime}.

  • notification.new — fires on Nextcloud system notifications.
    Filters: app, subjectContains.
    Payload: {notificationId, app, subject, message, link, datetime}.

  ── Meeting Notes ──
  • meeting.processed — fires when a meeting note is ready to read: after an
    ingest, after a reprocess, and after a summary is regenerated.
    Filters: tags[] (ANY-of, exact and case-sensitive), reprocessed.
    Payload: {transcriptionId, tags, orgId, reprocessed}.
    LEAVING \`tags\` OUT (or empty) MEANS EVERY FINISHED MEETING — it is not a
    "match nothing". Only pass tags the user actually named; never invent one.
    EXAMPLE — only meetings tagged sales, and not on a re-run:
      {kind:"app_event",appProvider:"meeting-notes",appEvent:"meeting.processed",
       filter:{tags:["sales"],reprocessed:false}}
    The payload deliberately carries NO summary, title or attendees — a meeting
    note is a transcript of colleagues talking. AND THERE IS NO STEP THAT READS
    A NOTE BY ID: no action takes a transcriptionId (transcribe_audio takes an
    uploaded FILE, not an existing note). So build the rule on WHICH meeting
    finished, not on its content — pass trigger.output.transcriptionId on as a
    reference (a notification, a datatable row, a knowledge_write about the
    tags) and let the person open the note in Bee Flow. Never promise the user
    a step that fetches the transcript; it does not exist.


GENERAL: bind the trigger payload via trigger.output.<field>. DO NOT add a
leading search step just to look up data that's already in the payload.`,
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['schedule', 'manual', 'webhook', 'form', 'app_event', 'agent_call', 'app_trigger'] },
                    form: {
                        type: 'object',
                        description: 'When kind=form: the public page Bee Flow hosts. Answers arrive as trigger.output.<fieldName>. Field `name` must be an identifier (letters/digits/underscore, no leading underscore) and is what you bind — it never changes when the label does.',
                        properties: {
                            title: { type: 'string' },
                            description: { type: 'string' },
                            submitLabel: { type: 'string' },
                            successMessage: { type: 'string' },
                            fields: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        type: { type: 'string', enum: ['text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox', 'file', 'app_pick'] },
                                        label: { type: 'string' },
                                        required: { type: 'boolean' },
                                        placeholder: { type: 'string' },
                                        options: { type: 'array', items: { type: 'string' }, description: 'Required when type=select.' },
                                        accept: { type: 'string', description: 'When type=file: a MIME allowlist, e.g. "application/pdf,image/*".' },
                                        maxSizeMb: { type: 'number', description: 'When type=file: 1–25.' },
                                        source: { type: 'string', description: `REQUIRED when type=app_pick: which app the person filling the form searches. One of: ${PICK_SOURCES}. The search runs against THEIR OWN account, so use this instead of asking someone to paste a transcript or forward an email.` },
                                        multiple: { type: 'boolean', description: 'When type=app_pick: let them pick several records. The answer is then a LIST of descriptors instead of one.' },
                                        maxItems: { type: 'number', description: 'When type=app_pick and multiple: 1–10 (default 5).' },
                                        withText: { type: 'boolean', description: 'When type=app_pick: read the record\'s content into the run (default true). Set false when only a reference is wanted.' },
                                        // A file field binds as an OBJECT, never a string:
                                        // trigger.output.<name> is { kind, fileId, filename, mimeType, size,
                                        // text, textTruncated, textError }. `.text` is the extracted content —
                                        // a workbook as one markdown table per sheet, a PDF as its text layer —
                                        // so an ai_step reads the document by binding
                                        // trigger.output.<name>.text, NOT trigger.output.<name>.
                                        //
                                        // An app_pick field binds the same way: trigger.output.<name> is
                                        // { kind:'app_pick', source, app, recordId, title, url, text,
                                        // textTruncated, textError } — or a LIST of those when `multiple`.
                                        // `.text` is the transcript / email body / note, so an ai_step binds
                                        // trigger.output.<name>.text, never trigger.output.<name>.
                                    },
                                    required: ['name', 'type', 'label'],
                                },
                            },
                        },
                    },
                    cron: { type: 'string', description: 'Standard 5-field cron, REQUIRED when kind=schedule. Use exact format: minute hour day-of-month month day-of-week. Example: "0 9 * * 1" = every Monday at 9:00.' },
                    tz: { type: 'string', description: 'IANA timezone, e.g. Europe/Amsterdam (when kind=schedule).' },
                    appProvider: { type: 'string', description: `Provider id (when kind=app_event): ${APP_EVENT_PROVIDERS}` },
                    appEvent: { type: 'string', description: `Event name (when kind=app_event). Allowed: ${APP_EVENT_EVENTS}.` },
                    filter: { type: 'object', description: 'Optional filter object. Use ONLY the keys listed under the event above — several events have their own matcher (a tag list is an ANY-of, not an equality), and unknown keys are ignored rather than rejected. An omitted or empty filter means "every event of this kind", never "no events".' },
                    // §28 agent-callable trigger: routine is exposed as a tool the agent / direct chat can invoke.
                    toolName: { type: 'string', description: 'When kind=agent_call: the tool name agents will see (sanitised to [a-z0-9_]). Defaults to automation_<id>.' },
                    parametersSchema: { type: 'object', description: 'When kind=agent_call: JSON-schema-shaped input declaration for the tool. The runtime exposes this verbatim to the model.' },
                    // App trigger: the routine is fired by a Studio App action with typed inputs.
                    params: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Identifier (letters/digits/underscore, no leading underscore).' },
                                type: { type: 'string', enum: ['string', 'number', 'boolean', 'array', 'object', 'file'] },
                                required: { type: 'boolean' },
                                description: { type: 'string' },
                            },
                            required: ['name', 'type'],
                        },
                        description: 'When kind=app_trigger: the typed inputs a Studio App action passes. Bind them in steps as trigger.output.<name>. A `file` input arrives at runtime as { fileId, name, mime, size, url } — bind trigger.output.<name>.url into steps that fetch the file (http_request, transcribe_audio, upload tools).',
                    },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_action',
            description: `Append an integration action that calls a real connected tool. The tool name MUST match the catalog exactly. ${BINDING_HINT} EXAMPLE — search Gmail for unread invoices: {tool:"gmail_search",inputs:{query:{kind:"literal",value:"label:Invoices is:unread"},maxResults:{kind:"literal",value:20}},label:"Find invoices"}. EXAMPLE — read EVERY email a previous search found, as ONE step (no loop container): {tool:"gmail_read",inputs:{messageId:{kind:"ref",path:"loop.e.id"}},forEach:{overRef:"steps.a_1a2b3c.output.messages",itemVar:"e"}} — the next step then runs per result with its own forEach over steps.<thisId>.output.results. NEVER pass plain strings as input values; ALWAYS wrap in {kind,...}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string', description: 'Insert after this step id. Default: last step.' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    tool: { type: 'string', description: 'Exact tool name from the catalog (e.g. gmail_search, gmail_compose, calendar_create_event).' },
                    inputs: { type: 'object', description: `Map of input-name to a binding object. ${BINDING_HINT}` },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string', description: 'Short human-readable label for the diagram.' },
                },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_ai_step',
            description: `Append an AI reasoning step that transforms or summarises upstream data. By default no tool calls — set allowTools:true (and optionally a tools allowlist) when this step needs to fetch data on its own (web search, Gmail lookup, etc.). The user's per-org integration permissions are still enforced at runtime. Use this for: extracting structured fields from text, summarising, classifying, drafting reply text, OR (with allowTools) free-form research that doesn't fit a static integration_action. Split your instructions: put the role/persona/tone/output-style in \`systemPrompt\` and the concrete per-run task + data references in \`prompt\`. To have an EXISTING agent do the step instead of writing a persona by hand, set \`agentId\` (and, deliberately, whichever of \`agentPermissions\` the user asks for — every one you omit is off). ${BINDING_HINT} EXAMPLE — extract invoice fields from EACH email the previous forEach step read (chained forEach, no loop container): {systemPrompt:"You are a meticulous bookkeeping assistant. Respond only with valid JSON.",prompt:"Extract amount, currency, vendor, dueDate from this invoice email.",inputs:{emailBody:{kind:"ref",path:"loop.r.output.body"}},forEach:{overRef:"steps.a_1a2b3c.output.results",itemVar:"r"},outputSchema:{type:"object",properties:{amount:{type:"number"},currency:{type:"string"},vendor:{type:"string"},dueDate:{type:"string"}}},modelTier:"fast"}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    systemPrompt: { type: 'string', description: 'Optional. The role/persona/output-style instruction for the AI (the system prompt) — e.g. "You are a meticulous financial analyst. Always answer in Dutch." Put WHO the model is and HOW it should behave here; put WHAT to do this run (the task + data references) in `prompt`. Omit for trivial one-off transforms to use the default automation-step system prompt.' },
                    prompt: { type: 'string', description: 'The task instruction for this run. Reference the inputs by name. Put persona/tone/output-style in `systemPrompt`, not here.' },
                    inputs: { type: 'object', description: `Map of binding-name to a binding object. ${BINDING_HINT}` },
                    outputSchema: { type: 'object', description: 'JSON schema describing the desired structured output. Strongly recommended so downstream steps can reference fields.' },
                    modelTier: { type: 'string', description: 'MUST be one of the tiers listed under "ai_step modelTier" in the system prompt — those are the only tiers configured for this user; anything else is rejected. Default: auto (classifier picks the tier per prompt complexity).' },
                    allowTools: { type: 'boolean', description: 'Default false. When true the AI step can call the user\'s integration tools (web search, gmail_search, etc.). Use sparingly — most steps should bind upstream integration_action output instead.' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist of tool names the AI step may call. Empty / omitted = whatever allowTools dictates.' },
                    useMemory: { type: 'boolean', description: 'Default false. When true the step is grounded in the routine owner\'s personal memory (what they told the chat assistant about themselves, their preferences and their contacts): the memories most relevant to this step\'s prompt are added to the system prompt before the model answers. Use for steps that write in the owner\'s name or decide on their behalf (reply drafts, briefings, prioritising); never for pure data transforms.' },
                    knowledgeBaseIds: { type: 'array', items: { type: 'string' }, description: 'Optional. Ids of knowledge bases to ground this step in — searched ONCE per run (keyed off the routine owner\'s own knowledge bases, never a per-user picker) and injected into the system prompt as reference material before the model answers. Use for steerable reference content (a brand style guide, a positioning doc, a policy) the step should follow without hardcoding it into the prompt. Never invent an id — only ids the user has actually shown you (e.g. from the Knowledge Bases admin) are valid.' },
                    agentId: { type: 'string', description: 'Optional. Id of an EXISTING agent that does the thinking for this step: its published role, its knowledge and its tools replace the bare step. The agent must belong to the routine owner\'s own organisation and be published — an id that was deleted, sits in another workspace or was never published all get the SAME refusal (`ai_step.agent_unavailable`), so this is not a way to find out which agents exist elsewhere. Never invent one: only ids the user has actually shown you are valid, and anything else is refused at save and refused again at run time.' },
                    skillIds: { type: 'array', items: { type: 'string' }, description: 'Optional. Ids of skills to apply to this step, MOST IMPORTANT FIRST — the first one is the leading skill (its output fields are merged into the step\'s own). At most 5 are used; anything past that is ignored. Works with or without `agentId`. Never invent an id.' },
                    disabledAgentSkillIds: { type: 'array', items: { type: 'string' }, description: 'Optional, only with `agentId`: ids of the AGENT\'s own skills this step does not use. The step\'s own `skillIds` are never affected and stay leading. Omit to use every skill the agent has.' },
                    agentPermissions: {
                        type: 'object',
                        description: 'Optional, and only meaningful together with `agentId`: what the agent may do INSIDE this step. Exactly three booleans — startAutomations, useKnowledge, useTools — and every one you leave out is FALSE. There is no "unset means everything" here: omit the object and the agent answers from its role alone, with no knowledge bases, no tools and no ability to start other routines. Ask the user before turning any of them on.',
                        properties: {
                            startAutomations: { type: 'boolean', description: 'Default false. May the agent start other routines from this step? Only routines the ROUTINE OWNER can already run AND the agent\'s owner granted it.' },
                            useKnowledge: { type: 'boolean', description: 'Default false. May the agent search its own knowledge bases here? Each one is still re-checked against the routine owner, so a base they may not read is dropped.' },
                            useTools: { type: 'boolean', description: 'Default false. May the agent call its integration tools here? Anything that would need a person to confirm it is left out — nobody is watching a routine run — so add an approval step after this one if the work has to be confirmed.' },
                        },
                    },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_condition',
            description: 'Append an if/else branch. The expr is a restricted JS expression — member access, comparisons, &&, ||, ?:, math, and the whitelisted helpers (contains, startsWith, endsWith, lower, upper, len, isEmpty, round, coalesce, parseJson, …), e.g. contains(lower(trigger.output.subject), "invoice"). EXAMPLES: "steps.parse.output.amount > 1000", "steps.s1.output.count == 0", "loop.email.subject == \\"Urgent\\"". To grow a branch, call builder_add_action / builder_add_ai_step / builder_add_notification with afterStepId set to this condition\'s id — the edge is AUTO-labelled "then" on the first append and "else" on the second. Pass branch:"then"|"else" on that call to be explicit. Use thenStepId/elseStepId here only to wire EXISTING steps as branches.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    expr: { type: 'string', description: 'Restricted JS expression — comparisons, &&/||, ?:, math and the whitelisted helper functions (contains, lower, len, isEmpty, …).' },
                    thenStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "then" branch.' },
                    elseStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "else" branch.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is itself a condition: which of ITS branches this nested condition begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this condition begins.' },
                    label: { type: 'string' },
                },
                required: ['expr'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_loop',
            description: `RARELY NEEDED — read this before using it. For per-item work, CHAIN per-step \`forEach\` instead: a second forEach over the first one's \`output.results\` still sees its own item (\`loop.<v>.item\` is the original, \`loop.<v>.output\` is that item's result), so "read each file, then extract from each file" is TWO flat forEach steps, NOT a loop. A loop also fails ALL-OR-NOTHING — one bad item aborts the whole run — whereas chained forEach records the failure per item and carries on, so the flat form is more correct as well as simpler.
Use a loop ONLY when the per-item body genuinely needs a SUB-DAG: body steps that branch (a condition inside the body), or two steps that must both read the SAME source item without one consuming the other's aggregate output.
The body is a sub-DAG run once per item; refer to the current item as loop.<itemVar>. ${BINDING_HINT} EXAMPLE — a body that BRANCHES, which is what justifies a loop: {overRef:"steps.a_1.output.rows",itemVar:"row",maxIterations:50,body:[{type:"condition",expr:"loop.row.total > 1000"},{type:"notification",title:"Large amount",body:"{{loop.row.id}}"}]}. IMPORTANT: every body step MUST have a "type" field; the system will assign ids if missing.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    overRef: { type: 'string', description: 'Path to the array, e.g. steps.search.output.items.' },
                    itemVar: { type: 'string', description: 'Loop variable name; available inside body as loop.<itemVar>.' },
                    body: { type: 'array', description: 'Sub-DAG step objects (linear). Each must include "type". "id" is auto-assigned if missing.' },
                    maxIterations: { type: 'integer', description: 'Cap, default 100, max 1000.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['overRef', 'itemVar'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_code_step',
            // NO ctx.secrets in this description, deliberately. It was listed here
            // for a long time while the runner had no secret store behind it at all
            // (runState.secrets is initialised to {} and never written), so a model
            // that took this description at its word wrote ctx.secrets('stripe_key'),
            // got null at run time, and shipped a step that authenticated to a third
            // party with nothing. The capability now throws instead of returning
            // null, and advertising a throw to the author is worse than saying
            // plainly that there is no secret access — so we say it plainly.
            //
            // The parameters paragraph is the step's input FORM: the step
            // settings parse the JSDoc on main (automation/codeSafety,
            // analyzeCode().params) and render one field per @param, with its
            // description as the help text, so a person who never reads the
            // code can fill it in. A code step whose inputs are not declared
            // shows them as bare "Other inputs" with no explanation.
            description: 'Append a sandboxed JavaScript step, for work no integration and no declarative step expresses. Code receives `inputs` and `ctx` (ctx.log, ctx.http for HTTPS to public hosts, ctx.integrations.<tool> for the tools in allowedTools). There is NO secret access from code: ctx.secrets() throws, and declaring secretKeys makes the step fail — any credential or key the code needs must come in through `inputs`, or via an integration tool that carries its own credentials. Define `async function main(inputs, ctx)` and return the result. PARAMETERS: put a JSDoc block on main with a first line saying what the step does and one `@param {type} inputs.<name> - <short description a non-programmer understands>` per input the code reads (`[inputs.name]` optional, `[inputs.name=value]` with a default; types string, number, integer, boolean, object, array, string[], \'a\'|\'b\' choices, date, datetime, email, url); the step settings show these as a form, and the keys of `inputs` below are those names. Write ctx.http URLs as literal https:// strings so the safety check can see where data goes. Memory, CPU, wall clock and the ctx.http call budget are yours to set through `limits` (see that parameter) — within the sandbox ceiling, which refuses anything above it.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    code: { type: 'string', description: 'JavaScript source: a JSDoc block (what the step does, then one `@param {type} inputs.<name> - <description>` per input), then `async function main(inputs, ctx) { ... return result; }`.' },
                    inputs: { type: 'object', description: 'One binding per declared @param, keyed by its name: {amount:{kind:"ref",path:"steps.<id>.output.total"}}. A param with a default may be left out.' },
                    outputSchema: { type: 'object' },
                    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this step may call via ctx.integrations.<tool>(args).' },
                    // The sandbox has clamped these four on every run since it
                    // was written, but no caller could name them: applyAddCode
                    // hardcoded three of them and ignored whatever was asked
                    // for, and this schema did not mention the block at all.
                    // So the ceiling was real and the dial was missing — a
                    // step that needed eight seconds of wall clock for a slow
                    // API had no way to say so. The ranges are stated here
                    // rather than left to be discovered, because the model's
                    // code runs for the first time in the USER's dry run: it
                    // cannot learn a ceiling by hitting it. Out of range is
                    // REFUSED (with the real bound named), never clamped —
                    // being quietly handed something other than what you asked
                    // for is how a step comes to lie about what it runs with.
                    limits: {
                        type: 'object',
                        description: 'Optional resource ceiling for this step. Omit for the defaults (memoryMb 64, cpuMs 1000, wallMs 5000, httpBudget 5). Ask for what the step needs and no more: code steps run IN-PROCESS, so a fat limit slows every other run on the same host. A value outside its range is refused, not clamped.',
                        properties: {
                            memoryMb: { type: 'integer', description: 'Isolate heap in MB. 8..256, default 64.' },
                            cpuMs: { type: 'integer', description: 'V8 CPU time in ms. 50..10000, default 1000. Raise it for heavy in-memory work, never for waiting.' },
                            wallMs: { type: 'integer', description: 'Wall clock in ms, ctx.http waits included. 100..30000, default 5000. This is the one to raise for a slow API.' },
                            httpBudget: { type: 'integer', description: 'How many ctx.http calls the step may make. 0..20, default 5. Set 0 for code that must not reach the network at all.' },
                        },
                        additionalProperties: false,
                    },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_notification',
            description: `Append a notification step that delivers a result to the user. The title and body are TEMPLATES — interpolate upstream data with double curly braces. EXAMPLE: {title:"Monthly invoice report",body:"Found {{steps.search.output.count}} invoices totalling €{{steps.sum.output.total}}",channels:["notification"]}. For Gmail-delivered notifications, instead use builder_add_action with tool gmail_compose.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    title: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    body: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    channels: { type: 'array', items: { type: 'string' }, description: 'Default: ["notification"].' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_http_request',
            description: `Append an HTTP Request step that calls an external API or webhook (e.g. a Slack/Google-Chat/Grafana incoming webhook, or any REST endpoint). This is the RIGHT tool whenever the user wants to POST/GET to an arbitrary URL — do NOT tell them to use n8n or a code step for a plain HTTP call. url/headers/body are TEMPLATES: interpolate upstream data with double curly braces, e.g. url:"https://chat.googleapis.com/v1/spaces/AAA/messages?key=..." body:'{"text":"{{steps.ai.output.result}}"}'. Output is {status,ok,headers,body,truncated,data} — bind to it downstream. body is the raw TEXT; data is that same body already PARSED when the response is JSON, so point arrayRef/repeat_for_each at data (an array), never at body (a string). parseResponse controls this: auto (default, parse when the content-type says JSON), never, always. EXAMPLE (Google Chat webhook): {url:"https://chat.googleapis.com/v1/spaces/AAA/messages?key=K&token=T", method:"POST", headers:{"Content-Type":"application/json"}, body:'{"text":"Test message"}'}. Security: blockPrivateTargets defaults TRUE (blocks localhost / private-network / cloud-metadata targets); set it false ONLY when the user explicitly needs to reach an internal/self-hosted address.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    url: { type: 'string', description: 'Full https/http URL. Template string — supports {{trigger.output.x}} / {{steps.<id>.output.<path>}}.' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'Default GET. Use POST for most webhooks.' },
                    headers: { type: 'object', description: 'Map of header name → template-string value, e.g. {"Content-Type":"application/json"}. Do NOT put API keys/tokens in headers — set `authConnectionId` to a saved HTTP credential id instead, or tell the user to add one in the step\'s Authentication settings.' },
                    body: { type: 'string', description: 'Request body (raw text or JSON), only used for POST/PUT/PATCH/DELETE. Template string.' },
                    timeoutMs: { type: 'number', description: 'Request timeout in ms, 1000..60000 (default 10000).' },
                    parseResponse: { type: 'string', enum: ['auto', 'never', 'always'], description: "How to fill `output.data`. auto (default): parse when the response content-type says JSON. never: leave it text-only. always: parse whatever the content-type claims — for APIs that answer JSON as text/plain." },
                    blockPrivateTargets: { type: 'boolean', description: 'Default true — block localhost/private/metadata targets. Set false ONLY for an internal endpoint the user explicitly asked to reach.' },
                    authConnectionId: { type: 'string', description: 'Id of a saved HTTP credential (org vault); its auth header is injected at run time and never stored in the flow. Only set when the user supplied one; never invent ids.' },
                    askOnce: { description: 'Reuse the answer to this call instead of asking again. GET/HEAD ONLY — on a write method the validator rejects the step, because a reused answer to a POST means the second POST silently never happens. Also never reused when blockPrivateTargets is false. `true` = reuse within one run (the shape that collapses a 200-row forEach into one call); `{acrossRuns:true}` additionally keeps the answer for LATER runs, which stores it and only works if an org admin allowed it for web service calls. `{ttlSeconds:N}` (1..900) shortens the window. Use it for a rate-limited or per-call-billed reference API that a loop hits once per row.' },
                    cacheInto: { description: 'Keep the answers to this call as ROWS in a datatable, so the same question is not paid for twice across days and the answers can be read, corrected and exported. `{datatableId:"tbl_…", maxAgeDays:30}`. GET/HEAD only, and nothing is kept while blockPrivateTargets is false — the same refusals askOnce has. The table must be one the user provisioned for this (managedKind "http_cache"): its columns are fixed and it is the only kind the step editor picker offers. Independent of askOnce — either can be on alone. NOTE, and tell the user: rows are ORDINARY plaintext table rows that everyone with access to that table can read and export, unlike the encrypted store askOnce uses; and old rows are removed by the retention window on the table itself, not by a hidden timer. Only set this when the user asked for their API answers to be kept somewhere they can see them; never invent a datatableId.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_generate_document',
            description: `Append a step that renders text into a real PDF or Word (.docx) file and keeps it so the routine can hand it over. Use it whenever the user wants "a PDF", "a Word document", "an offer/report/quote as a file", or something downloadable. \`content\` is a TEMPLATE — bind it to whatever produced the text, e.g. content:"{{steps.ai_1.output.blogtekst}}". Markdown is the default and is rendered properly (headings, bold, links, lists, tables). Output is {fileId,filename,mimeType,size,format}; there is deliberately NO url. TO OFFER IT AS A DOWNLOAD: add a form_page (mode:"ending") whose form.fields contains {type:"download", label:"…", fileId:"{{steps.<this step's id>.output.fileId}}"} — the form builds the session-scoped download link itself. The file is deleted after \`expiresInDays\` (default 7), so it is not a permanent store.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    content: { type: 'string', description: 'The document text. Template string — normally a single reference like {{steps.<id>.output.<field>}}.' },
                    contentFormat: { type: 'string', enum: ['markdown', 'html'], description: 'How to read `content`. Default markdown, which is what AI steps produce. Use html only when the text upstream is already markup.' },
                    layout: { type: 'string', enum: ['document', 'slides'], description: 'Default document (linear print layout). "slides" renders the PDF as a landscape DECK: the h1 becomes the cover, every h2 becomes its own slide with a title band — the shape of an advisory/bank presentation. The author steers the deck with headings, so tell the writing step to keep each h2-section one page. Word output stays a linear document either way.' },
                    format: { type: 'string', enum: ['pdf', 'docx'], description: 'Default pdf. Use docx when the user wants to edit it in Word.' },
                    title: { type: 'string', description: 'Heading on the first page and the default filename. Template string.' },
                    fileName: { type: 'string', description: 'Filename WITHOUT extension (that follows from `format`). Template string. Falls back to the title.' },
                    expiresInDays: { type: 'number', description: 'How long the download keeps working, 1..90 (default 7). The file is deleted afterwards.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_fill_document',
            description: `Append a step that fills a DESIGNED document — an invoice, a quote, an order confirmation, a letter on the company's letterhead — with this run's values and keeps the PDF.

WHICH DOCUMENT STEP TO USE. \`builder_add_generate_document\` turns TEXT into a file and lays it out with the standard renderer: a report, a summary, whatever an ai_step just wrote. THIS one renders a layout somebody drew by hand in Studio → Documents and that must come out identical every time, with the amounts in the right column. Text in → generate_document. A form to fill → fill_document.

\`documentId\` MUST come from the "Documents you may fill" block — never invent one, and never create the document yourself; the person designs it. If that block says the user has none, say so and stop.

\`values\` keys are the placeholder names EXACTLY as that block lists them ("customer.name", "lines"). Each value is a template string, normally one reference: {"customer.name":"{{steps.extract.output.naam}}"}. A (list) placeholder must be bound to a WHOLE ARRAY — write it as a single "{{steps.rows.output.rows}}" and nothing else: mixed text ("Klant {{x}}") is interpolated into a string, and a list that arrives as text renders as nothing.

A placeholder with no value prints BLANK (never its own braces), and the step's output names every hole that stayed empty, so bind them all.

Output is {fileId, filename, mimeType, size, documentId, missing[]} — the same file shape send_email attachments, approval attachments and a form_page download field already take. There is deliberately NO url. The file is deleted after \`expiresInDays\` (default 7).`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch.' },
                    documentId: { type: 'string', description: 'Id of an EXISTING document of this user, from the "Documents you may fill" block. Never invent one.' },
                    documentVersionId: { type: 'string', description: 'Pinned versionId from builder_read_document.' },
                    sectionOverrides: { type: 'object', description: 'Reviewed section ID to automatic/include/exclude choices.' },
                    values: { type: 'object', description: 'Placeholder name → value. Template strings ("{{steps.x.output.total}}"); a list placeholder takes a single whole-array reference and nothing else.' },
                    fileName: { type: 'string', description: 'Filename WITHOUT the .pdf extension. Template string, e.g. "Factuur {{steps.extract.output.nummer}}". Falls back to the document\'s own name.' },
                    saveCopy: { type: 'boolean', description: 'Default false. true ALSO keeps the filled-in document in Studio → Documents, so a person can correct a line by hand before it goes out. Leave it off for a routine that runs often — it mints a document every run.' },
                    format: { type: 'string', enum: ['pptx', 'pdf'], description: 'Only for a PRESENTATION document (docType "presentation" in the block): pptx (default) or pdf. A page document is always a PDF.' },
                    expiresInDays: { type: 'number', description: 'How long the file stays fetchable, 1..90 (default 7).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['documentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_slide',
            description: `Append ONE slide of a presentation — no file, a cheap building block for builder_add_presentation. \`title\` and \`content\` are templates; content is markdown: "- " bullets (two-space indent = sub-point), a paragraph, a "|" table, a "> " quote, "![](url)" image, "### " sub-headings (two = columns, three to six = cards with a short text each; "### Title {icon: shield}" gives a card a Lucide icon, an image line inside the block a picture) — the LAYOUT IS PICKED FROM WHAT THE CONTENT CONTAINS, or forced with \`layout\`. VISUALS: \`chart\` draws a chart from data rows ({type:"bar", data:"{{steps.query.output.rows}}"} — ONE slide, no loop), \`stats\` makes KPI tiles, layout "timeline" turns the bullets into numbered steps. Output is {slide} (an object). Use forEach to make one slide per row: {title:"{{loop.r.name}}", content:"- Omzet: {{loop.r.omzet}}", forEach:{overRef:"steps.rows.output.rows", itemVar:"r"}}. PREFER pattern (1) of builder_add_presentation — one ai_step that writes the whole outline — when the slides do not come from data rows.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch.' },
                    title: { type: 'string', description: 'Slide heading. Template string.' },
                    content: { type: 'string', description: 'Slide body as markdown. Template string — e.g. "- {{steps.extract.output.punt1}}\\n- {{steps.extract.output.punt2}}".' },
                    notes: { type: 'string', description: 'Speaker notes — what the presenter says. Template string.' },
                    layout: { type: 'string', enum: ['auto', 'title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing'], description: 'Default auto (from the content). "section" = a divider with just the title; "cards" = 3–4 "### " blocks as cards; "timeline" = the bullets as numbered steps ("Title — text"); "closing" = the final thank-you slide.' },
                    image: { type: 'string', description: 'Optional image: the imageUrl of a generate_image step, or a data: URL. Template string. Remote http(s) pictures are not fetched.' },
                    chart: {
                        type: 'object',
                        description: 'Optional chart: {type:"bar", data:"{{steps.query.output.rows}}", labels:"maand", values:"omzet,kosten"} — data may be rows, a markdown table or "label: value" lines; labels/values name the columns and are auto-detected when omitted.',
                        properties: {
                            type: { type: 'string', enum: ['column', 'bar', 'line', 'area', 'pie', 'donut'] },
                            data: { description: 'The data: a whole reference "{{steps.<id>.output.rows}}", a markdown table, "label: value" lines, or inline rows.' },
                            labels: { type: 'string', description: 'Column that holds the labels (optional).' },
                            values: { type: 'string', description: 'Comma-separated columns to plot (optional).' },
                            stacked: { type: 'boolean' },
                            unit: { type: 'string', description: 'Axis unit, e.g. "%" or "€".' },
                        },
                    },
                    stats: { type: 'string', description: 'Optional KPI tiles, one per line "value | label | delta | icon" (max 4), e.g. "{{steps.q.output.total}} | Omzet | +12% | trending-up". Template string.' },
                    style: { type: 'string', enum: ['accent', 'dark'], description: 'Paint this one slide in the accent colour or dark, for emphasis. Leave out otherwise.' },
                    forEach: { type: 'object', description: 'Run once per item of an upstream list: {overRef:"steps.<id>.output.<list>", itemVar:"r", maxIterations?:100}. The presentation step then takes steps.<this id>.output.results[*].output.slide.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_presentation',
            description: `Append a step that turns slides into a real PowerPoint (.pptx) — or a PDF deck — in the organisation's house style, and keeps the file. Use it whenever the user wants "a presentation", "slides", "a deck", "a PowerPoint", "een presentatie". \`slides\` is THE input and takes three shapes: (1) SIMPLEST — the markdown an ai_step wrote: slides:"{{steps.write.output.text}}"; tell that ai_step to write "# Title" once and "## " for every slide with "- " bullets under it (optional "### " sub-headings — two = columns, three to six = cards, "### Title {icon: shield}" for an icon —, "> " quote, a "|" table, "<!-- notes: … -->" speaker notes; for VISUALS a \`\`\`chart block ("type: bar", "labels: Q1, Q2", "Omzet: 10, 20") or "<!-- chart: bar -->" above a table, a \`\`\`stats block ("€ 1,2M | Omzet | +12%" per line), "<!-- layout: timeline -->" for steps). (2) A LIST of slide steps: slides:["{{steps.s1.output.slide}}","{{steps.s2.output.slide}}"] — each entry is ONE whole reference and nothing else. (3) ONE SLIDE PER ITEM: a slide step with forEach, then slides:"{{steps.<slide>.output.results[*].output.slide}}" (a loop body ending in a slide step works the same with the loop's id). Output is {fileId,filename,mimeType,size,format,slideCount,sourceHandle}; there is deliberately NO url. TO OFFER IT AS A DOWNLOAD: add a form_page (mode:"ending") whose form.fields contains {type:"download", label:"…", fileId:"{{steps.<this step's id>.output.fileId}}"}. TO KEEP IT IN NEXTCLOUD: add nextcloud_upload_file with path:"/Presentaties/<name>.pptx" and sourceHandle:{kind:"ref",path:"steps.<this step's id>.output.sourceHandle"} — it opens in Nextcloud Office. The file is deleted after \`expiresInDays\` (default 7).`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch.' },
                    title: { type: 'string', description: 'Deck title on the cover and the default filename. Template string. Falls back to the "# " title of a markdown outline.' },
                    subtitle: { type: 'string', description: 'Cover subtitle (audience, date). Template string.' },
                    slides: { description: 'THE slides: a template string (a markdown outline, a loop result reference) OR a list of whole references / inline {title, content} objects. See the three shapes above.' },
                    fileName: { type: 'string', description: 'Filename WITHOUT extension (that follows from `format`). Template string. Falls back to the title.' },
                    format: { type: 'string', enum: ['pptx', 'pdf'], description: 'Default pptx (PowerPoint / Nextcloud Office). pdf = the same deck as a landscape PDF.' },
                    houseStyle: { type: 'boolean', description: "Default true: the organisation's colours, font, logo and footer. false ONLY when the user asks for another brand or an unbranded deck." },
                    preset: { type: 'string', enum: ['band', 'clean', 'bold', 'dark'], description: 'Optional look: band = white slides with a coloured title band (default); clean = white, accent titles; bold = accent-coloured slides; dark = charcoal slides. Only when the user asks for a style.' },
                    accent: { type: 'string', description: 'Optional accent colour "#RRGGBB" (template string) — only when the user names a colour or another brand.' },
                    font: { type: 'string', enum: ['Calibri', 'Arial', 'Helvetica', 'Verdana', 'Segoe UI', 'Trebuchet MS', 'Century Gothic', 'Georgia', 'Cambria', 'Times New Roman', 'Garamond', 'Consolas'], description: 'Optional typeface for the deck.' },
                    coverStyle: { type: 'string', enum: ['accent', 'light', 'split'], description: 'Optional cover: accent block (default), light, or split panel.' },
                    tableStyle: { type: 'string', enum: ['banded', 'lines', 'minimal'], description: 'Optional table look: banded (default), lines, minimal.' },
                    logo: { type: 'string', description: 'Optional logo on every slide: the imageUrl of a generate_image step or a data: URL, or "none" to leave the house-style logo off. Template string.' },
                    logoPlacement: { type: 'string', enum: ['footer', 'corner', 'cover', 'none'], description: 'Where the logo sits (default: house style).' },
                    background: { type: 'string', description: 'Optional slide background "#RRGGBB" (template string); text colours adapt for contrast.' },
                    footerText: { type: 'string', description: 'Optional line in every slide footer, e.g. "Vertrouwelijk · {{trigger.date}}". Template string.' },
                    template: { type: 'string', enum: ['none'], description: '"none" = plain slides instead of the house-style template deck. Leave out otherwise.' },
                    saveCopy: { type: 'boolean', description: 'Default false. true ALSO keeps the deck in Studio → Documents as an editable presentation (opens in Bee Flow). Off for a routine that runs often.' },
                    expiresInDays: { type: 'number', description: 'How long the download keeps working, 1..90 (default 7). The file is deleted afterwards.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['slides'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_data_extraction',
            description: `Append a step that pulls NAMED, TYPED fields out of a piece of text — an invoice, an e-mail body, the text of a PDF, a web page. PREFER THIS OVER AN ai_step FOR EXTRACTION: an ai_step is for judgement and writing (classify, summarise, draft a reply); this step is for "read these values out of that text". It runs on the ONE extraction model the administrator configured (small, fast, deterministic, thinking off) — NOT on the routine's model tier, so there is no modelTier to pick. \`fields\` IS the output shape, so no outputSchema is needed: the output is exactly one object with exactly the declared names — steps.<id>.output.<name>, or loop.<itemVar>.output.<name> inside a fan-out — and a field the text does not contain is null (a field marked required:true FAILS the step instead, so an unreadable document can be routed to an on_error branch). Numbers are real JSON numbers even when the text says "€ 1.554,25"; dates are "YYYY-MM-DD" strings. \`source\` is ONE binding to the text to read. source, fields and instructions sit at the TOP LEVEL of the args — this step has NO inputs map (that is integration_action vocabulary). Use forEach to extract the same fields from every file: {source:{kind:"ref",path:"loop.f.output.content"}, forEach:{overRef:"steps.<read>.output.results", itemVar:"f"}}. EXAMPLE: {source:{kind:"ref",path:"steps.read.output.content"}, fields:[{name:"factuurnummer",type:"string",description:"Invoice number",required:true},{name:"datum",type:"date",description:"Invoice date"},{name:"totaal_incl_btw",type:"number",description:"Total including VAT"}], instructions:"Amounts are in euros."}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    source: { type: 'object', description: 'The text to read, as ONE binding: {kind:"ref", path:"steps.<id>.output.<field>"} or {kind:"template", value:"…{{steps.x.output.y}}…"}. Inside a forEach: {kind:"ref", path:"loop.<itemVar>.output.content"}. Never a literal.' },
                    fields: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 30,
                        description: 'The fields to extract, IN ORDER — this list is the output shape. 1..30 rows.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Lowercase letters, digits and underscores, starting with a letter, max 40 chars (e.g. "invoice_date"). Becomes the output key steps.<id>.output.<name>. Unique within the step.' },
                                type: { type: 'string', enum: ['string', 'number', 'boolean', 'date'], description: 'string | number (a real JSON number, coerced from "1.554,25" too) | boolean | date (a "YYYY-MM-DD" string). Default string.' },
                                description: { type: 'string', description: 'What to look for, in one line — the model reads this. E.g. "Total amount including VAT".' },
                                required: { type: 'boolean', description: 'Default false. true: the step FAILS when the text does not contain this field, so the failure can be handled on an on_error branch instead of a null flowing downstream.' },
                            },
                            required: ['name', 'type'],
                        },
                    },
                    instructions: { type: 'string', description: 'Optional extra guidance for the model, max 2000 chars — units, language, which of two similar dates. NOT a prompt: the step builds its own. E.g. "Amounts are in euros; the invoice date is the one after Factuurdatum."' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['source', 'fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_set',
            description: `Append an "Edit data" (set) step. Two modes, both free at run time — prefer this over an ai_step for restructuring data. SINGLE (no arrayRef): produces one explicit object from the fields map. LIST (arrayRef set to an upstream array): every row keeps its columns and gets the fields ADDED (evaluated per row — the row is \`item\`, e.g. {kind:"expr",value:"lower(item.email)"}), then \`operations\` run on the whole table IN ORDER; output becomes { items, count } — bind downstream as steps.<id>.output.items. To read values out of JSON text, use an expr binding with the parseJson function: {kind:"expr",value:"parseJson(steps.h.output.body, \\"order.total\\")"} — this replaces the old parse_json step. ${BINDING_HINT} EXAMPLE single: {fields:{name:{kind:"literal",value:"Alice"},email:{kind:"ref",path:"trigger.output.from"}}}. EXAMPLE list: {arrayRef:"steps.g.output.results",fields:{sender:{kind:"expr",value:"lower(item.from)"}},operations:[{op:"groupId",target:"thread",keys:["sender","subject"]},{op:"rowId",target:"id"}]}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    fields: { type: 'object', description: `Map of fieldName → binding. In list mode each binding is evaluated per row with the row as \`item\` (and \`_index\`). ${BINDING_HINT}` },
                    arrayRef: { type: 'string', description: 'Dotted path to an upstream ARRAY, e.g. "steps.<id>.output.items". Presence switches the step to list mode. Cannot be combined with forEach.' },
                    operations: {
                        type: 'array',
                        description: 'List mode only — whole-table operations, applied AFTER the per-row fields, strictly in listed order (sort before rowId numbers the sorted order). Column names are top-level keys. Ops: {op:"rowId",target,start?} number every row 1..N; {op:"groupId",target,keys:[col,…]} same id for rows with equal values in the key column(s) (case-insensitive, first-appearance numbering); {op:"rename",from,to}; {op:"keep",keys:[…]} keep only these columns; {op:"remove",keys:[…]}; {op:"sort",key,direction?:"asc"|"desc"} (numeric when possible, missing values last). Max 20.',
                        items: { type: 'object' },
                    },
                    maxItems: { type: 'number', description: 'List mode only — optional input cap (tightens the platform ceiling of 10000; over the cap the run fails loudly).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_note',
            description: 'Add a free-floating sticky-note annotation to the canvas — a place to explain WHY a branch exists, leave a TODO, or document a decision for whoever opens this routine next. It never runs, is never wired to anything (no afterStepId/branch — a note has no edges at all), and is not part of the flow. Use it instead of a comment nobody else can see.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The note\'s text. Plain text (no bindings, no templates — it never runs).' },
                    position: {
                        type: 'object',
                        description: 'Where the note sits on the canvas. Omit to let the canvas place it; a human editing the same routine will likely move it anyway.',
                        properties: { x: { type: 'number' }, y: { type: 'number' } },
                    },
                    size: {
                        type: 'object',
                        description: 'Note box size in canvas units, e.g. { width: 220, height: 140 }. Omit for the default size.',
                        properties: { width: { type: 'number' }, height: { type: 'number' } },
                    },
                    color: { type: 'string', enum: ['blue', 'green', 'amber', 'orange', 'rose', 'red', 'cyan', 'slate'], description: 'Optional swatch. Omit for the default colour.' },
                    label: { type: 'string' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_create_layer',
            description: 'Create an inline Flowlet — a named, reusable sub-flow stored INSIDE this automation (definition.layers). The skeleton is a layer_input trigger (declaring the input params) wired to a layer_output "Return" step. Workflow: 1) builder_create_layer → returns {layerKey}; 2) populate it by calling the normal builder_add_* tools with scope:"<layerKey>"; 3) bind its outputs in the layer_output step (builder_set_layer_contract outputFields); 4) run it from the main flow via builder_add_call_layer. Inside a flowlet, bind inputs as trigger.output.<param>.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Human-readable flowlet name (the key is derived from it).' },
                    params: {
                        type: 'array',
                        description: 'Input contract. Each param is available inside the flowlet as trigger.output.<name>.',
                        items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', description: 'string | number | boolean | object | array (informational).' }, required: { type: 'boolean' } }, required: ['name'] },
                    },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_layer_contract',
            description: 'Update a flowlet\'s contract. `params` replaces the layer_input trigger params (inputs the caller must bind). Set the flowlet\'s RETURN value with `outputs`: a map of fieldName → binding that writes the layer_output ("Return") step directly — this is THE way a flowlet returns data; never add a separate `set`/return step to hold it. (`outputFields` is a legacy alternative that only declares the key set, leaving bindings empty.) The flowlet already contains exactly one layer_output step — these args edit it in place.',
            parameters: {
                type: 'object',
                properties: {
                    layerKey: { type: 'string', description: 'Key in definition.layers.' },
                    params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                    outputs: { type: 'object', description: 'Map of return-field name → binding, e.g. { "invoices": { "kind":"ref", "path":"steps.agg1.output.values" } }. Declares AND binds each field on the layer_output step in one call.' },
                    outputFields: { type: 'array', items: { type: 'string' }, description: 'Legacy: declare return field NAMES only (bindings start empty). Prefer `outputs` so the flowlet actually returns data.' },
                },
                required: ['layerKey'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_generate_layer',
            description: 'DELEGATE building a whole flowlet to a focused sub-agent (thinking model). Give it a clear `instruction` describing what the flowlet should do, plus its `params` (inputs) and `outputFields` (what it returns). The sub-agent creates the flowlet and builds every step inside it, then returns {layerKey, outputFields, summary}. Prefer this over hand-building a non-trivial flowlet step-by-step. After it returns, wire the flowlet into the main flow with builder_add_call_layer({layerKey, inputs:{...}}) and bind its results as steps.<callId>.output.<field>.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Human-readable flowlet name.' },
                    instruction: { type: 'string', description: 'Precise description of what this flowlet must do (the sub-agent builds it end to end).' },
                    params: { type: 'array', description: 'Inputs the flowlet accepts (bound by the caller; seen inside as trigger.output.<name>).', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                    outputFields: { type: 'array', items: { type: 'string' }, description: 'Field names the flowlet should return.' },
                },
                required: ['title', 'instruction'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_generate_layers',
            description: 'DELEGATE building SEVERAL independent flowlets AT ONCE — up to 3 sub-agents (thinking model) run in parallel, one per flowlet. Use this when a complex automation decomposes into multiple reusable sub-flows that do NOT depend on each other. Each entry needs a `title` + `instruction` (+ optional params/outputFields). Returns the built flowlets with their keys + outputFields; wire each into the main flow with builder_add_call_layer afterwards. The flowlets must be independent — a flowlet here may reference only PRE-EXISTING flowlets, not its siblings in this same call.',
            parameters: {
                type: 'object',
                properties: {
                    layers: {
                        type: 'array',
                        description: 'The flowlets to build in parallel (max 3 run concurrently; more queue).',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                instruction: { type: 'string', description: 'What this flowlet must do.' },
                                params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                                outputFields: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['title', 'instruction'],
                        },
                    },
                },
                required: ['layers'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_plan',
            description: 'Record (and update) your own to-do list for building this automation, shown to the user as a live checklist. Call it FIRST for any multi-step build (with `todos`), then update progress with the cheap `markDone` diff form. NEVER send this tool as your only call in a reply — always bundle it with the build calls it describes. It does not change the automation.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: 'The full ordered checklist (replaces the previous one). Use for the initial plan or a restructure.',
                        items: { type: 'object', properties: { text: { type: 'string', description: 'Short task description.' }, done: { type: 'boolean', description: 'true once completed.' } }, required: ['text'] },
                    },
                    markDone: {
                        type: 'array',
                        items: { type: 'integer' },
                        description: '0-based indices of existing todos to flip done:true. Cheaper than resending todos — use this for progress updates, bundled with your next build call.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_call_layer',
            description: `Append a "call_layer" step that runs one of this automation's inline flowlets (definition.layers) and returns its layer_output fields, bindable downstream as steps.<id>.output.<field>. Provide the layerKey plus an inputs map binding each declared flowlet param (the flowlet sees them as trigger.output.<param>). ${BINDING_HINT} Recursion is rejected — a flowlet cannot (transitively) call itself. Use scope to place the call INSIDE another flowlet (sibling calls are allowed).`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    layerKey: { type: 'string', description: 'Key of the flowlet in definition.layers (create one via builder_create_layer).' },
                    inputs: { type: 'object', description: `Map of flowlet-param → binding. ${BINDING_HINT}` },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['layerKey'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_datetime',
            description: 'Append a date/time operation. ops: now (current time), parse (string→ISO), format (ISO→formatted string), addDays/addHours/addMinutes (offset by amount), diff (two refs → numeric diff in unit), extract (year/month/day/hour/minute/dayOfWeek). EXAMPLES: {op:"now"} | {op:"addDays",input:"trigger.output.timestamp",amount:7} | {op:"format",input:"steps.x.output.iso",format:"yyyy-MM-dd"} | {op:"diff",input:"trigger.output.start",input2:"trigger.output.end",unit:"hours"}. To work through a LIST (a whole column of dates), set arrayRef to the list and address the row with `item`: {op:"extract",part:"day",arrayRef:"steps.x.output.results",input:"item.updated"} — every row keeps its columns and gains a `day` column.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    op: { type: 'string', enum: ['now', 'parse', 'format', 'addDays', 'addHours', 'addMinutes', 'diff', 'extract'] },
                    input: { type: 'string', description: 'Path to a date value (ISO string or epoch ms). Omit for op:now.' },
                    input2: { type: 'string', description: 'Second date path. Required for op:diff.' },
                    amount: { type: 'number', description: 'Offset amount (positive or negative). Required for addDays/addHours/addMinutes.' },
                    format: { type: 'string', description: 'Format string with tokens yyyy/MM/dd/HH/mm/ss. Required for op:format.' },
                    part: { type: 'string', enum: ['year', 'month', 'day', 'hour', 'minute', 'second', 'dayOfWeek'], description: 'Required for op:extract.' },
                    unit: { type: 'string', enum: ['days', 'hours', 'minutes', 'seconds'], description: 'Required for op:diff.' },
                    arrayRef: { type: 'string', description: 'LIST MODE: path to an upstream list, e.g. steps.x.output.results. The operation then runs per ROW and the result is ADDED AS A COLUMN to every row; `input` addresses the row as `item`, e.g. "item.updated". Output is {items,count}. Omit entirely to work on one date.' },
                    target: { type: 'string', description: 'List mode only: the name of the column the result goes into. Defaults to the part (op:extract), else the operation name.' },
                    label: { type: 'string' },
                },
                required: ['op'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_wait',
            description: 'Append a step that pauses the run for N seconds (1..86400). Use for simple rate limiting or to give an external service time to settle. Dry-run skips the wait.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    seconds: { type: 'integer', description: 'Number of seconds to wait. Capped at 86400 (24h).' },
                    label: { type: 'string' },
                },
                required: ['seconds'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_approval',
            description: 'Append a step that PAUSES the run until a person approves or rejects it. `prompt` is what the approver reads and is template-interpolated, so use {{steps.x.output.y}} to quote the actual thing being approved. Optional richness: `details` (markdown, interpolated) for context; `attachments` (bindings to fileIds from generate_document steps) so the approver can download the document being approved; `fields` (form-contract questions — text/textarea/email/number/date/select/checkbox, NEVER file) whose answers land at steps.<id>.output.answers.<name>. `assignee` routes the decision to one person ({userId}) or one org group ({groupId}); without it the routine\'s owner decides. On APPROVE the run continues and later steps can bind steps.<id>.output.approved / .by / .reason / .decidedAt (and .answers.*). On REJECT the run ENDS — never wire a "rejected" branch. For approvals that need SEVERAL people in ORDER (team lead, then finance, then a director), use `stages` — up to 5 named steps, each with its own approvers, its own rule, and an optional `when` condition. Do NOT put an approval inside a loop, a parallel branch or a flowlet, and never set forEach on it.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    prompt: { type: 'string', description: 'The question the approver sees, e.g. "Send the {{steps.quote.output.total}} quote to {{trigger.output.client}}?". Supports {{...}} bindings.' },
                    expiresInHours: { type: 'integer', description: 'How long the approval may sit before the run is closed as expired, 0..720 (30 days). 0 = no deadline. Default 168 (7 days).' },
                    assignee: { type: 'object', description: 'Who decides: { userId: "..." } for one person or { groupId: "..." } for an org group (any member may decide, first decision wins). Must belong to the owner\'s organisation. Omit = the owner decides.' },
                    details: { type: 'string', description: 'Optional markdown shown under the question, template-interpolated — put the context the approver needs to judge (amounts, recipients, the drafted text).' },
                    attachments: { type: 'array', description: 'Up to 5 items of { binding, label? } where binding resolves to a fileId an earlier generate_document step produced, e.g. { binding: "{{steps.doc.output.fileId}}", label: "The quote (PDF)" }.', items: { type: 'object' } },
                    fields: { type: 'array', description: 'Up to 20 extra questions for the approver (form-contract fields: name, label, type, required, options...). Answers bind downstream as steps.<id>.output.answers.<name>. type "file" is refused.', items: { type: 'object' } },
                    approvers: { type: 'array', description: 'A PANEL of up to 10 seats, each { userId } or { groupId } (a group seat is filled by whichever member votes first). Use INSTEAD of assignee. How votes resolve is set by `rule`. Downstream, steps.<id>.output.votes lists every vote.', items: { type: 'object' } },
                    rule: { type: 'string', enum: ['all', 'first', 'quorum'], description: 'Panel decision rule. "all" (default): every seat must approve — ONE reject declines immediately. "first": the first vote decides for everyone. "quorum": approved at `quorum` approvals, declined once that number is unreachable.' },
                    quorum: { type: 'integer', description: 'For rule="quorum": how many approvals are needed (1..number of seats), e.g. 2 of 3.' },
                    finalApprover: { type: 'object', description: 'Optional FINAL sign-off stage: after the panel (or single approver) says yes, this one person ({ userId }) or group ({ groupId }) has the last word. The request only counts as approved after their decision.' },
                    stages: { type: 'array', description: 'A SEQUENTIAL CHAIN of up to 5 approval stages, asked one after another — use INSTEAD of assignee/approvers/finalApprover (setting both is refused, because the extra approver would never be asked). Each stage is { name, description?, approvers: [{userId}|{groupId}], rule?, quorum?, when? }: up to 10 seats per stage and 30 across the whole chain; `rule` and `quorum` work exactly as they do for a panel, but PER STAGE; `when` is an expression (like a condition step\'s `expr`, e.g. "steps.invoice.output.amount > 5000") evaluated ONCE when the request is raised — a stage whose condition is not met is skipped and recorded as skipped. Only the current stage\'s people are asked, and only when their turn arrives; one reject at ANY stage declines the whole request immediately. Name stages after who decides ("Team lead", "Finance", "Director sign-off") and use `description` to say what that stage is checking. EXAMPLE: [{name:"Team lead",approvers:[{userId:"u1"}],rule:"first"},{name:"Finance",approvers:[{groupId:"g_fin"}],rule:"first"},{name:"Director",approvers:[{userId:"u9"}],rule:"first",when:"steps.invoice.output.amount > 5000"}].', items: { type: 'object' } },
                    remindAfterHours: { type: 'integer', description: 'Nudge the approver again this many hours after the request (1..720). Must be earlier than expiresInHours or it never fires. Omit for no reminder.' },
                    escalateTo: { type: 'object', description: 'Who takes over when nobody decides: { userId } or { groupId } in the owner\'s org. Escalation WIDENS the decider set — the original approver keeps their rights. Requires escalateAfterHours.' },
                    escalateAfterHours: { type: 'integer', description: 'Hours before the escalation target gains decide rights (1..720, earlier than expiresInHours). Requires escalateTo.' },
                    label: { type: 'string' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_form_page',
            description: 'Append a FURTHER page of the routine\'s public form, shown on the same /f/<token> URL the visitor is already on. Requires the trigger to be kind=form. mode="input" PAUSES the run until the visitor answers — bind their answers as steps.<id>.output.<fieldName>. mode="ending" is the closing page: no questions, and its `title`/`description` are template-interpolated against the finished run, so use {{steps.x.output.y}} there to show the visitor what happened. Do NOT put a form page inside a loop, a parallel branch or a flowlet.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    mode: { type: 'string', enum: ['input', 'ending'], description: 'Default "input".' },
                    waitSeconds: { type: 'integer', description: 'mode=input only: how long to wait for the visitor, 60..604800 (1 minute … 7 days). Default 3600.' },
                    form: {
                        type: 'object',
                        description: 'The page. Same shape as the trigger\'s form. Omit `theme` to match the first page (recommended).',
                        properties: {
                            title: { type: 'string' },
                            description: { type: 'string', description: 'Supports {{...}} bindings — this is how a closing page summarises the run.' },
                            submitLabel: { type: 'string' },
                            successMessage: { type: 'string' },
                            fields: {
                                type: 'array',
                                description: 'mode=input only. Empty/omitted for an ending page.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        type: { type: 'string', enum: ['text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox', 'file', 'app_pick'] },
                                        label: { type: 'string' },
                                        required: { type: 'boolean' },
                                        placeholder: { type: 'string' },
                                        options: { type: 'array', items: { type: 'string' }, description: 'Required when type=select.' },
                                        accept: { type: 'string', description: 'When type=file: a MIME allowlist, e.g. "application/pdf,image/*".' },
                                        maxSizeMb: { type: 'number', description: 'When type=file: 1–25.' },
                                        source: { type: 'string', description: `REQUIRED when type=app_pick: which app the person filling the form searches. One of: ${PICK_SOURCES}. The search runs against THEIR OWN account, so use this instead of asking someone to paste a transcript or forward an email.` },
                                        multiple: { type: 'boolean', description: 'When type=app_pick: let them pick several records. The answer is then a LIST of descriptors instead of one.' },
                                        maxItems: { type: 'number', description: 'When type=app_pick and multiple: 1–10 (default 5).' },
                                        withText: { type: 'boolean', description: 'When type=app_pick: read the record\'s content into the run (default true). Set false when only a reference is wanted.' },
                                        // A file field binds as an OBJECT, never a string:
                                        // trigger.output.<name> is { kind, fileId, filename, mimeType, size,
                                        // text, textTruncated, textError }. `.text` is the extracted content —
                                        // a workbook as one markdown table per sheet, a PDF as its text layer —
                                        // so an ai_step reads the document by binding
                                        // trigger.output.<name>.text, NOT trigger.output.<name>.
                                        //
                                        // An app_pick field binds the same way: trigger.output.<name> is
                                        // { kind:'app_pick', source, app, recordId, title, url, text,
                                        // textTruncated, textError } — or a LIST of those when `multiple`.
                                        // `.text` is the transcript / email body / note, so an ai_step binds
                                        // trigger.output.<name>.text, never trigger.output.<name>.
                                    },
                                    required: ['name', 'type', 'label'],
                                },
                            },
                        },
                    },
                    label: { type: 'string' },
                },
                required: ['form'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_stop_error',
            description: 'Append a step that halts the run with a custom error message. The message is a TEMPLATE — interpolate upstream fields with double curly braces. Use as a guardrail downstream of a condition that detects "we should not continue". EXAMPLE: {message:"Budget exceeded: {{steps.calc.output.delta}}"}.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    message: { type: 'string', description: 'Template string surfaced as the run error.' },
                    label: { type: 'string' },
                },
                required: ['message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_switch',
            description: 'Append a multi-way branch. A case is EITHER { name, value } — compared against the step-level expr — OR { name, expr }, carrying its own rule, which is what you want when the outputs test different things. Do not mix the two in one switch. Wire each case to its next step by passing nextStepIds: { "<caseName>": "<stepId>", "default": "<stepId>" }. EXAMPLE (value style): {expr:"trigger.output.priority",cases:[{name:"urgent",value:"high"},{name:"normal",value:"medium"}],defaultBranch:"fallback"}. EXAMPLE (rule style, one rule per output): {expr:"item",cases:[{name:"pdf",expr:"endsWith(lower(item.name),\'.pdf\')"},{name:"word",expr:"endsWith(lower(item.name),\'.doc\') || endsWith(lower(item.name),\'.docx\')"}]}. To grow a case branch by appending a NEW step, call an add tool with afterStepId set to this switch\'s id AND caseName set to the case it belongs to — otherwise the edge is unlabelled and that case dead-ends.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    expr: { type: 'string', description: 'Restricted JS expression whose value gets matched.' },
                    cases: { type: 'array', description: 'Match in order, first hit wins. Each entry is { name, value } (compared against the step-level expr) or { name, expr } (its own restricted-grammar rule). One output per entry.', items: { type: 'object', properties: { name: { type: 'string' }, value: {}, expr: { type: 'string', description: 'This output\'s own rule, restricted grammar. Inside a list the current row is `item`. When present, `value` is ignored for this case.' } }, required: ['name'] } },
                    defaultBranch: { type: 'string', description: 'Case name to route to when no case matches (otherwise dead-ends).' },
                    nextStepIds: { type: 'object', description: 'Map of case name → existing step id to wire as the branch target. Use this in one shot instead of calling builder_add_* with afterStepId per branch.' },
                    label: { type: 'string' },
                },
                required: ['expr', 'cases'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_filter',
            description: 'Append a collection filter — keeps array items matching expr. arrayRef points to an upstream array; expr is evaluated per element with the current element bound as `item`. Output is { items, count }. EXAMPLE: {arrayRef:"steps.search.output.results",expr:"item.amount > 1000"}.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    arrayRef: { type: 'string' },
                    expr: { type: 'string', description: 'Restricted JS expression referencing item.<field>.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'expr'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_limit',
            description: 'Append a step that returns the first or last N items of an array. Output is { items, count }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    arrayRef: { type: 'string' },
                    count: { type: 'integer', description: 'How many items to keep.' },
                    mode: { type: 'string', enum: ['first', 'last'], description: 'Default: first.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'count'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_dedupe',
            description: 'Append a step that removes duplicate items. With keyField, dedup by that field; without, dedup by deep equality. Output is { items, removed }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    arrayRef: { type: 'string' },
                    keyField: { type: 'string', description: 'Optional. If set, items with the same value at this field are treated as duplicates.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_aggregate',
            description: 'Append a step that pulls one field across every item of an array into a flat list. Output is { values, count }. EXAMPLE: {arrayRef:"steps.search.output.results",field:"email"} → values is an array of emails.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    arrayRef: { type: 'string' },
                    field: { type: 'string', description: 'Field name to read from each item.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'field'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_summarize',
            description: 'Append a statistics step over a numeric field of an array. ops: sum, count (length of arrayRef regardless of field), avg, min, max. Output is { result, op, count }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    arrayRef: { type: 'string' },
                    field: { type: 'string' },
                    op: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'] },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'field', 'op'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_array_op',
            description: `Append an array operation step. Single entry point for filter / limit / dedupe / aggregate / summarize — pick \`op\` and supply the matching fields. This is the ONLY array tool in the menu.

OPS:
  - filter:    keep items matching expr.    Required: arrayRef, expr.        Output: { items, count }.
  - limit:     first/last N items.          Required: arrayRef, count.       Optional: mode ("first"|"last"). Output: { items, count }.
  - dedupe:    drop duplicates.             Required: arrayRef.               Optional: keyField (dedup by that field; else deep equality). Output: { items, removed }.
  - aggregate: pull one field across items. Required: arrayRef, field.       Output: { values, count }.
  - summarize: numeric stats over a field.  Required: arrayRef, field, fn.   fn ∈ sum|count|avg|min|max. Output: { result, op, count }.

arrayRef is a path string (e.g. "steps.search.output.results"), NOT a binding object. EXAMPLE: {op:"filter",arrayRef:"steps.search.output.results",expr:"item.amount > 1000"}.`,
            parameters: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: ['filter', 'limit', 'dedupe', 'aggregate', 'summarize'] },
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    arrayRef: { type: 'string', description: 'Dotted path to an upstream array, e.g. "steps.search.output.results".' },
                    expr: { type: 'string', description: 'filter only: restricted JS expression referencing item.<field>.' },
                    count: { type: 'integer', description: 'limit only: how many items to keep.' },
                    mode: { type: 'string', enum: ['first', 'last'], description: 'limit only: default "first".' },
                    keyField: { type: 'string', description: 'dedupe only: field to dedup by; omit for deep-equality dedup.' },
                    field: { type: 'string', description: 'aggregate and summarize: field name on each item.' },
                    fn: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'], description: 'summarize only: which statistic to compute.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['op', 'arrayRef'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_datatable',
            description: `Append a step that reads or writes rows of a DATATABLE — an organisation-scoped table whose rows OUTLIVE the run, so one routine can leave data for a later run of itself or for a different routine. This is how a routine remembers WORKING DATA between runs. (A knowledge-write step also outlives the run, but that stores TEXT for an agent to answer from — not data to read back.)

OPERATIONS (pick one):
  - find_rows:    look rows up. Changes nothing.        Optional: where, match, sort, limit, cursor. Output: { rows, returned, found, hasMore, nextCursor }.
  - count_rows:   how many rows match. Reads no row data. Optional: where, match.      Output: { count, found }.
  - add_row:      always inserts a new row.             Required: values.              Output: { row, id, created, updated }.
  - save_row:     updates the matching row, or inserts. Required: values, matchColumn. Output: { row, id, created, updated }.
  - update_rows:  changes every matching row.           Required: values, where (>=1). Output: { updated, truncated }.
  - delete_rows:  removes every matching row.           Required: where (>=1).         Output: { deleted }.

find_rows returns ONE PAGE. \`returned\` is how many rows that page holds — NOT how many rows match; use count_rows for that. To walk a bigger table, feed \`cursor\` from the previous step's \`nextCursor\`. (\`count\` still exists on find_rows as a deprecated alias of \`returned\`; do not use it in new routines.)

delete_rows REFUSES when more than 1000 rows match, rather than deleting the first 1000 and reporting success. update_rows changes the first 1000 and sets \`truncated: true\`.

update_rows and delete_rows REFUSE to save without at least one condition — without one they would change every row in the table.

save_row's \`matchColumn\` MUST also appear in \`values\`: it is how the step recognises the row it wrote last time, so a match column the step does not write makes every run insert a duplicate. The validator refuses it.

A condition whose value resolves to nothing SKIPS the step — for a read as much as for a write. Bind conditions to something that is always there.

\`datatableId\` must be the id of a table that already exists and that the ROUTINE'S OWNER may write to — never invent an id. If the user needs a table that does not exist yet, create it FIRST with builder_create_datatable {name, fields} and use the id it returns.

values keys are the column KEYS shown in the Datatables block (e.g. excl_btw for "Excl. btw"); a title is mapped to its key when unambiguous. op aliases (append/insert → add_row, upsert → save_row, list/query → find_rows) are accepted and reported — write the canonical name.

There is NO sql/query field. Pick columns and conditions; the query is built for you.

EXAMPLE: {op:"save_row",datatableId:"tbl_1a2b3c",matchColumn:"email",values:{email:"{{steps.form.output.email}}",status:"new"}}`,
            parameters: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: ['find_rows', 'count_rows', 'add_row', 'save_row', 'update_rows', 'delete_rows'] },
                    datatableId: { type: 'string', description: 'Id of an EXISTING datatable, from the catalog. Never invent one.' },
                    datatableKey: { type: 'string', description: 'That same table\'s `key`, copied EXACTLY as the catalog shows it beside the id. Advisory only — nothing reads it at run time; it is what lets an export/import re-link the step, because an exported routine never carries another workspace\'s table id. Leave it out if you do not have the key; never guess one, or an import re-links to the wrong table.' },
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. Not allowed when the new step itself is a switch.' },
                    where: {
                        type: 'array',
                        description: 'Conditions. Each is {field, op, value}; op is one of eq, neq, gt, gte, lt, lte, contains, notContains, startsWith, endsWith, in, notIn, between, isNull, isNotNull. `in`/`notIn` take an ARRAY value; `between` takes [min, max].',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string' },
                                op: { type: 'string' },
                                value: { description: 'A literal, or a {{...}} template referencing an upstream step.' },
                            },
                            required: ['field', 'op'],
                        },
                    },
                    match: { type: 'string', enum: ['all', 'any'], description: 'How the conditions combine: "all" (default) or "any". There are no nested groups.' },
                    values: { type: 'object', description: 'Column → value for a write. Values may be {{...}} templates.' },
                    matchColumn: { type: 'string', description: 'save_row only: the column that decides update vs insert. Must be unique in the table.' },
                    sort: {
                        type: 'array',
                        description: 'find_rows only: which column orders the rows. ONLY THE FIRST ENTRY IS USED (the row id breaks ties). Defaults to newest first.',
                        items: {
                            type: 'object',
                            properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
                            required: ['field'],
                        },
                    },
                    cursor: { type: 'string', description: "find_rows only: the previous page's `nextCursor`, usually as {{steps.<id>.output.nextCursor}}. Leave it out for the first page." },
                    limit: { type: 'integer', description: 'find_rows only: how many rows at most (1-1000, default 50).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['op', 'datatableId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_create_datatable',
            description: `CREATE a new Studio datatable NOW (at design time) — for a routine that must write rows into a table that does not exist yet ("extract the invoices into a new table called invoice"). This is NOT a step: nothing runs later; the table exists the moment this call answers, owned by the routine's owner, and it appears in the Datatables block. Then write into it with builder_add_datatable {op:"add_row", datatableId:<the id this returns>, values:{<columnKey>: binding}}.

Give the columns the routine will write: name + type (text | number | date | datetime | bool | select with options | multiselect | file); a key is derived from the name when you leave it out ("Excl. btw" → excl_btw). Calling it again with the same name returns the existing table — never a second one. Use builder_add_datatable directly when the Datatables block already lists a fitting table.`,
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The table\'s title as the person sees it in Studio > Datatables, e.g. "Facturen".' },
                    description: { type: 'string', description: 'One sentence: what the rows are.' },
                    fields: {
                        type: 'array',
                        description: 'The columns: [{ name, type, key?, options? (select/multiselect), required? }]. At most 40.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                key: { type: 'string', description: 'snake_case; derived from name when omitted.' },
                                type: { type: 'string', enum: ['text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'file'] },
                                options: { type: 'array', items: { type: 'string' } },
                                required: { type: 'boolean' },
                            },
                            required: ['name', 'type'],
                        },
                    },
                },
                required: ['name', 'fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_knowledge_write',
            description: `Append a step that WRITES text into a KNOWLEDGE BASE, so an agent can answer from it later. Like a datatable, its effect outlives the run — but where a row is data somebody reads back, a knowledge-base document is text an agent will state as FACT, with a citation. Only write things that are true and finished.

Use it for: a resolved support ticket becoming an article; a meeting's decisions becoming searchable; a nightly summary of a system's state. Do NOT use it to stash working data between steps — that is what \`builder_add_datatable\` is for.

\`knowledgeBaseId\` must be a base that already exists and that the ROUTINE'S OWNER may MANAGE — being able to read a base is not permission to add to it. You cannot create one, and you must never invent an id: ask the user for it, or take it from something they showed you. If they need a base that does not exist yet, say so and stop. The save is refused with \`knowledge_write.kb_not_manageable\` if the owner cannot write there, and the same check runs again at run time.

\`content\`, \`title\` and \`sourceUri\` are TEMPLATE STRINGS, not binding objects: write "{{steps.summary.output.text}}" directly, the same way generate_document takes its content.

\`sourceUri\` is what makes the step idempotent. The same sourceUri REPLACES its own document instead of adding a second, so give it something stable and unique per subject — a ticket URL, a record id, "meeting:{{trigger.output.id}}". Without one, a routine that runs nightly leaves a new document every night and nobody can tell why the base grew.

A run where \`content\` resolves to nothing SKIPS rather than storing an empty document. A dry run reports what it WOULD write and stores nothing.

EXAMPLE — each resolved ticket becomes an article: {knowledgeBaseId:"kb_9f2",title:"{{loop.ticket.subject}}",content:"{{steps.article.output.text}}",sourceUri:"ticket:{{loop.ticket.id}}",forEach:{overRef:"steps.tickets.output.rows",itemVar:"ticket"}}`,
            parameters: {
                type: 'object',
                properties: {
                    knowledgeBaseId: { type: 'string', description: 'Id of an EXISTING knowledge base the routine owner may MANAGE. There is no catalog of these in the prompt — never invent one: only ids the user has actually shown you (e.g. from the Knowledge admin) are valid, and anything else is refused at save.' },
                    content: { type: 'string', description: 'The text to store. A {{...}} template — usually the whole output of an earlier step, e.g. "{{steps.summary.output.text}}".' },
                    title: { type: 'string', description: 'What the document is called where a person browses the base. A {{...}} template. Defaults to "Untitled".' },
                    sourceUri: { type: 'string', description: 'A stable, unique reference for THIS subject, so a later run replaces this document instead of adding another — e.g. "ticket:{{loop.ticket.id}}". Strongly recommended on anything that runs more than once.' },
                    nearDuplicateStrategy: { type: 'string', enum: ['skip', 'merge', 'replace', 'add'], description: 'What to do when the base already holds near-identical text under a DIFFERENT source: skip (default, keep what is there), merge, replace, or add anyway.' },
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId. true: INSERT it between afterStepId and its successor(s).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['knowledgeBaseId', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_wire_error_branch',
            description: 'Wire an on-error branch between two EXISTING steps: adds an edge {from, to, label:"on_error"} so that when fromStepId fails (after exhausting its per-step retries), the run continues at toStepId instead of failing. Inside the branch, bind the failure via steps.<fromStepId>.error.message / .errorClass. A run whose failures are all handled this way still reports success ("N step error(s) handled"). Only failure-capable steps may have an error branch: integration_action, ai_step, data_extraction, code, http_request, generate_document, fill_document, presentation, datatable, call_layer, loop, parallel, notification, wait — NOT trigger/condition/switch/approval/form_page/stop_error/return_to_app (the last two END the run, so the branch could never be reached). To create a NEW step directly on the error branch, instead call builder_add_action / builder_add_ai_step / etc. with afterStepId=<failing step> and branch:"error".',
            parameters: {
                type: 'object',
                properties: {
                    fromStepId: { type: 'string', description: 'The step whose failure should be handled (must already exist).' },
                    toStepId: { type: 'string', description: 'The existing step the run continues at when fromStepId fails.' },
                },
                required: ['fromStepId', 'toStepId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_trigger',
            description: `Add an ADDITIONAL trigger (entry point) to the routine — beside the primary one set by builder_propose_trigger. NEVER call builder_propose_trigger a second time to get a second trigger: that REPLACES the primary. Kinds: app_event (appProvider + appEvent + optional filter — same catalog as builder_propose_trigger), schedule (cron + tz), webhook. manual / form / agent_call / app_trigger can only be the primary. Returns the new trigger id: wire its first step with afterStepId:"<that id>" (an omitted afterStepId chains after the LAST step, never after a new trigger). Each trigger is its own root; two roots may converge on one step, and that step can branch on trigger.kind / trigger.event / trigger.id. A schedule run has no payload — start it with a datetime step (op:"now"). Test one root with builder_request_dry_run({triggerStepId}). EXAMPLES: {kind:"app_event",appProvider:"google-calendar",appEvent:"event.upcoming",filter:{leadMinutes:30},label:"Meeting prep"} · {kind:"schedule",cron:"0 7 * * 1-5",tz:"Europe/Amsterdam",label:"Morning briefing"}.`,
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['app_event', 'schedule', 'webhook'], description: 'Trigger kind. Only these may be additional triggers.' },
                    appProvider: { type: 'string', description: 'When kind=app_event: provider id (gmail, google-calendar, google-drive, approvals, nextcloud, …).' },
                    appEvent: { type: 'string', description: 'When kind=app_event: event id (mail.new, label.added, event.upcoming, approval.decided, …).' },
                    filter: { type: 'object', description: 'When kind=app_event: optional filter object, same shape as builder_propose_trigger.' },
                    cron: { type: 'string', description: 'When kind=schedule: standard 5-field cron, e.g. "0 7 * * 1-5".' },
                    tz: { type: 'string', description: 'When kind=schedule: IANA timezone (default Europe/Amsterdam).' },
                    label: { type: 'string', description: 'Short label for the canvas, e.g. "Daily briefing". Defaults to provider · event / the cron.' },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_trigger',
            description: 'Edit a trigger IN PLACE (the primary or an additional one) — its label, an app_event\'s appProvider/appEvent/filter, or a schedule\'s cron/tz. Keeps the id and every edge wired out of it. A trigger cannot change kind in place: remove it (builder_remove_step with the trigger id) and add a new one, or use builder_propose_trigger for the primary.',
            parameters: {
                type: 'object',
                properties: {
                    triggerId: { type: 'string', description: 'The trigger id ("trg" for the primary, or an id returned by builder_add_trigger).' },
                    patch: { type: 'object', description: 'Fields to change: label, appProvider, appEvent, filter (app_event) or cron, tz (schedule). Other keys are ignored.' },
                },
                required: ['triggerId', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_remove_step',
            description: 'Remove a step from the draft by id. By default (reconnect:true) the step\'s predecessors are bridged to its successors so the flow stays connected (deleting a step mid-chain keeps the chain wired, preserving branch labels). Pass reconnect:false to just sever the step and drop its incident edges. To CHANGE a step rather than delete it, use builder_update_step / builder_replace_step instead — recreating mints a new id and breaks downstream references. Also accepts the id of an ADDITIONAL trigger: the trigger and its outgoing edges are removed and any step left without an incoming edge is reported as orphaned. The primary trigger cannot be removed.',
            parameters: { type: 'object', properties: { stepId: { type: 'string' }, reconnect: { type: 'boolean', description: 'Default true: bridge predecessors→successors after removal so the flow stays connected. false: just drop the step and its edges.' } }, required: ['stepId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_step',
            description: `Update an EXISTING step in place by id WITHOUT removing and re-adding it — keeps the step id and ALL wiring (incoming/outgoing edges, branch labels, forEach), so downstream steps.<id>.output.* references keep working. ALWAYS prefer this over remove+add when editing a step. It also MOVES a step: patch {afterStepId:"<id>", branch?:"then"|"else"|"error", caseName?} on the step to move — it is detached from where it is (its neighbours are re-joined) and inserted after the anchor, KEEPING its id, so downstream refs survive. That is how you put a step on a condition's other branch or re-order a chain; never remove-and-re-add for that. On a condition, patch {thenStepId|elseStepId:"<existing step id>"} to wire an existing step onto that branch. Patch is partial: only the fields you pass change. Cannot change a step's type (use builder_replace_step). inputs/fields MERGE key-by-key by default (pass a key value of null to delete just that key; pass inputsMode:"replace" to overwrite the whole map). ${BINDING_HINT} EXAMPLE — retarget an AI step's model and tweak its prompt: {stepId:"ai_1a2b3c",patch:{modelTier:"thinking",prompt:"Summarise concisely in Dutch."}}.`,
            parameters: {
                type: 'object',
                properties: {
                    stepId: { type: 'string', description: 'Id of the step to update (root flow, a flowlet via scope, or a loop-body step).' },
                    patch: { type: 'object', description: 'Fields to change. ANY step: afterStepId (+ branch/caseName) MOVES it — same id, chain re-joined where it left; condition: thenStepId/elseStepId wire an EXISTING step onto that branch. Other allowed keys depend on the step type (ai_step: prompt, systemPrompt, inputs, outputSchema, modelTier, allowTools, tools, knowledgeBaseIds, useMemory, skillIds, agentPermissions, disabledAgentSkillIds (the full list), label, forEach, and agentId ONLY on a step that has none yet — pointing a step at a DIFFERENT agent goes through builder_replace_step, so the permission check runs on it (the one exception is a step INSIDE A LOOP BODY, which builder_replace_step cannot reach at all: patch it here and the same save-time check still runs); data_extraction: source, fields (replaced wholesale — send the full list), instructions, label, forEach; integration_action: tool, inputs, label, forEach; condition: expr, label; switch: expr, cases, defaultBranch, label; code: code (keep its JSDoc @param lines in step with the inputs it reads), inputs, outputSchema, allowedTools, limits, label, forEach; set: fields, arrayRef, operations, maxItems, label, forEach — arrayRef: null exits list mode, operations replace wholesale (null clears); notification: title, body, channels, label, forEach; http_request: url, method, headers, body, timeoutMs, blockPrivateTargets, parseResponse, label, forEach, askOnce, cacheInto; datatable: op, where, values, matchColumn, sort, limit, label, forEach, datatableKey, and datatableId ONLY on a step that has none yet (repointing a step that already names a table goes through builder_replace_step); knowledge_write: content, title, sourceUri, nearDuplicateStrategy, label, forEach, and knowledgeBaseId ONLY on a step that has none yet (repointing a write at a different base goes through builder_replace_step, so the save-time permission check runs on it); loop: overRef, itemVar, maxIterations, label; call_layer: inputs, label; datetime/wait/stop_error/filter/limit/dedupe/aggregate/summarize: their own fields + label; approval: prompt, approval as {expiresInHours (0..720, 0 = no deadline), assignee {userId}|{groupId}, details, attachments, fields}, label — approval steps do NOT accept forEach). Do NOT pass `type` or `id`.' },
                    inputsMode: { type: 'string', enum: ['merge', 'replace'], description: 'How to apply patch.inputs / patch.fields. Default "merge" (per-key; value null deletes that key). "replace" overwrites the whole map.' },
                },
                required: ['stepId', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_steps',
            description: `Apply several step patches in ONE call — the way to fix every dry-run error, or put forEach on two steps, in a single round instead of one builder_update_step per step. Each entry is exactly a builder_update_step call: {stepId, patch, inputsMode?}. All-or-nothing: if any patch fails validation, NONE are applied. ${BINDING_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    updates: {
                        type: 'array',
                        description: 'List of patches to apply, each {stepId, patch, inputsMode?}.',
                        items: { type: 'object', properties: { stepId: { type: 'string' }, patch: { type: 'object', description: 'Same rules as builder_update_step.patch: partial; per-type allowed keys; every input value a {kind,...} binding object; afterStepId (+branch/caseName) MOVES the step keeping its id; on a condition thenStepId/elseStepId wire an existing step onto that branch.' }, inputsMode: { type: 'string', enum: ['merge', 'replace'] } }, required: ['stepId', 'patch'], additionalProperties: false },
                    },
                },
                required: ['updates'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_steps',
            description: `Append SEVERAL steps in ONE call — the fast path for building a flow; strongly preferred over a sequence of single builder_add_* calls once you know every binding. Entries are applied in order. Give each step a short tempId (e.g. "search") and reference it from LATER entries: in any ref path / {{template}} / expr / forEach.overRef / arrayRef write steps.$search.output.<field>, and for wiring fields (afterStepId / thenStepId / elseStepId / nextStepIds values) write "$search" — the server rewrites every $tempId to the real minted id and returns the mapping. An entry without afterStepId chains after the PREVIOUS entry (first entry: after the current last step). Entries apply in order; if entry i fails, the entries before it STAY built and the error tells you which index failed and what to resend. Resend only from that index — built entries are never added twice. ${BINDING_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        maxItems: 20,
                        description: 'Ordered list of steps to append.',
                        items: {
                            type: 'object',
                            // Closed on purpose: llama.cpp compiles this schema
                            // into the decoding grammar, so an open entry lets
                            // the model put step fields BESIDE spec — which it
                            // did on every entry of every live build — and, at
                            // temperature, lets it wander into a corrupt key
                            // (`"{spec": …`, `"{kind": …`) that no longer parses
                            // as the call it meant. Measured 2026-09-16 with the
                            // real menu, 12 runs: 2 corrupt keys with the entry
                            // open, 0 with it closed. `spec` stays free-form, so
                            // nothing becomes inexpressible — only misplaceable.
                            // The server still lifts a stray field into spec for
                            // providers that do not enforce the schema.
                            additionalProperties: false,
                            properties: {
                                tempId: { type: 'string', description: 'Handle for THIS TURN ([A-Za-z][A-Za-z0-9_]*): a handle names ONE step for the whole turn — pick a fresh one for every new step, also in a later builder_add_steps call (re-using a handle for a different step is refused). Reference from later entries as steps.$<tempId>.output.<field> or "$<tempId>" in wiring fields — the $ is REQUIRED; steps.<tempId> without it is stored verbatim and dangles. After a partial batch you may keep using steps.$<tempId> for entries that were built; across turns use the real id.' },
                                type: { type: 'string', enum: ['integration_action', 'ai_step', 'data_extraction', 'condition', 'switch', 'notification', 'set', 'http_request', 'datatable', 'generate_document', 'fill_document', 'slide', 'presentation', 'array_op', 'code', 'datetime', 'wait', 'stop_error', 'form_page', 'approval', 'call_layer', 'knowledge_write', 'loop', 'filter', 'limit', 'dedupe', 'aggregate', 'summarize'] },
                                spec: { type: 'object', description: 'EXACTLY the fields the matching single-step tool takes (tool/inputs, prompt/outputSchema, expr, op, afterStepId, branch:"then"|"else"|"error", caseName, label, …). Put ALL step fields inside spec — never at the entry level. PER-ITEM WORK is forEach:{overRef,itemVar} INSIDE spec — the default, also for MULTI-STEP per-item work: chain the next entry\'s forEach over the previous one\'s output.results. EXAMPLE — read every listed file, extract from each, then save one row per file: [{tempId:"list",type:"integration_action",spec:{tool:"nextcloud_list_files",inputs:{path:{kind:"literal",value:"/Invoices"}}}},{tempId:"read",type:"integration_action",spec:{tool:"nextcloud_read_file",inputs:{path:{kind:"ref",path:"loop.f.path"}},forEach:{overRef:"steps.$list.output.items",itemVar:"f"}}},{tempId:"extract",type:"data_extraction",spec:{source:{kind:"ref",path:"loop.r.output.content"},fields:[{name:"vendor",type:"string",description:"Supplier name"},{name:"amount",type:"number",description:"Total including VAT"},{name:"due_date",type:"date",description:"Payment due date"}],forEach:{overRef:"steps.$read.output.results",itemVar:"r"}}},{tempId:"save",type:"datatable",spec:{op:"add_row",datatableId:"<id from the Datatables block>",values:{vendor:{kind:"ref",path:"loop.x.output.vendor"}},forEach:{overRef:"steps.$extract.output.results",itemVar:"x"}}}]. Extraction is a data_extraction step (fields = output shape, runs on the admin\'s extraction model); an ai_step is for judgement and writing. A type:"loop" entry is RARE (only when a body must branch); its spec.body steps are FLAT step objects ({id, type, tool|prompt, inputs}) with no nested spec wrapper.' },
                            },
                            required: ['type', 'spec'],
                        },
                    },
                },
                required: ['steps'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_replace_step',
            description: 'Replace an existing step\'s TYPE in place, keeping its id and surrounding wiring so downstream steps.<id>.output.* references survive. Provide the full new spec exactly as you would to builder_add_<newType> (omit afterStepId/branch/caseName — position is inherited). Replacing a branching step (condition/switch) with a non-branching one, or vice-versa, rewrites the outgoing branch edges; the result includes a `rewired` note telling you what to finish wiring. For a same-type field change use builder_update_step instead.',
            parameters: {
                type: 'object',
                properties: {
                    stepId: { type: 'string' },
                    newType: { type: 'string', enum: ['integration_action', 'ai_step', 'data_extraction', 'condition', 'switch', 'notification', 'set', 'http_request', 'datatable', 'generate_document', 'fill_document', 'slide', 'presentation', 'code', 'datetime', 'wait', 'stop_error', 'form_page', 'approval', 'call_layer', 'knowledge_write', 'loop', 'filter', 'limit', 'dedupe', 'aggregate', 'summarize'] },
                    spec: { type: 'object', description: 'Full field set for the new type (same shape as the matching builder_add_<type> args, excluding afterStepId/branch/caseName/scope).' },
                },
                required: ['stepId', 'newType', 'spec'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_metadata',
            // The same sentence on both schema variants (builderTools/
            // schemaProjection.js repeats it): a routine nobody named ships
            // as "Untitled automation", and "when the ask names a title" was
            // read by every band as "usually not".
            description: 'Name the routine. REQUIRED once per new draft — in your FIRST reply, bundled with the trigger call: title ≤ 60 chars, in the user\'s language, saying what the routine does ("Facturen uit /Invoices naar tabel Facturen"); description = one sentence. When the request states a title, use it verbatim. Call again to rename.',
            parameters: { type: 'object', properties: { title: { type: 'string', description: '≤ 60 chars, the user\'s language, what the routine does.' }, description: { type: 'string', description: 'One sentence.' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_inspect_tool',
            description: 'Look up integration tools\' EXACT input params AND output shape. The catalog only lists names + an input count, so inspect any action with required inputs (to bind the right param names) or whose output you need to chain (to know whether the field is "results"/"items"/"events"). PREFER the batch form: pass `tools:[…]` with EVERY tool you plan to use, in ONE call — never a serial call per tool. Returns per tool: `inputs` ({name:{type,required,description?,enum?}}), `requiredInputs`, and a one-line output `shape` (sourced from runtime samples when available, else the curated schema).',
            parameters: {
                type: 'object',
                properties: {
                    tools: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Inspect several tools in ONE call (preferred). Exact tool names from the catalog.' },
                    tool: { type: 'string', description: 'Single exact tool name from the catalog (legacy form — prefer `tools`).' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_summarise',
            description: 'Return a deterministic plain-English summary of the current draft. Call after every batch of mutations so the user sees what changed.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_request_dry_run',
            description: 'Execute the draft in dry-run mode. Call this ONCE, when EVERY planned step exists — never mid-build. Side-effect actions are simulated (no real emails sent, no real issues created); read-only and AI steps run for real. Returns ok + note and, per step, its status and a `_hint` of the REAL runtime keys and shape — trust those over any assumption; only a failed step carries its error and input, a forEach reports its failed items, a step that produced nothing says empty:true. If steps errored, fix them ALL with one builder_update_steps call, then dry-run again (both in the SAME reply — calls execute in order). Only after a clean dry-run (ok:true) should you call builder_finalize.',
            parameters: { type: 'object', properties: { triggerPayload: { type: 'object', description: 'Optional fake trigger payload (used to feed app_event triggers a sample).' }, triggerStepId: { type: 'string', description: 'Which trigger to enter through when the routine has ADDITIONAL triggers (an additional trigger\'s own id). Omit for the primary trigger. Dry-run each root separately.' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_finalize',
            description: 'Mark the draft as finalised (is_draft=false). The automation remains INACTIVE until the user clicks Activate in the UI. Only call this after a successful dry-run.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

// ── Apply mutations ─────────────────────────────────────


TOOL_SCHEMAS.push(...require('../../core/documents/documentDiscovery').schemas('builder'));

module.exports = { TOOL_SCHEMAS };

// @typecheck strict
// Part 1 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { BINDING_HINT, APP_EVENT_PROVIDERS, APP_EVENT_EVENTS, PICK_SOURCES, FORM_FIELD_TYPES, FORM_OPTIONS_HINT, FORM_WIZARD_FIELD_PROPS, SPLICE_DESCRIPTION } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_1 = [
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
  - agent_call   — the automation becomes a TOOL an AI agent can call. Set toolName (lower-case, underscores), description (when should an agent call it, and what does it return) and declare EVERY argument the agent must pass in \`params\` (name, type, required, description; names are identifiers). The arguments arrive in the steps as trigger.output.<name> — there is no trigger.payload. You cannot decide which agents may call it: once it is built, the person links the automation to an agent under "Who can call this" in the trigger panel, so tell them.
  - app_trigger  — fired by a button or action in a Studio App. Declare its typed inputs in \`params\`; they arrive as trigger.output.<name>.

SCHEDULE EXAMPLES:
  - weekly Monday 9am Europe/Amsterdam → {kind:"schedule",cron:"0 9 * * 1",tz:"Europe/Amsterdam"}
  - first Monday of the month at 9am  → {kind:"schedule",cron:"0 9 1-7 * 1",tz:"Europe/Amsterdam"}

AGENT_CALL EXAMPLE:
  {kind:"agent_call",toolName:"lookup_warranty",description:"Look up the warranty status of a product by its serial number. Returns the end date and whether it is still covered.",params:[{name:"serial_number",type:"string",required:true,description:"The serial number printed on the device"}]}
  → steps bind {kind:"ref",path:"trigger.output.serial_number"}.

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

  ── Microsoft 365 (Outlook) ──
  • mail.new — fires on every new email in the inbox.
    Filters: mailbox — omit (or "me") for the user's own inbox, or the address
             of a SHARED mailbox the user has Full Access to (checked about
             once a minute; the Microsoft connection needs the .Shared scopes).
    Payload: {changeType, resource, resourceData:{id}, mailbox} — no body.
    EXAMPLE — the team inbox:
      {kind:"app_event",appProvider:"msgraph",appEvent:"mail.new",
       filter:{mailbox:"support@example.com"}}
    Read it with outlook_read {messageId: trigger.output.resourceData.id,
    mailbox: trigger.output.mailbox}, and pass the same mailbox to every
    outlook_* step that searches, replies or sends there: a reply or a send
    with that mailbox goes out FROM the shared mailbox.

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

  Whose events: a pushed event (webhook or bot) reaches the automations of
  the person who caused it. To ALSO react to colleagues' events, set
  filter.includeColleagues:true (off by default). Bee Flow then asks Nextcloud,
  as the automation's owner, whether they can see the resource and only fires
  when they can: a Talk room they are in, a Deck board they can open, a table
  they may read, a form whose results they may see, a file in their Files.
  Calendar events and file.tagged stay with the person who caused them.
  file.new / file.changed need no switch: they read the owner's activity
  feed, which already lists colleagues' changes to files the owner can see.
  Events from guests, bots and public links need no switch (same check).

  Share has NONE of these. Nextcloud does not expose share.created to webhooks
  and there is no poller for it, so an automation triggered on it WILL NEVER FIRE.
  Do not propose it. If the user asks
  for "when a file is shared", say plainly that Nextcloud cannot notify us of
  that yet, and offer a scheduled automation that polls with the matching read
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
    Payload: {id, activityId, path, name, extension, kind, actor, actorName,
             owner, datetime, link, isOwnAction} — the same keys whether the
             webhook or the poller delivered it (unknown ones are null).
             file.renamed also carries {oldPath}.
             Paths are user-relative ("/Documents/x.pdf").
             NOTE: file.deleted carries no id — Nextcloud omits it once the
             node is gone. Bind path, not id.
    EXAMPLE — PDFs landing in /Invoices:
      {kind:"app_event",appProvider:"nextcloud",appEvent:"file.new",
       filter:{inFolder:"/Invoices",extension:"pdf"}}

  • file.tagged — fires when a system tag is assigned to a file.
    Filters: tagId (the numeric id from nextcloud_list_tags, or the tag's name).
    Payload: {fileId, objectIds, tagId, tagIds, objectType, actor, datetime}.
    NOTE: Nextcloud's tag event carries ids only — there is NO tag name and NO
    file path in the payload (a tagId given as a name is looked up when the
    event arrives).
    nextcloud_read_file takes a PATH, not an id: to reach the contents, call
    nextcloud_find_files_by_tag with trigger.output.tagId (its items carry
    path AND id — pick the item whose id equals trigger.output.fileId), then
    nextcloud_read_file with that path; for a download URL use
    nextcloud_direct_link with trigger.output.fileId.

  ── Forms (webhook) ──
  • forms.submitted — fires when someone submits a Nextcloud Form.
    Filters: formId, formHash, titleContains, submittedByEquals,
             includeColleagues (set it for "when SOMEONE submits": without it
             only the owner's own submissions fire).
    Payload: {formId, formHash, formTitle, formOwner, submissionId,
             submittedBy, submittedAt, actor, datetime}.
    The answers are NOT in the trigger payload. Follow it with
    nextcloud_forms_get_submissions bound to trigger.output.formId and
    trigger.output.submissionId — that returns answers keyed by question text,
    so later steps can bind {{steps.<id>.output.submissions[0].answers.<Question>}}.
    EXAMPLE:
      {kind:"app_event",appProvider:"nextcloud",appEvent:"forms.submitted",
       filter:{formId:51,includeColleagues:true}}

  ── Tables (webhook) ──
  • tables.row.added / tables.row.updated
    Filters: tableId, actorEquals, and a value test on one column:
             columnId (NUMERIC) + valueEquals | valueContains, plus
             changedOnly:true to fire only when that column actually changed
             (tables.row.updated only). Without columnId, valueEquals /
             valueContains / changedOnly hold when ANY column satisfies them.
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
    Filters: leadMinutes (default 15; at most a day unless the install
             raises it), calendarId (omit = every calendar the user has),
             summaryContains.
    Payload: {uid, calendarId, calendarUri, summary, startsAt, endsAt,
             location, attendees, minutesUntilStart, actor, datetime}.

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
  proposing one — otherwise the automation activates and stays silent.

  • talk.message.received — fires on every message in a conversation the bot is in.
    Filters: roomToken, roomNameContains, actorEquals, messageContains,
             excludeOwnMessages, includeColleagues (set it for "when someone
             posts": without it only the owner's own messages fire).
    Payload: {messageId, roomToken, roomName, actor, actorName, message,
             isMarkdown, inReplyTo, isOwn, datetime}.
    EXAMPLE — react to questions in one room:
      {kind:"app_event",appProvider:"nextcloud",appEvent:"talk.message.received",
       filter:{roomToken:"a1b2c3d4",messageContains:"?",includeColleagues:true}}

  • talk.reaction.added — fires when someone reacts to a message with an emoji.
    Filters: roomToken, roomNameContains, actorEquals, reaction (a single
             emoji), includeRemoved (default false — un-reacting does not fire).
    Payload: {messageId, roomToken, roomName, actor, actorName, reaction,
             removed, datetime}.
    Use this for reacting to a 👍 as an EVENT, not as an approval gate: to make
    an automation wait for a person's decision, call builder_add_approval, which
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
                                        type: { type: 'string', enum: FORM_FIELD_TYPES },
                                        label: { type: 'string' },
                                        required: { type: 'boolean' },
                                        placeholder: { type: 'string' },
                                        options: { type: 'array', items: { type: 'string' }, description: FORM_OPTIONS_HINT },
                                        accept: { type: 'string', description: 'When type=file: a MIME allowlist, e.g. "application/pdf,image/*".' },
                                        maxSizeMb: { type: 'number', description: 'When type=file: 1–25.' },
                                        source: { type: 'string', description: `REQUIRED when type=app_pick: which app the person filling the form searches. One of: ${PICK_SOURCES}. The search runs against THEIR OWN account, so use this instead of asking someone to paste a transcript or forward an email.` },
                                        multiple: { type: 'boolean', description: 'When type=app_pick: let them pick several records. The answer is then a LIST of descriptors instead of one.' },
                                        maxItems: { type: 'number', description: 'When type=app_pick and multiple: 1–10 (default 5).' },
                                        withText: { type: 'boolean', description: 'When type=app_pick: read the record\'s content into the run (default true). Set false when only a reference is wanted.' },
                                        ...FORM_WIZARD_FIELD_PROPS,
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
                    // §28 agent-callable trigger: automation is exposed as a tool the agent can invoke.
                    toolName: { type: 'string', description: 'When kind=agent_call: the tool name agents will see (lower-case letters, digits, underscores; anything else is rewritten). Defaults to automation_<id>.' },
                    description: { type: 'string', description: 'When kind=agent_call: what the tool does and when an agent should call it (the agent reads this to decide). Required for an agent_call that goes live.' },
                    parametersSchema: { type: 'object', description: 'When kind=agent_call: the arguments as a JSON Schema {type:"object", properties:{<name>:{type,description}}, required:[…]}. Prefer `params`; pass one of the two. Each argument arrives as trigger.output.<name>.' },
                    // App trigger: the automation is fired by a Studio App action with typed inputs.
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
                        description: 'When kind=app_trigger: the typed inputs a Studio App action passes. When kind=agent_call: the arguments the agent passes (type string | number | boolean | array | object; `file` is for app_trigger only). Bind them in steps as trigger.output.<name>. A `file` input arrives at runtime as { fileId, name, mime, size, url } — bind trigger.output.<name>.url into steps that fetch the file (http_request, transcribe_audio, upload tools).',
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
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
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
];

module.exports = { TOOL_SCHEMAS_PART_1 };

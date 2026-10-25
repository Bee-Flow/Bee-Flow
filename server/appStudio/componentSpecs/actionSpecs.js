// @typecheck strict
/**
 * App Studio catalog — the action and step tables: the top-level action kinds
 * (ACTION_SPECS) and the sequence-step kinds (STEP_SPECS), plus the native AI /
 * email / file field tables both of them share.
 */

'use strict';

const { LIMITS } = require('./limits');
const { ACTION_KINDS, STEP_KINDS, DATA_MUTATING_STEP_KINDS, CLIENT_STEP_KINDS, TOAST_TONES, AI_SCHEMA_FIELD_TYPES, AI_EXTRACT_FIELDS, AI_GENERATE_FIELDS, KB_QUERY_FIELDS, SEND_EMAIL_FIELDS, GENERATE_FILE_FIELDS, FILL_DOCUMENT_FIELDS, GENERATE_PRESENTATION_FORMATS, GENERATE_PRESENTATION_FIELDS, REDACT_PDF_FIELDS, FILE_INTAKE_FIELDS, DATASET_QUERY_FIELDS } = require('./actionSpecsActionKinds');

// The look vocabulary is owned by core/documents/deckThemeOptions.js.

/**
 * ai_browse — an AI agent browses the live web (headless Chromium) and the
 * viewer watches the screenshot stream in a browser_view component. The step
 * runs ONLY on the dedicated streaming endpoint (POST …/step/stream); the
 * plain /step route refuses it.
 *
 * Gated three ways before a browser slot is ever taken: the OWNER's
 * browser-fetch integration toggle (the org kill switch), the per-app
 * `definition.aiBrowsing.enabled` flag (HUMAN-set in App settings — the
 * builder AI can author this step but can never switch browsing on), and the
 * action's own role gate. `allowedDomains` here NARROWS the app-level list;
 * it can never widen it.
 *
 * The result is DATA in resultVar ({ status, answer, visitedUrls, steps });
 * nothing auto-chains. Put a `confirm` step between a browse and any
 * create_record/send_email that uses its answer — the page content is
 * untrusted text.
 */
const AI_BROWSE_FIELDS = {
    task: { type: 'binding', required: true },
    url: { type: 'binding' },
    allowedDomains: { type: 'stringList' },
    maxSteps: { type: 'int', min: 1, max: 20 },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * create_record fields — shared by ACTION_SPECS and STEP_SPECS.
 *
 * "Add a row" is one of the four things a button most often does, so it is a
 * top-level ACTION kind as well as a sequence step. The two tables are the SAME
 * object rather than two copies: a field added to the step and forgotten on the
 * action is a field canonicalize would silently drop from every bare
 * create_record action, and nothing would say so.
 */
const CREATE_RECORD_FIELDS = {
    tableId: { type: 'string', required: true },
    values: { type: 'recordValues', required: true },
    resultVar: { type: 'string', maxLen: 60 },
};

const ACTION_SPECS = {
    run_automation: {
        fields: {
            automationId: { type: 'string', nullable: true, required: true },
            inputMapping: { type: 'inputMapping', required: false },
            onSuccess: { type: 'effects', required: false },
            onError: { type: 'effects', required: false },
        },
    },
    ai_extract: { fields: AI_EXTRACT_FIELDS },
    ai_generate: { fields: AI_GENERATE_FIELDS },
    kb_query: { fields: KB_QUERY_FIELDS },
    send_email: { fields: SEND_EMAIL_FIELDS },
    // Writes a row into one of the app's own tables. Server-executed, exactly
    // like the step of the same name — see CREATE_RECORD_FIELDS.
    create_record: { fields: CREATE_RECORD_FIELDS },
    navigate: {
        fields: {
            screenId: { type: 'string', required: true },
            params: { type: 'navParams' },
        },
    },
    toast: {
        fields: {
            message: { type: 'string', required: true, maxLen: 500 },
            tone: { type: 'enum', values: TOAST_TONES, default: 'info' },
        },
    },
    open_url: {
        fields: {
            url: { type: 'url', required: true },
            newTab: { type: 'boolean', default: true },
        },
    },
    open_modal: { fields: { modalId: { type: 'string', required: true } } },
    // The other half of open_modal. Without it an authored Cancel button inside
    // a dialog could not be wired to anything, and a save sequence left the
    // dialog standing open over the form it had just submitted.
    close_modal: { fields: { modalId: { type: 'string', required: true } } },
    // A sequence runs an ordered list of Steps. Its `steps` are validated by
    // the STEP_SPECS table (see validate.js validateActionSteps).
    sequence: { fields: { steps: { type: 'steps', required: true } } },
};

// ---------------------------------------------------------------------------
// Action steps (v2). A Step is { kind, ...fields } where kind ∈ STEP_KINDS.
// Per-kind field tables mirror ACTION_SPECS. Field `type`s used here:
//   string | url | enum | boolean | int | formula (expr string, compiled) |
//   binding (full binding object) | inputMapping | recordValues
//     ({ [col]: binding }) | steps (nested Step[] — branches/bodies) |
//   navParams ({ [key]: {kind:'static',value}|{kind:'formula',expr} }, ≤
//     LIMITS.MAX_NAVIGATE_PARAMS keys — resolved client-side → screen.params).
// `mutatesData` classifies the step for the client/server partition.
// ---------------------------------------------------------------------------

const STEP_SPECS = {
    navigate: {
        mutatesData: false,
        fields: {
            screenId: { type: 'string', required: true },
            params: { type: 'navParams' },
        },
    },
    toast: {
        mutatesData: false,
        fields: {
            message: { type: 'string', required: true, maxLen: 500 },
            tone: { type: 'enum', values: TOAST_TONES, default: 'info' },
        },
    },
    open_url: {
        mutatesData: false,
        fields: { url: { type: 'url', required: true }, newTab: { type: 'boolean', default: true } },
    },
    open_modal: { mutatesData: false, fields: { modalId: { type: 'string', required: true } } },
    close_modal: { mutatesData: false, fields: { modalId: { type: 'string', required: true } } },
    // Clear a mounted form's fields back to their defaults, by form NAME
    // (props.name, node.id fallback — same key registerFormValue uses).
    // Exists because valueFrom deliberately cannot clear a field (pushing ''
    // twice is a no-op by design): without this, switching context on a
    // single-screen app leaves half-typed text in the composer and it gets
    // submitted against the NEW context — the wrong-thread reply bug.
    reset_form: { mutatesData: false, fields: { form: { type: 'string', required: true, maxLen: 100 } } },
    // Hand a file the action just produced straight to the browser.
    //
    // The alternative was parking a file_preview on the screen so the user
    // could find a Download button under it, which costs permanent vertical
    // space on every screen to serve a moment that happens once per run.
    // open_url cannot do this: its `url` is a literal https:// string by
    // contract, and an attachment lives at a per-app, per-file path that only
    // exists after the step above generated it.
    //
    // `file` takes the descriptor a generate_file / file_intake step produced
    // (typically vars.<resultVar>); the client resolves it through the same
    // attachment route file_preview uses, so access is checked identically.
    download_file: {
        mutatesData: false,
        fields: {
            file: { type: 'binding', required: true },
            fileName: { type: 'binding' },
        },
    },
    confirm: {
        mutatesData: false,
        fields: {
            message: { type: 'string', required: true, maxLen: 500 },
            title: { type: 'string', maxLen: 120 },
            confirmLabel: { type: 'string', maxLen: 80 },
            cancelLabel: { type: 'string', maxLen: 80 },
        },
    },
    set_variable: {
        mutatesData: false, // client variable state, not persistent data
        fields: {
            name: { type: 'string', required: true, maxLen: 60 },
            value: { type: 'binding', required: true },
        },
    },
    // Refresh is a DATA concern, so it narrows by table or saved dataset.
    // `actionId` is the v2.0 field; the runtime always ignored it and reloaded
    // everything, so it stays accepted (old definitions keep working) but
    // nothing reads it. With no field set, the whole app's data is invalidated —
    // the original behaviour.
    refresh: {
        mutatesData: false,
        fields: {
            tableId: { type: 'string' },
            datasetId: { type: 'string' },
            actionId: { type: 'string' },   // deprecated, ignored
        },
    },
    run_automation: {
        mutatesData: true,
        fields: {
            automationId: { type: 'string', nullable: true, required: true },
            inputMapping: { type: 'inputMapping' },
            resultVar: { type: 'string', maxLen: 60 },
        },
    },
    /**
     * `resultVar` on the record steps.
     *
     * The runner already writes it for EVERY server step generically
     * (useActionRunner's SERVER_STEP_KINDS branch), and collectVariableRefs
     * already counts it — but with no field in the spec, canonicalize stripped
     * it on every save. So "create the story, then create its tasks under it"
     * was unwritable: the new row's id existed only as
     * `actions.<id>.result.id`, which the very next server step overwrites.
     * Naming the result is what makes a parent-then-children sequence — the
     * shape of every hierarchy — expressible at all.
     */
    create_record: {
        mutatesData: true,
        fields: CREATE_RECORD_FIELDS,
    },
    update_record: {
        mutatesData: true,
        fields: {
            tableId: { type: 'string', required: true },
            recordId: { type: 'binding', required: true },
            values: { type: 'recordValues', required: true },
            resultVar: { type: 'string', maxLen: 60 },
            // OPTIONAL compare-and-set. Bind it to the updated_at of the row
            // the person edited (an inline grid commit carries the whole row,
            // so {kind:'formula',expr:'form.updated_at'}) and the write is
            // refused when someone else changed the row first — instead of
            // silently overwriting them. Omit it and the step stays
            // last-write-wins, which is right for server-authoritative flows
            // where nobody is holding a stale copy.
            expectedUpdatedAt: { type: 'binding' },
        },
    },
    delete_record: {
        mutatesData: true,
        fields: {
            tableId: { type: 'string', required: true },
            recordId: { type: 'binding', required: true },
            resultVar: { type: 'string', maxLen: 60 },
        },
    },
    /**
     * request_approval — create a durable approval request from an app action.
     *
     * There is no run behind it: the decision itself is the outcome. The row
     * lands in the deciders' Approvals inbox (assignee, group, owner, org
     * admin — the same canDecide set run-sourced approvals have) and the app
     * reacts through `onDecided` (a record write executed inside the decide,
     * per-outcome column templates over {{answers.*}}/{{reason}}/…) and the
     * `approval.decided` trigger event. Creation acts as the app OWNER (the
     * row's owner); the real viewer is RECORDED as requested_by, never
     * impersonated — an `anon:` requester can ask, never decide.
     *
     * `fields` are the approver's questions (form vocabulary, no `file`);
     * `context` is an app-chosen payload (e.g. { recordId }) echoed into the
     * hook templates and the event. `resultVar` receives
     * { approvalId, status: 'pending', expiresAt } — the app's durable handle.
     */
    request_approval: {
        mutatesData: true,
        fields: {
            prompt: { type: 'binding', required: true },
            details: { type: 'binding' },                       // markdown shown to the approver
            fields: { type: 'approvalQuestions' },              // questions answered at decide time
            assigneeUserId: { type: 'string', maxLen: 80, nullable: true },
            assigneeGroupId: { type: 'string', maxLen: 80, nullable: true },
            // Panel (multiple approvers) — used INSTEAD of the assignee.
            // Seats are the users plus the groups (a group seat is filled by
            // whichever member votes first), ≤ 10 in total. `rule` decides
            // how votes resolve; quorumCount is N for rule 'quorum'; the
            // final approver is an optional second sign-off stage.
            approverUserIds: { type: 'stringList' },
            approverGroupIds: { type: 'stringList' },
            rule: { type: 'enum', values: ['all', 'first', 'quorum'], default: 'all' },
            quorumCount: { type: 'int', min: 1, max: 10 },
            finalApproverUserId: { type: 'string', maxLen: 80, nullable: true },
            finalApproverGroupId: { type: 'string', maxLen: 80, nullable: true },
            // Stages — an ORDERED chain of up to five named steps, each with
            // its own approvers and its own rule. Set INSTEAD of the assignee,
            // the panel and the final approver: those are the one-stage and
            // two-stage shapes written out longhand, and combining them with a
            // chain would leave a configured approver nobody ever asks.
            // A stage's optional `when` is evaluated ONCE, at request time,
            // against the action scope — which is how "over €5,000 also needs
            // the director" is expressed without a second action.
            stages: { type: 'approvalStages' },
            expiresInHours: { type: 'int', min: 0, max: 720 },  // absent = no deadline (0 too)
            // Nudge + takeover clocks; both must land before the deadline or
            // they are dropped at request time. Escalation WIDENS the decider
            // set (the original approver keeps their rights).
            remindAfterHours: { type: 'int', min: 1, max: 720 },
            escalateToUserId: { type: 'string', maxLen: 80, nullable: true },
            escalateToGroupId: { type: 'string', maxLen: 80, nullable: true },
            escalateAfterHours: { type: 'int', min: 1, max: 720 },
            attachments: { type: 'binding' },                   // studio_attachment descriptor(s)
            context: { type: 'recordValues' },                  // { key: binding } — resolved at request time
            onDecided: { type: 'approvalOnDecided' },           // record-write hook, snapshotted
            resultVar: { type: 'string', maxLen: 60 },
        },
    },
    ai_extract: { mutatesData: true, fields: AI_EXTRACT_FIELDS },
    ai_generate: { mutatesData: true, fields: AI_GENERATE_FIELDS },
    kb_query: { mutatesData: true, fields: KB_QUERY_FIELDS },
    send_email: { mutatesData: true, fields: SEND_EMAIL_FIELDS },
    generate_file: { mutatesData: true, fields: GENERATE_FILE_FIELDS },
    fill_document: { mutatesData: true, fields: FILL_DOCUMENT_FIELDS },
    generate_presentation: { mutatesData: true, fields: GENERATE_PRESENTATION_FIELDS },
    redact_pdf: { mutatesData: true, fields: REDACT_PDF_FIELDS },
    file_intake: { mutatesData: true, fields: FILE_INTAKE_FIELDS },
    dataset_query: { mutatesData: true, fields: DATASET_QUERY_FIELDS },
    ai_browse: { mutatesData: true, fields: AI_BROWSE_FIELDS },
    condition: {
        mutatesData: false, // flow-control; mutation lives in the child steps
        fields: {
            expr: { type: 'formula', required: true },
            then: { type: 'steps', required: true },
            else: { type: 'steps' },
        },
    },
    loop: {
        mutatesData: false,
        fields: {
            source: { type: 'binding', required: true },
            itemVar: { type: 'string', maxLen: 60 },
            indexVar: { type: 'string', maxLen: 60 },
            maxIterations: { type: 'int', min: 1, max: LIMITS.MAX_ACTION_LOOP_ITERATIONS },
            steps: { type: 'steps', required: true },
        },
    },
    switch: {
        mutatesData: false,
        fields: {
            expr: { type: 'formula', required: true },
            cases: { type: 'switchCases', required: true },
            default: { type: 'steps' },
        },
    },
};

module.exports = {
    ACTION_KINDS,
    ACTION_SPECS,
    STEP_KINDS,
    STEP_SPECS,
    CLIENT_STEP_KINDS,
    DATA_MUTATING_STEP_KINDS,
    TOAST_TONES,
    SEND_EMAIL_FIELDS,
    CREATE_RECORD_FIELDS,
    AI_SCHEMA_FIELD_TYPES,
    GENERATE_PRESENTATION_FORMATS,
    GENERATE_PRESENTATION_FIELDS,
};

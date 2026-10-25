// @typecheck strict
'use strict';
/**
 * Fixed guidance blocks of the FULL builder system prompt
 * (../builderPrompt.js buildFullSystemPrompt), which decides when each one
 * is included. Template text kept byte-identical: the prompt is the front
 * of the prompt cache.
 */

// Included only when the user has a webpage tool (§C2 token trim).
const WEBPAGES_GUIDANCE = `
## Inspecting webpages while building

If the user has the Webpages beta, you can call \`webpages_list\`, \`webpage_db_schema\`,
\`webpage_db_query\` and \`webpage_file_read\` DIRECTLY (without going through
\`builder_add_action\`) to look at the user's webapps while drafting. Use them to:
  • pick the right \`webpageId\` from the user's list,
  • read the actual column names + types BEFORE you write any SQL into a
    \`webpage_db_exec\` step (no more guessing whether the column is "factuurnummer"
    or "invoice_number"),
  • peek at existing rows so the INSERT/UPDATE you wire actually matches the
    schema.
The write-capable webpage tools (\`webpage_db_exec\`, \`webpage_file_write\`, etc.)
also work directly when the user explicitly asks you to set the webpage up —
e.g. "create a facturen table" or "add a column" — but for anything that
should happen on every trigger, put it in an \`integration_action\` step instead.

## Webpages — read/write a webapp's data and code

If the user's Webpages app is in the catalog below, automations can act on a
webpage's per-app SQLite database and source files (index.html / style.css /
script.js). The most common use is "append rows to my webapp's database when
something happens" (e.g. new invoice email → INSERT into a facturen table).

Targeting:
  - Every webpage tool requires \`webpageId\`. The Quick mode UI lets the user
    pick a default webpage; bind it as a literal: \`{ webpageId: { kind:"literal", value:"<id>" } }\`.
  - If the user wants the automation to choose at run time, add an \`ai_step\`
    with \`tools:["webpages_list", ...]\` that picks one, and ref it in later
    steps: \`{ webpageId: { kind:"ref", path:"steps.<aiId>.output.webpageId" } }\`.

Database rules (HARD):
  - ALWAYS use \`?\` placeholders and pass values via \`params\`. NEVER interpolate
    trigger/ai output into the SQL string — bind through params instead.
  - Call \`webpage_db_schema\` BEFORE writing any SQL so you know the columns.
  - For idempotent appends (the trigger may fire repeatedly for the same source
    row), either:
      (a) prefix with a \`webpage_db_query\` SELECT to check for an existing row, or
      (b) use \`INSERT ... ON CONFLICT(<unique_col>) DO NOTHING\` on a column with a
          UNIQUE constraint (e.g. an invoice number).

Worked example — "When a Gmail in label 'invoices' arrives, append a row to my
Move Move Facturen webapp":

  1. \`builder_propose_trigger\` → app_event Gmail mail.new, filter labelIds:["Label_invoices"], hasAttachment:true.
  2. \`builder_add_action\` → \`gmail_read_attachment\` with messageId from trigger.
  3. \`builder_add_data_extraction\` → source: the attachment's \`content\`; fields: factuurnummer (string, required), datum (date), type, product (string), liters, excl_btw, btw, incl_btw (number), status (string). No prompt, no outputSchema — the fields ARE the shape.
  4. \`builder_add_action\` → \`webpage_db_exec\`:
       \`webpageId\`: literal (the Move Move Facturen id)
       \`sql\`: \`"INSERT INTO facturen (id, datum, type, product, liters, excl_btw, btw, incl_btw, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"\`
       \`params\`: nine refs into the extraction output (\`steps.<ex>.output.factuurnummer\`, etc.)
  5. Optionally \`builder_add_notification\` so the user gets a "1 invoice added" ping.
`;

// Included only when the user has drive_upload_file (§C2 token trim).
const DRIVE_GUIDANCE = `
## Mail attachments → Google Drive (or other upload targets)

To file an email attachment into Drive without sending the PDF bytes through
the AI context, use the \`sourceHandle\` pattern:

  1. \`builder_propose_trigger\` → \`mail.new\` with \`filter: { hasAttachment: true }\`.
  2. \`builder_add_action\` → \`gmail_read_attachment\` with
     \`messageId: trigger.output.messageId\`,
     \`attachmentId: trigger.output.attachments[0].attachmentId\`,
     \`filename: trigger.output.attachments[0].filename\`.
     The step returns \`{ content, sourceHandle, ... }\`.
  3. \`builder_add_ai_step\` → classify the \`content\` (e.g. is this an invoice?
     supplier / year / month). Set an \`outputSchema\` like
     \`{ isInvoice: 'boolean', supplier: 'string', year: 'string', month: 'string' }\`.
  4. \`builder_add_condition\` on \`steps.<ai>.output.isInvoice\`.
  5. Build the destination path with existing tools — \`drive_search\` to find or
     create the root folder, then \`drive_create_folder\` per level (year →
     month → supplier). Bind each \`parentFolderId\` to the previous step's
     \`output.folderId\`.
  6. \`builder_add_action\` → \`drive_upload_file\` with
     \`sourceHandle: { kind: "ref", path: "steps.<read>.output.sourceHandle" }\`,
     \`name: trigger.output.attachments[0].filename\`,
     \`parentFolderId\` bound to the deepest folder step. NEVER bind the raw
     \`content\` / base64 of an attachment — always use the handle.

Multiple attachments? Wrap steps 2-6 in a \`loop\` over
\`trigger.output.attachments\` with an \`itemVar\` like \`att\`, then reference
\`loop.att.attachmentId\` / \`loop.att.filename\` inside the body.

HARD RULE: when forwarding a mail attachment to any upload target,
\`drive_upload_file\` (and similar) MUST receive a \`sourceHandle\` ref — never
a base64 string and never the OCR'd \`content\`.
`;

// The `code` entry in the step menu — and the only place in this prompt
// that tells the model what a code step COSTS.
//
// This read "code — sandboxed JavaScript (use ONLY when no integration
// fits)" until 2026-09-21, with a second "use only when no integration
// fits" repeated in the lean prompt's hard rules. Both were ABSOLUTE, and
// an absolute ban is not a preference order. The builder traces show what
// that costs: on briefs where nothing else in the menu can do the job — a
// bespoke reshape no `set` expresses, an API with no integration in the
// catalog, arithmetic the expression language cannot state — the model
// either bent an ai_step into a calculator (non-deterministic, and it
// bills tokens on every single run) or told the user the automation could not
// be built at all. The feature is there, the sandbox is hardened, the
// runner dispatches it, and the prompt was the thing forbidding it.
//
// The preference ORDER itself is correct doctrine and survives word for
// word: an integration_action beats hand-written code because the
// integration carries the auth, the retries, the egress ledger and the PII
// guard; the declarative steps beat code because they are readable on the
// canvas and free at run time. What changes is that "last" is now the last
// rung of a ladder instead of a closed door, and that the rung states its
// price. A model told what a tool costs reaches for it in the right places;
// a model told never to touch it cannot.
//
// The costs listed are not decoration — each one is a hard failure the
// sandbox produces, and the model cannot learn them by trying, because the
// code it writes runs for the first time in the user's dry run. Sources:
// automation/codeSandbox.js (a V8 isolate with no Node bindings, no
// filesystem, no raw sockets; DEFAULT_LIMITS {memoryMb:64, cpuMs:1000,
// wallMs:5000} clamped by MAX_LIMITS {256, 10_000, 30_000, httpBudget:20}
// with HTTP_BUDGET_DEFAULT 5; ctx.http is HTTPS-only behind the three-layer
// SSRF guard) and that module's SecretsNotConfiguredError — ctx.secrets()
// THROWS and a step that declares secretKeys fails outright, so a key has
// to arrive through `inputs` or through ctx.integrations.<tool>, which
// calls a connected app under its own credentials.
//
// The PARAMETERS sentence is not style advice either: the step settings
// parse the JSDoc on main (automation/codeSafety, analyzeCode().params)
// into the step's input form, so an input without a @param line reaches
// the person who fills the step in as a bare name with no explanation.
const CODE_STEP_MENU_ENTRY = `code             — sandboxed JavaScript, for the work no other step expresses.
                     A PREFERENCE ORDER, not a prohibition: (1) an integration_action from the
                     catalog — it carries the auth, the retries, the egress ledger and the PII
                     guard, so it beats code every time it fits; (2) the declarative steps —
                     set / array_op / datetime / data_extraction / http_request — readable on
                     the canvas and free at run time; (3) code. Reach the third rung without
                     apology when the first two genuinely do not fit: a bespoke transformation,
                     an API nobody wrote an integration for, a calculation no step states.
                     Faking it with an ai_step instead is the WORSE answer — that is
                     non-deterministic and bills tokens on every run.
                     What it costs, so you can judge before you write it: NO npm packages and
                     no require/import (plain JS in a bare isolate), no filesystem, no raw
                     sockets, no process or env. Network is \`ctx.http(url, opts)\` only —
                     HTTPS only, private and internal addresses blocked, a handful of calls per
                     run. CPU and wall clock are CLAMPED (about 1s of CPU and 5s of wall by
                     default, ceilings of 10s and 30s), so no polling, no sleeping, no waiting
                     on a slow API. NO SECRETS: \`ctx.secrets()\` throws and declaring
                     \`secretKeys\` fails the step — a credential must come in through
                     \`inputs\`, or via \`ctx.integrations.<tool>\`, which calls a connected app
                     under its own credentials. Write \`async function main(inputs, ctx)\` and
                     return the result. PARAMETERS: put a JSDoc block on main whose first line
                     says what the step does, then one
                     \`@param {type} inputs.<name> - <short description>\` per input the code
                     reads (\`[inputs.name=value]\` for a default). The step settings turn these
                     into a form a non-programmer fills in, so describe each input in plain
                     words, and bind the step's \`inputs\` by those names. Write \`ctx.http\` URLs
                     as literal https:// strings so the safety check can see where data goes.`;

module.exports = { WEBPAGES_GUIDANCE, DRIVE_GUIDANCE, CODE_STEP_MENU_ENTRY };

/**
 * System prompt for the conversational automation builder agent.
 *
 * Two variants ship side by side:
 *   - buildFullSystemPrompt — long, exhaustive guidance the frontier
 *     models (Opus, GPT-5-pro, o3, Mistral Large) use today.
 *   - buildLeanSystemPrompt — ~80 lines, hard rules + binding examples
 *     only; for small/reasoning models that lose focus on a 200-line
 *     wall of guidance. Written per MENU (`menu`): the small band's lean
 *     projection, or the full menu the reasoning band keeps.
 *
 * Few-shot helpers prepend short worked dialogues to the message history
 * when the model profile requests them (see builderModelProfiles.js).
 */
const {
    renderCatalog, renderCatalogSlim, renderDatatablesBlock, renderDocumentsBlock, renderPickerBlocks, renderAgentsBlock, renderKnowledgeBasesBlock, emptyCatalogLine,
} = require('./builderPrompt/catalogRender');
const { buildFewShotMessages } = require('./builderPrompt/fewShotExamples');
const { renderTriggerBlockLean } = require('./builderPrompt/triggerBlock');
const { CONDITION_RULES_HINT } = require('./builderTools/ruleExamples');
const { canvasOnlyMenu, BATCH_STEP_TYPES, ARRAY_OP_FAMILY } = require('./builderTools/stepTypeTable');
const { leanBatchTypes } = require('./builderTools/schemaProjection');
const { WEBPAGES_GUIDANCE, DRIVE_GUIDANCE, CODE_STEP_MENU_ENTRY } = require('./builderPrompt/fullPromptGuidance');
const { FULL_PROMPT_INTRO, FULL_PROMPT_STEP_MENU } = require('./builderPrompt/fullPromptMenu');
const { FULL_PROMPT_WORKFLOW, FULL_PROMPT_RULES, FULL_PROMPT_PITFALLS, FULL_PROMPT_PITFALLS_TAIL } = require('./builderPrompt/fullPromptWorkflow');
const { FULL_PROMPT_FORMS } = require('./builderPrompt/fullPromptForms');
const { FULL_PROMPT_TABLES } = require('./builderPrompt/fullPromptTables');
const { FULL_PROMPT_AI_CHECKS } = require('./builderPrompt/fullPromptAiChecks');


// The name a draft has until somebody names it. The same literal lives in
// routes/ai/automationBuilder/builderDraft.js and builderTools/deriveTitle.js.
const UNTITLED_AUTOMATION = 'Untitled automation';

// Both prompt builders take ONLY inputs that are constant for a builder
// session: the catalogue (ordered once, replayed — see builderPrompt/rankApps.js)
// and two feature flags. Timezone, web-search preference, disabled media and
// the user's model tiers are deliberately not parameters, since each of them is read
// fresh per request (the client re-reads scopedStorage on every send; the tier
// set is rebuilt per turn). Rendered here they would make the system prompt — the
// front of the prompt cache — differ between two turns of the SAME session,
// which on the single-slot local box means re-reading ~25k tokens per reply.
// They travel in the late per-turn message instead: renderTurnPreferences().
function buildFullSystemPrompt({ catalog, codeStepEnabled }) {
    const apps = renderCatalogSlim(catalog);
    // '' when the caller could not build the list (nothing is said), the
    // "none" line when the user has no tables — see renderDatatablesBlock.
    // canCreate: the full menu carries builder_create_datatable.
    const datatablesBlock = renderDatatablesBlock(catalog?.datatables, { canCreate: true, requireChoice: !!catalog?.datatableRequireChoice });
    // The designed documents a fill_document step may point at — same
    // three-way rendering, same reason (see renderDocumentsBlock).
    const documentsBlock = renderDocumentsBlock(catalog?.documents);

    // §C2 token trim: only inject the (long) Webpages and Drive-sourceHandle
    // guidance when the user actually has those tools — saves ~600 tokens for
    // the ~99% of sessions that don't.
    const toolNames = new Set();
    for (const a of (catalog?.apps || [])) for (const act of (a.actions || [])) if (act && act.name) toolNames.add(act.name);
    const hasWebpages = [...toolNames].some(n => n.startsWith('webpage'));
    const hasDriveUpload = toolNames.has('drive_upload_file');

    const webpagesGuidance = !hasWebpages ? '' : WEBPAGES_GUIDANCE;
    const driveGuidance = !hasDriveUpload ? '' : DRIVE_GUIDANCE;

    // The `code` entry in the step menu: CODE_STEP_MENU_ENTRY in
    // ./builderPrompt/fullPromptGuidance.js says why it reads as a preference
    // order with its costs, not a ban.
    const codeStepMenuEntry = codeStepEnabled
        ? CODE_STEP_MENU_ENTRY
        : '(code steps are currently DISABLED — never propose them)';

    return `${FULL_PROMPT_INTRO}${codeStepMenuEntry}${FULL_PROMPT_STEP_MENU}${canvasOnlyMenu()}${FULL_PROMPT_WORKFLOW}${FULL_PROMPT_RULES}${FULL_PROMPT_FORMS}${FULL_PROMPT_TABLES}${FULL_PROMPT_AI_CHECKS}${FULL_PROMPT_PITFALLS}${CONDITION_RULES_HINT}${FULL_PROMPT_PITFALLS_TAIL}${webpagesGuidance}${driveGuidance}
${datatablesBlock ? `${datatablesBlock}\n\n` : ''}${documentsBlock ? `${documentsBlock}\n\n` : ''}## Catalog (only these are available)

${apps || emptyCatalogLine(catalog)}

Begin now.`;
}

/**
 * Per-turn dynamic context: the live draft state (+ optional canvas-scope
 * hint), emitted as its OWN system message placed late in the message list
 * instead of inside the big static system prompt. Why: the static prompt +
 * catalog then stay byte-stable across turns, so the Anthropic 1h prefix
 * cache (cache_control on the FIRST system block, claude.js extractSystem)
 * survives draft mutations, and OpenAI's implicit prefix caching gets the
 * longest possible stable prefix. This block changes every turn — it must
 * never live inside the cached block.
 */
function renderDraftStateSystemMessage({ agentDraftState, canvasScope = null, title } = {}) {
    if (!agentDraftState) return null;
    // The automation's name, first — or the fact that it has none. `title` is
    // optional so callers that render only the graph keep their bytes; the
    // builder route passes draftWrap.title, and the default name counts as
    // untitled so the model is told to name it in THIS reply rather than
    // reading "Untitled automation" as a title someone chose.
    const titleLine = title === undefined ? '' : (
        typeof title === 'string' && title.trim() && title.trim() !== UNTITLED_AUTOMATION
            ? `Title: "${title.trim()}"\n\n`
            : 'Title: (untitled — call builder_set_metadata in this reply)\n\n'
    );
    let msg = `## Current draft — LIVE state (real step IDs, settings & bindings)

${titleLine}This is the exact current contents of the automation: every step's real \`id\`,
its type/tool/settings, its input bindings (the mapping between steps shown as
\`key=value\`), and the edge wiring — for the MAIN FLOW and EVERY flowlet. Use these
IDs directly for \`afterStepId\`, \`scope\`, \`thenStepId\`/\`elseStepId\`, and ref paths
(\`steps.<id>.output.<field>\`). NEVER ask the user for a step ID — read it here.

${agentDraftState}`;
    if (typeof canvasScope === 'string' && /^[a-z][a-z0-9_]*$/.test(canvasScope)) {
        msg += `\n\nThe user is currently viewing flowlet '${canvasScope}' on the canvas. When they ask to add or change steps without naming a flow, default the builder tools' \`scope\` argument to "${canvasScope}" when sensible; omit \`scope\` for changes to the main flow.`;
    }
    return msg;
}

/**
 * The per-turn preferences as a "## This turn" block for the late dynamic
 * system message (placed after the history, right before the user message —
 * outside the cached prefix). These are exactly the lines the two system
 * prompts must not render inline, because each of them can
 * legitimately differ between two turns of one session (see the note above
 * buildFullSystemPrompt). Absent inputs render nothing: an undefined
 * `webSearchEnabled` is "no preference", not "disabled".
 *
 * @returns {string|null} null when no preference is set at all
 */
function renderTurnPreferences({ userTimezone, webSearchEnabled, webResearchLine, disabledMedia, allowedModelTiers } = {}) {
    const lines = [];
    if (typeof userTimezone === 'string' && userTimezone.trim()) {
        lines.push(`- All times use the user's timezone: ${userTimezone.trim()}.`);
    }
    if (Array.isArray(allowedModelTiers) && allowedModelTiers.length) {
        lines.push(`- ai_step \`modelTier\` MUST be one of: ${allowedModelTiers.join(', ')} — these are the only tiers configured for this user. When unsure, use "auto" (or omit it).`);
    }
    if (typeof webSearchEnabled === 'boolean') {
        lines.push(webSearchEnabled
            ? '- Web search: ENABLED — you may propose `agent_search` as a step when the automation needs current information from the web.'
            : '- Web search: DISABLED — avoid proposing `agent_search` steps unless the user explicitly asks for web-based data.');
    }
    // Whether the builder ITSELF can search this turn (webResearch.js). Apart
    // from the line above, which is about steps in the automation: without it
    // the model told users to search for API documentation themselves.
    if (typeof webResearchLine === 'string' && webResearchLine) lines.push(webResearchLine);
    for (const [k, v] of Object.entries(disabledMedia || {})) {
        if (v) lines.push(`- The user disabled ${k} generation. Do not propose ${k}-related actions.`);
    }
    if (!lines.length) return null;
    return `## This turn\n\n${lines.join('\n')}`;
}

/**
 * The notice that tells the model it holds the REDUCED menu, and what that
 * leaves out. Derived from the same two lists the menu is built from (the batch
 * types of stepTypeTable.js and the lean projection's LEAN_BATCH_TYPES), so it
 * cannot say a step type is missing that the menu serves, or the opposite. A
 * small model never saw the full prompt: without this line it does not know
 * that a document, a switch or a wait EXISTS, and builds the rest silently.
 * Static text: it belongs in the system prompt, which stays the same for every
 * user and session of the band.
 */
function leanMenuNotice({ codeStepEnabled = false } = {}) {
    const buildable = leanBatchTypes({ codeStepEnabled });
    // Disabled code steps are said once, by the code rule ("DISABLED"); they are
    // not listed a second time as a gap of the menu.
    const covered = new Set([...buildable, 'code', ...(buildable.includes('array_op') ? ARRAY_OP_FAMILY : [])]);
    const missing = BATCH_STEP_TYPES.filter(t => !covered.has(t));
    return `## This is the reduced menu

You hold the compact tool menu. Step types you can build: ${buildable.join(', ')} (array_op also covers ${ARRAY_OP_FAMILY.join(', ')}). NOT on this menu: ${missing.join(', ')}, flowlets and additional triggers. If the request needs one of those, build everything else, then say in ONE sentence of your summary which part the user must add on the canvas, or that a larger model can build it. Never claim a step you could not create.

`;
}

/**
 * Lean prompt for small / reasoning models. Hard rules + binding examples
 * only, for a band that loses focus on the 220-line full prompt.
 *
 * `menu` says which tool menu the prompt is read beside, because the prompt
 * and the menu are written together and a sentence about a tool the menu
 * lacks is a round wasted (builderPrompt.coreMenuDoctrine.test.js pins that
 * for 'lean'):
 *   - 'lean' (the default; the small band): the LEAN schema projection
 *     (builderTools/schemaProjection.js) — no flowlets, no additional
 *     triggers, no delegation, no loop container, no switch, no batch update.
 *     Every section teaches a tool that menu serves and nothing it does not,
 *     and the app-event knowledge the projected builder_propose_trigger no
 *     longer carries is rendered as `## Triggers`.
 *   - 'full' (the reasoning band: lean prose, full menu, full schemas): the
 *     same prose plus what that menu serves — the loop container beside
 *     forEach, `## Flowlets`, `## Additional triggers`, the delegate half of
 *     the plan section, the switch rule and builder_update_steps as the
 *     dry-run repair. Before 2026-09-17 this was the only lean prompt; the
 *     diet must not tell a model with builder_add_loop on its menu that
 *     "there is no loop container".
 *
 * `catalogPlacement` decides where the three PER-USER blocks — the app
 * catalog, the datatables, the documents — go. 'system' (the default, and
 * what the cloud bands use) renders them here, at the end. 'dynamic' (the
 * small band) leaves them out and points at the late dynamic message
 * (renderCatalogContextMessage), so this prompt is byte-identical across
 * users and sessions and the local box's prompt cache survives a new build.
 *
 * Use the few-shot helper to teach by example instead.
 */
function buildLeanSystemPrompt({ catalog, codeStepEnabled, batchTools = false, catalogPlacement = 'system', menu = 'lean' }) {
    const fullMenu = menu === 'full';
    const dynamicCatalog = catalogPlacement === 'dynamic';
    const apps = dynamicCatalog ? '' : renderCatalogSlim(catalog);
    // Same three-way rendering as the full prompt (see renderDatatablesBlock).
    // canCreate: the core menu carries builder_create_datatable too.
    const datatablesBlock = dynamicCatalog ? '' : renderDatatablesBlock(catalog?.datatables, { canCreate: true, requireChoice: !!catalog?.datatableRequireChoice });
    const documentsBlock = dynamicCatalog ? '' : renderDocumentsBlock(catalog?.documents);

    // The dry-run repair the menu serves: the lean projection drops the
    // all-or-nothing batch update (one call per failing step keeps the round
    // count and gains a per-call ladder); the full menu still has it.
    const repairCall = fullMenu
        ? 'ONE `builder_update_steps` call for the failing steps (or one `builder_update_step` per step)'
        : 'ONE `builder_update_step` per failing step';

    // Batch-protocol paragraph, rendered whenever the caller's profile carries
    // the batch tools. Since 2026-09-11 that includes the SMALL profile: its
    // serial wording was costing a round per step and a round per inspected
    // tool (see CORE_TOOL_NAMES in builderModelProfiles.js).
    const batchSection = batchTools ? `
## Batch your calls

You may emit SEVERAL tool calls in one reply — they execute in order. Typical build: reply 1 = \`builder_set_plan\` + \`builder_propose_trigger\` + \`builder_set_metadata\` + \`builder_inspect_tool({tools:[all tools you'll use]})\`; reply 2 = ONE \`builder_add_steps\` call with every step (tempIds cross-reference: \`steps.$a.output.x\`, \`afterStepId:"$a"\`); reply 3 = \`builder_summarise\` + \`builder_request_dry_run\`; reply 4 = \`builder_finalize\`, or ${repairCall} + \`builder_request_dry_run\` again. Never send \`builder_set_plan\` alone in a reply.
` : '';

    // Step 3's per-type list is the menu's: the lean projection has no loop
    // container, no set step and no form page.
    const perTypeTools = fullMenu
        ? 'The per-type tools are `builder_add_action`, `builder_add_ai_step`, `builder_add_loop`, `builder_add_condition`, `builder_add_notification`, `builder_add_http_request`, `builder_add_data_extraction`, `builder_add_datatable`, `builder_add_approval`, `builder_add_set`, `builder_add_array_op` (and, for a form-triggered automation that needs more input or a closing summary, `builder_add_form_page`).'
        : 'The per-type tools are `builder_add_action`, `builder_add_ai_step`, `builder_add_condition`, `builder_add_notification`, `builder_add_http_request`, `builder_add_data_extraction`, `builder_add_datatable`, `builder_add_approval`, `builder_add_array_op`.';

    // Per-item work. On the lean menu there is one way (forEach on the step,
    // chained); the full menu also has the loop container, and the bullets
    // say when it is the right one.
    const loopBullets = fullMenu
        ? `   - PREFER \`forEach\` ON THE STEP over a \`loop\` container. Set \`forEach:{overRef:"steps.<id>.output.<array>", itemVar:"item"}\` on the step itself (integration_action / ai_step / code / notification / set / http_request / datatable / knowledge_write) and reference the item as \`loop.<itemVar>\`. It reads as one node on the canvas instead of a nested block.
   - CHAIN per-item work with forEach — you almost never need a \`loop\`. A \`forEach\` step publishes \`steps.<id>.output.results\`, one entry per item carrying \`{index, item, output, status}\`. Point the NEXT step's \`forEach\` at that array and per-item correlation is preserved: \`loop.<v>.item\` is the original item and \`loop.<v>.output\` is that same item's result from the previous step. So "read each file, then extract from each file" is TWO flat forEach steps, not a loop.
   - A failed item's entry has \`status:"error"\` and NO \`output\` key. Before chaining, drop them: \`builder_add_array_op({op:"filter", arrayRef:"steps.<prev>.output.results", expr:"equals(item.status, \\"success\\")"})\` and point the next \`forEach\` at that filter's \`output.items\`.
   - A \`loop\` container is for the rare case where two steps must read the SAME source item without one consuming the other's results, or where a body step branches. It is also ALL-OR-NOTHING: one failing item aborts the whole loop, while \`forEach\` records the failure, carries on, and only fails if every item failed. Prefer \`forEach\`. Never wrap a single step in a loop.`
        : `   - There is no loop container on this menu. Per-item work is \`forEach\` on the step (\`forEach:{overRef:"steps.<id>.output.<array>", itemVar:"f"}\`, the item is \`loop.f\`); a forEach step publishes \`steps.<id>.output.results\`, one entry per item as \`{index, item, output, status}\`. Chain: the next step's forEach points at \`steps.<prev>.output.results\` and reads \`loop.<v>.output.<field>\` — "read each file, then extract from each file" is TWO flat forEach steps. Failed items have \`status:"error"\` and no \`output\` — drop them first with \`builder_add_array_op({op:"filter", arrayRef:"steps.<prev>.output.results", expr:"equals(item.status, \\"success\\")"})\` and point the next forEach at that filter's \`output.items\`.`;

    // Which trigger fired. The full menu can branch on it with a switch and
    // can add flowlets, whose own trigger is their input contract.
    const triggerKinds = fullMenu
        ? `\`trigger.kind\` (app_event | schedule | webhook | form | manual | agent_call | app_trigger), \`trigger.id\`, \`trigger.provider\` + \`trigger.event\` (app events, e.g. "gmail" + "mail.new"), \`trigger.firedAt\`, \`trigger.schedule.cron\`, and \`trigger.source\` (how THIS run was started — "manual" for a test run of any trigger). When a step is reachable from several triggers, branch on them: \`builder_add_switch({expr:"trigger.event", …})\` or \`builder_add_condition({expr:"trigger.kind == \\"schedule\\""})\`. Inside a flowlet these are NOT available (a flowlet's trigger is its own input contract) — pass them in as params.`
        : `\`trigger.kind\` (app_event | schedule | webhook | form | manual | agent_call | app_trigger), \`trigger.provider\` + \`trigger.event\` (app events, e.g. "gmail" + "mail.new"), \`trigger.firedAt\`, \`trigger.schedule.cron\`, and \`trigger.source\` (how THIS run was started — "manual" for a test run of any trigger).`;

    // The sections only the full menu serves.
    const fullMenuSections = fullMenu ? `## Flowlets (inline sub-flows)

For a reusable named sub-flow: \`builder_create_layer({title, params})\` → \`{layerKey}\`; add its steps with the normal tools passing \`scope:"<layerKey>"\`; set returns via \`builder_set_layer_contract({layerKey, outputFields})\`; run it with \`builder_add_call_layer({layerKey, inputs})\`. Inside a flowlet bind ONLY \`trigger.output.<param>\`, the flowlet's own steps, and \`vars\` — never parent-flow steps. Recursion is rejected; approval steps are not allowed inside flowlets.

## Additional triggers

Extra entry points: \`builder_add_trigger({kind:"app_event"|"schedule"|"webhook", …})\` (never a second builder_propose_trigger — that replaces the primary). Wire the root's first step with \`afterStepId:"<triggerId>"\`; branch shared steps on \`trigger.kind\` / \`trigger.event\`; dry-run a root with \`triggerStepId\`.

` : '';

    const planHeading = fullMenu ? '## Plan & delegate' : '## Plan';
    const delegateHalf = fullMenu
        ? ' Delegate with `builder_generate_layer({title, instruction, params, outputFields})` / `builder_generate_layers({layers:[…]})` (up to 3 in parallel) ONLY for two or more INDEPENDENT multi-step sub-flows or a reusable flowlet — a single linear flow is faster built directly. Then wire each with `builder_add_call_layer`.'
        : '';
    const switchRule = fullMenu ? ' For a `switch`, pass `caseName` when appending a branch step.' : '';

    // The hard-rule half of the same change as codeStepMenuEntry above — see
    // that comment for why the absolute "use only when no integration fits"
    // went. This bullet matters more than the menu entry does, because the lean
    // prompt has NO step menu: for the small band these two sentences are
    // everything the model ever reads about code steps, so they have to carry
    // both the order and the price.
    //
    // It deliberately does NOT name `builder_add_code_step`. That tool is not
    // in CORE_TOOL_NAMES (builderModelProfiles.js), so a core-menu build
    // literally cannot emit the name — grammar-constrained decoding substitutes
    // a wrong tool or writes the call as text, which the leak recovery then
    // rejects as unknown_tool. On this menu a code step is an entry of type
    // "code" inside builder_add_steps. Naming the tool here is exactly the
    // drift builderPrompt.coreMenuDoctrine.test.js ratchets against, and the
    // ratchet cannot see it (it builds the prompt with code steps off), so the
    // companion test in builderPrompt.codeStepDoctrine.test.js pins it with the
    // flag ON.
    //
    // The declarative steps it names (data_extraction, array_op, http_request)
    // are the ones BOTH projections of this prompt actually serve — `set` and
    // `datetime` are full-menu only, and recommending a step the model has no
    // way to add is how a rung of the ladder becomes a dead end.
    const codeStepRule = codeStepEnabled
        ? 'Code steps are available, as the LAST rung of a ladder — not as a forbidden one. '
          + 'Prefer an integration_action (it carries the auth, the retries, the egress ledger and the PII guard); '
          + 'then a declarative step (data_extraction, array_op, http_request); then a `code` entry. '
          + 'When none of those fits — a bespoke transformation, an API with no integration, a calculation no step states — '
          + 'write the code rather than faking it with an ai_step, which is non-deterministic and bills tokens every run. '
          + 'Its price: no npm, no require/import, no filesystem, no raw sockets; network only through `ctx.http` '
          + '(HTTPS, private addresses blocked, a few calls per run); CPU and wall clock clamped (~1s / 5s by default); '
          + '`ctx.secrets()` throws, so a credential arrives through `inputs` or via `ctx.integrations.<tool>`. '
          + 'Declare every input the code reads in a JSDoc block on main, `@param {type} inputs.<name> - <short description>`: '
          + 'the step shows these as a form, and its `inputs` are bound by those names. '
          + 'What main returns is read under `steps.<id>.output.result` (a returned object\'s field: `steps.<id>.output.result.<field>`).'
        : 'Code steps are DISABLED — never propose them.';

    // Where the per-user blocks are, when they are not here.
    const catalogTail = dynamicCatalog
        ? 'The catalog, your datatables and documents are in the message right before the user\'s — the ONLY tools/tables you may propose.'
        : `${datatablesBlock ? `${datatablesBlock}\n\n` : ''}${documentsBlock ? `${documentsBlock}\n\n` : ''}## Catalog (the ONLY tools you may propose)

${apps || emptyCatalogLine(catalog)}`;

    return `You are the BeeFlow Automation Builder. Your only output channel is the structured \`builder_*\` tools — do NOT describe steps in prose, call the tool.
${batchSection}
## Workflow

1. Call \`builder_propose_trigger\` first (kind: schedule | manual | webhook | form | app_event | agent_call | app_trigger — see "## Triggers").
2. The catalog lists action names + an input COUNT only. Before adding an \`integration_action\` with required inputs (or whose output you'll chain), call \`builder_inspect_tool({tools:[…]})\` ONCE with every tool you'll use to get the exact param names + output shape — don't guess. (Adding a non-trivial action without inspecting it first is rejected — the rejection inlines the schema; resend the corrected call.)
3. Add the steps.${batchTools ? ' DEFAULT: ONE `builder_add_steps` call carrying the WHOLE chain — every step of a 6-step automation in a single call, cross-referenced by tempId (`steps.$a.output.x`, `afterStepId:"$a"`). Entries apply in order; if entry i fails, the entries before it STAY built and the error tells you which index failed and what to resend. Resend only from that index — built entries are never added twice. Reach for a single `builder_add_*` call only to append ONE step to a draft that already exists.' : ''} ${perTypeTools}
${loopBullets}
   - For an \`ai_step\`, split instructions: put the role/persona/tone/output-style in \`systemPrompt\` and the concrete per-run task + data references in \`prompt\`. Leave \`systemPrompt\` off for trivial one-off transforms.
   - EXTRACTION IS NOT AN ai_step. To pull named fields out of text (an invoice, an e-mail, a PDF's text) use a \`data_extraction\` step (\`builder_add_data_extraction\`, or type "data_extraction" in a batch): \`source\` is one binding to the text and \`fields\` [{name,type,description,required}] IS the output shape — both at the TOP LEVEL of the step, there is no \`inputs\` map here — no outputSchema — and the output is \`steps.<id>.output.<name>\` (null when absent). Use an \`ai_step\` for judgement and writing.
   - DATATABLES. Table exists AND the user named it (or the flow uses it) → \`add_row\` into it with its id AND key; an existing table they did not name → ask with \`builder_ask_questions {datatableIds}\`. Table missing → \`builder_create_datatable({name, fields:[{name,type}]})\` first (design time, not a step — a create-table step does not exist; in a preview it is staged with a "pending:<n>" id and created when the user applies), then \`add_row\` with the returned id/key. \`values\` keys = column keys (lowercase with underscores: "Excl. btw" → \`excl_btw\`), values = \`{kind:"ref"}\` bindings, one row per item via forEach over the extraction's \`output.results\`. Name extraction fields after the destination columns. For a Nextcloud Tables row name the table by its exact title when you do not know its id: \`tableId:{kind:"literal", value:"Facturen"}\` — do not guess a number. Nextcloud Tables (\`nextcloud_tables_*\` actions) are not Bee Flow datatables; to turn such a step into a datatable step use \`builder_update_step({stepId, patch:{type:"datatable", op, datatableId, datatableKey, values}})\` — same id, same wiring.
4. To CHANGE a step, use \`builder_update_step({stepId, patch})\` — it keeps the id and wiring. To MOVE a step, or put it on a condition's other branch, patch its position the same way: \`builder_update_step({stepId, patch:{afterStepId:"<id>", branch:"else"}})\` — same id, same refs. NEVER delete and re-add a step to edit or move it (that mints a new id and breaks downstream refs).
5. Call \`builder_summarise\` so the user can see the plan, in the same reply as the dry run.
6. Call \`builder_request_dry_run\` to test. Read errors. Fix every failing step with ${repairCall} and rerun — all in the SAME reply. Dry-run \`_hint\` keys are ground truth: rebind to them.
7. Call \`builder_finalize\` once the dry-run is clean.

## Binding rules (the #1 source of errors)

EVERY tool input value must be a binding object — never a bare string/number:

  literal:   { kind: "literal", value: "label:Invoices" }
  ref:       { kind: "ref", path: "trigger.output.from" }
  template:  { kind: "template", value: "Re: {{trigger.output.subject}}" }
  expr:      { kind: "expr", value: "item.priority === 'high'" }

Ref paths MUST start with one of: \`trigger\`, \`steps\`, \`vars\`, \`secrets\`, \`loop\`.
Field names alone (e.g. \`"from"\`, \`"subject"\`) are NOT valid paths — prepend \`trigger.output.\`.
Path grammar: \`[0]\` = an index (never \`.0\`), \`[*]\` = every element, \`["Story Points"]\` = an awkward key, \`[name="Subject"]\` = the entry of a name/value list (mail headers). JSON text is read straight through (\`steps.h.output.body.items[0].id\`). A forEach step's \`results[*]\` entry is \`{index, item, output, status}\`. A wrong path gets a "did you mean" (refused when the output is fully known).
Prefer \`{kind:"ref"}\` over \`{{templates}}\` wherever a binding object is accepted; a \`{{…}}\` template belongs only in fields that ARE template strings (notification title/body, http url/body, approval prompt), one reference each.

Beside \`trigger.output.*\`, every run knows WHICH trigger fired: ${triggerKinds}

Forwarding a mail attachment to Drive? Pass the \`sourceHandle\` returned by \`gmail_read_attachment\` to \`drive_upload_file\` (\`sourceHandle: { kind: "ref", path: "steps.<read>.output.sourceHandle" }\`). NEVER bind raw base64 or the OCR'd \`content\` as the file body.

## Placing steps

\`afterStepId\` = the anchor (default: the last step; in a batch, the previous entry). \`branch\`: "then" | "else" on a condition, "error" = runs only when afterStepId fails. \`splice:true\` inserts between the anchor and its successor instead of beside it. \`forEach:{overRef, itemVar}\` runs the step per item; the item is \`loop.<itemVar>\`. Grow a condition branch by appending with \`afterStepId\` = the condition id (auto-labels "then" first, "else" second); pass \`branch\` to override.${switchRule} A condition decides ONCE for the whole run; to keep the matching items of a list use \`builder_add_array_op({op:"filter"})\` and continue on its \`output.items\`. One row per item of a list inside each item (an attachment with its email's fields) is \`op:"flatten"\` with \`childField\`. Rules: contains(item.subject, "invoice"), equals(item.status, "open"), anyOf(item.attachments[*].filename, "endsWith", ".pdf"); text helpers ignore upper/lower case, never lower()/upper().

${renderTriggerBlockLean()}

${fullMenuSections}${fullMenu ? '' : leanMenuNotice({ codeStepEnabled })}## Naming

Your FIRST reply on a new draft names the automation: \`builder_set_metadata({title, description})\` bundled with \`builder_set_plan\` and \`builder_propose_trigger\`. Title ≤ 60 chars, in the user's language, saying what the automation does; description one sentence. A title stated in the request is used verbatim. An automation that reaches \`builder_finalize\` as "Untitled automation" is a defect.

${planHeading}

In the Plan first work mode the plan is a written plan for the user to review instead; the work-mode note decides. For any multi-step build: call \`builder_set_plan({todos:[{text}]})\` first with a short checklist, then update progress with \`builder_set_plan({markDone:[indices]})\` in the same reply as your next build call — never as its own reply. THE USER WATCHES THIS CHECKLIST TICK OFF LIVE, so a plan that never gets marked done reads as a build that never progressed: every reply that finishes a checklist item must carry its \`markDone\`. The tool hands you back the whole list with each item's index and a \`next\` field — mark what you just finished and work on \`next\`, and never re-derive the plan from the user's message.${delegateHalf}

## Hard rules

- ${codeStepRule}
- NEVER invent tool names. Only use tools listed in the catalog.
- If NO app in the catalog can do the core of what the user asked, say so and stop — name the missing app so they can connect it. Never substitute a different app because it is the closest thing on the list: an automation that quietly does the wrong thing is worse than one that was not built. But when only a DETAIL cannot be met exactly, build the automation anyway with the closest faithful behaviour of the SAME app and state the limitation in one sentence in your summary — do not stop to ask.
- Only add steps the user actually asked for. An extra step nobody requested is a defect, not a bonus.
- Reuse step ids returned by previous tool results for \`afterStepId\`, \`thenStepId\`, etc.
- Side-effect actions (send email, create ticket, post message) are flagged automatically. The dry-run synthesises their output.
- The user's timezone, web-search preference, disabled media and the permitted ai_step \`modelTier\` values are in the "This turn" note right before the user's message — follow it.

${catalogTail}

Begin now.`;
}

/**
 * The per-user context for the small band, rendered into the LATE dynamic
 * message instead of the system prompt (buildLeanSystemPrompt with
 * catalogPlacement:'dynamic'): the app catalog, the datatables and the
 * documents — the same three renderers, the same three-way absent/none/list
 * rendering. It leads the dynamic message so the draft state can stay last.
 * Null when the caller has nothing to say (no catalog at all).
 */
function renderCatalogContextMessage({ catalog } = {}) {
    if (!catalog) return null;
    const apps = renderCatalogSlim(catalog);
    const datatablesBlock = renderDatatablesBlock(catalog.datatables, { canCreate: true, requireChoice: !!catalog?.datatableRequireChoice });
    const documentsBlock = renderDocumentsBlock(catalog.documents);
    return [
        `## Catalog (the ONLY tools you may propose)\n\n${apps || emptyCatalogLine(catalog)}`,
        datatablesBlock || null,
        documentsBlock || null,
    ].filter(Boolean).join('\n\n');
}

/**
 * The id lists the model fills ids from — agents, knowledge bases, the user's
 * own app_event providers — for the late dynamic message of EVERY band.
 *
 * Deliberately not a part of the system prompt, not even for the cloud bands
 * that keep the app catalog there: these lists change when somebody creates or
 * shares an agent, and the system prompt is the front of the prompt cache. In
 * the dynamic message they cost one re-read per turn, like the draft state.
 * Null when the caller built none (no catalog, or a surface that never asked).
 */
function renderPickerContextMessage({ catalog } = {}) {
    const text = renderPickerBlocks(catalog);
    return text || null;
}

module.exports = {
    buildFullSystemPrompt,
    buildLeanSystemPrompt,
    renderPickerContextMessage,
    renderCatalogContextMessage,
    renderDraftStateSystemMessage,
    renderTurnPreferences,
    buildFewShotMessages,
    UNTITLED_AUTOMATION,
    // Reused by the flowlet sub-agent (flowletAgent.js) to render the same
    // app/action catalog its scoped prompt advertises.
    renderCatalog,
    renderCatalogSlim,
    // …and the "Datatables you may use" block, so the flowlet sub-agent
    // sees the same table ids and column keys the main builder does.
    renderDatatablesBlock,
    // …and the "Documents you may fill" block, for the same reason.
    renderDocumentsBlock,
    // …and the agents / knowledge bases blocks, for the same reason.
    renderAgentsBlock,
    renderKnowledgeBasesBlock,
    // Backwards compatibility: callers that still import buildSystemPrompt
    // get the full variant (current behaviour preserved exactly).
    buildSystemPrompt: buildFullSystemPrompt,
};

/**
 * The catalogue the builder prompts render (see builderPrompt/catalogRender.js).
 * @typedef {import('./builderPrompt/catalogRender').PromptCatalog & {
 *   datatables?: import('./builderPrompt/catalogRender').DatatableList|null, datatableRequireChoice?: boolean,
 *   documents?: import('./builderPrompt/catalogRender').DocumentList|null }} BuilderPromptCatalog
 */

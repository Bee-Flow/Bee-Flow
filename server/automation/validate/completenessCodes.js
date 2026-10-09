/**
 * The stage ladder's completeness list: the error codes a half-built flow may
 * legitimately carry, downgraded to warnings at `stage: 'draft'` and blocking
 * at `stage: 'activate'`.
 */

// ── Validation stages: 'draft' vs 'activate' ────────────────────────────────
//
// Every save from the builder PUTs the WHOLE definition (the node inspector
// merges its patch into the full document client-side), so a single incomplete
// node used to block every edit anywhere in the flow — you could not even
// change the trigger's kind while an If node further down still had unwired
// branches (BFSF-323). The dead-branch rule below even says as much: it was
// promoted to an error so the builder "cannot FINALIZE a definitionally broken
// graph" — finalize, not autosave.
//
// These codes are COMPLETENESS problems: a half-built flow legitimately has
// them, and none of them can corrupt data or crash the runner while the
// automation sits inactive. At `stage: 'draft'` they are downgraded to warnings
// (tagged `blockedAt: 'activate'`) so the user keeps building; at the default
// `stage: 'activate'` they block exactly as before, so nothing broken goes live.
//
// Everything NOT listed here is an INTEGRITY problem — bad shape, unknown or
// duplicate ids, dangling edges, cycles, unknown step types, out-of-range
// values, size ceilings — and stays blocking at every stage.
const COMPLETENESS_CODES = new Set([
    // Branches that exist but aren't wired up yet.
    'condition.dead_branch',
    'switch.no_branches',
    // Required fields the user simply hasn't filled in yet. The *_parse codes
    // belong here too: an expression is half-typed for as long as it takes to
    // type it, and autosave fires mid-keystroke.
    'integration_action.tool_missing',
    'integration_action.tool_unknown',
    'integration_action.param_missing',
    // datatable: a half-configured node while the author is still choosing.
    // Note what is deliberately ABSENT — `datatable.sql_field_forbidden`,
    // `datatable.op_unknown` and `datatable.where_op_unknown` are never "not
    // finished typing"; they mean the definition is wrong, and they must block
    // at draft stage too.
    'datatable.table_missing',
    'datatable.op_missing',
    'datatable.values_missing',
    'datatable.match_column_missing',
    // Picking the match column before mapping it is an ordinary half-second of
    // building; shipping it that way is an upsert that only ever appends.
    'datatable.match_column_unmapped',
    'datatable.filter_missing',
    'datatable.where_field_missing',
    'datatable.where_op_missing',
    // knowledge_write: the same two half-configured states, for the same
    // reason — the node is dropped on the canvas before the base is picked and
    // before the text is wired. `knowledge_write.strategy_invalid` is
    // deliberately ABSENT: an unknown near-duplicate strategy is not a field
    // somebody has not finished typing, it is a value nothing implements.
    'knowledge_write.kb_required',
    'knowledge_write.content_required',
    'ai_step.prompt_missing',
    // Stored automations carry ai_steps without an outputSchema whose fields a
    // fan-out reads — the builder agent often forgot it (execAi.js's
    // inferred-schema safety net exists for that) and they validated green
    // until the rule landed. Same reasoning as `approval.nested_forbidden`:
    // blocking at draft would strand them (a label edit on any node PUTs the
    // whole definition and got 400 'Invalid definition') — warn at draft,
    // block activation.
    'ai_step.output_schema_missing',
    // R2 — an ai_step whose agent this install cannot serve. Completeness,
    // not integrity, and for two reasons at once: an IMPORTED automation arrives
    // carrying an agent id from wherever it was built, and an agent that was
    // deleted or unpublished after the automation was saved turns an automation
    // somebody is still editing un-saveable. Both must stay openable and
    // fixable in the builder; neither may go live. The run-time check
    // (aiStepAgent's resolveStepAgent) is what actually stops a step running
    // without the agent it names — see the R2 block in stepRules.js.
    'ai_step.agent_unavailable',
    // Only a raw PUT or an import can store an unreadable permissions object
    // (the builders rebuild it from three known booleans), so such an automation
    // must stay saveable rather than stranded. It cannot activate: an
    // unreadable permission is read as OFF everywhere, and going live with
    // silently-off permissions is exactly the surprise this warns about.
    'ai_step.agent_permissions_invalid',
    // agent_call: a tool name or an argument name the canvas editor never
    // checked, so a stored automation may carry one and must stay saveable (a
    // label edit PUTs the whole definition); neither can go live. The
    // description codes are plain warnings (validate/graph.js), not listed here:
    // the runtime falls back on the automation's description or title. The
    // other shape codes (parameters_shape, properties_shape, required_shape,
    // required_unknown, param_type) are deliberately ABSENT: the editor cannot
    // write them.
    'agent_call.tool_name',
    'agent_call.param_name',
    'condition.expr_missing',
    'condition.expr_parse',
    'switch.expr_missing',
    'switch.expr_parse',
    'switch.case_expr_parse',
    'switch.cases_missing',
    // "is about" rules (stepRules/topicRules.js). An automation that uses them on
    // an install without a topic classifier is unfinished, not broken: it can
    // be saved while the admin installs classify-service, and cannot go live
    // until then. Too many topics is an author still adding outputs.
    'route.topic_classifier_missing',
    'route.topic_labels_too_many',
    'filter.expr_missing',
    'filter.expr_parse',
    'loop.itemVar_missing',
    'loop.overRef_missing',
    'loop.body_missing',
    'foreach.overRef_missing',
    'foreach.itemVar_missing',
    'parallel.branches_missing',
    'code.code_missing',
    'code.safety_blocked',       // the code has a BLOCK finding or a syntax error (codeSafety): the draft saves, activation refuses
    'notification.empty',
    'http_request.url_missing',
    'form_page.incomplete',
    // A download button dropped on the canvas before its document step is
    // wired: incomplete, not wrong.
    'form_page.field_download_no_file',
    'generate_document.content_missing',
    // The two presentation nodes land empty from the palette and are wired
    // over the next few autosaves: not finished, not wrong.
    'slide.content_missing',
    'slide.chart_data_missing',
    'presentation.slides_missing',
    // The node is dropped on the canvas before a document is picked: not
    // finished, not wrong. A value bound to a placeholder nobody has is a
    // warning either way, so it is not listed here.
    'fill_document.document_missing',
    // data_extraction: the node is dropped with an empty source and ONE blank
    // field row, and both are filled over the next few autosaves. What is
    // deliberately ABSENT — `field_name_invalid`, `field_type_invalid`,
    // `fields_duplicate`, `fields_too_many`, `source_invalid`,
    // `instructions_too_long` — is never "not finished typing": a name that
    // cannot be an output key or a type nothing implements is wrong, and
    // must block at draft stage too.
    'data_extraction.source_missing',
    'data_extraction.fields_missing',
    'stop_error.message_missing',
    // `return_to_app`: half ingevuld is halverwege bouwen. Het VOCABULAIRE
    // (tone/refresh/onError) staat er bewust NIET bij — dat reist als data naar
    // de app-runtime en is nooit "nog niet klaar met typen", maar gewoon fout.
    'return_to_app.empty',
    'return_to_app.screen_missing',
    // Een rand die uit een terminale stap vertrekt. Ontstaat vooral bij het
    // OMBOUWEN van een stap die al bedraad was — dat is een tussenstand, geen
    // kapotte definitie, dus waarschuwen tijdens het bouwen en blokkeren bij
    // activeren. (`edge.after_stop_error` is en blijft een waarschuwing op elke
    // trap: die regel kwam ná de stappen die hem overtreden.)
    'edge.after_terminal',
    'limit.count_missing',
    'datetime.op_missing',
    'datetime.format_missing',
    'datetime.amount_missing',
    'parse_json.no_fields',
    'parse_json.field_description_missing',
    'layer.no_output',
    'call_layer.layerKey_missing',
    'call_layer.param_missing',
    'call_block.blockId_missing',
    'call_block.param_missing',
    // Bindings pointing at a step that isn't in place yet, or is no longer —
    // automation while reordering or rebuilding part of a flow.
    'ref.unknown_step',
    'ref.forward',
    // A loop.<var> read by a step that does not (yet) iterate as <var> — the
    // forEach is usually the next thing the author adds.
    'ref.loop_unbound',
    // Collection ops: the source list / field being blank is the normal state
    // while the user is (re)picking it — blocking here 400'd every save of
    // the whole automation the moment a "Source list" input was cleared (C1/C2).
    'filter.arrayRef_missing',
    'switch.arrayRef_missing',
    'limit.arrayRef_missing',
    'dedupe.arrayRef_missing',
    'aggregate.arrayRef_missing',
    'summarize.arrayRef_missing',
    // Flatten: no list yet, or a list without the inner level picked.
    'flatten.arrayRef_missing',
    'flatten.level_missing',
    'aggregate.field_missing',
    'summarize.field_missing',
    // Date & time list mode: same story — the source list is blank for as long
    // as it takes to pick one, and the inspector autosaves throughout.
    'datetime.arrayRef_missing',
    // "Edit data" (set) list mode: blank source and half-configured table
    // operations are the normal state while the user is building them —
    // the form autosaves mid-edit, exactly like the collection ops above.
    'set.arrayRef_missing',
    'set.field_expr_parse',
    'set.op_target_missing',
    'set.op_keys_missing',
    'set.op_rename_incomplete',
    'set.op_sort_key_missing',
    // An app_event trigger without provider/event can never fire — but a
    // freshly-dropped trigger node has no appEvent at all, so it must stay
    // draft-saveable (C6).
    'trigger.app_event_incomplete',
    // Same story for a form trigger: dropping the node gives you an empty
    // form, and you fill it in over the next few autosaves. It must not be
    // publishable that way, so it blocks at activation instead.
    'form.incomplete',
    // …and for a schedule trigger: the palette drops a bare `{kind:'schedule'}`
    // node and the canvas PUTs the definition immediately, long before the
    // inspector is opened (crud.js's scheduleWasConfigured exists for exactly
    // that). The cron itself is typed a character at a time, so a half-typed
    // "0 0 * *" is the normal state mid-keystroke — both are completeness, not
    // integrity. Activation blocks: a schedule trigger with no usable cron is
    // how an automation goes live with a null schedule_cron and a past
    // next_run_at, which claimDueAutomations then re-fires every tick forever.
    'trigger.schedule_missing',
    'trigger.schedule_cron_invalid',
    'trigger.schedule_never_fires',
    // Same treatment for a timezone Intl does not know ("Amsterdam" rather than
    // "Europe/Amsterdam" is a plausible AI-authored value): the automation must
    // stay openable and fixable in the builder, it just cannot go live.
    'trigger.schedule_tz_invalid',
    // An approval nested in a loop/parallel body pauses at run time and can
    // never be approved. Existing stored automations may already carry one (this
    // validated green until now), so blocking at draft would strand them —
    // warn at draft, block activation. (form_page.nested_forbidden is
    // deliberately NOT listed: it has always blocked at both stages.)
    'approval.nested_forbidden',
    // `return_to_app.nested_forbidden` staat hier BEWUST NIET, en dat is een
    // ander geval dan de approval erboven: die stapsoort bestond al voordat de
    // regel er was, dus er lagen automatiseringen die groen waren opgeslagen. De
    // eindstap is met P4 zelf geïntroduceerd — er is geen opgeslagen automatisering
    // van vóór de regel — en hij krijgt dezelfde behandeling als zijn eigen
    // tweelingregel `layer.return_to_app_forbidden`: blokkeren op draft én op
    // activate. Zo hoort de auteur het bij de eerste autosave in plaats van
    // pas bij het live zetten.
    // A freshly dropped approval has no question yet — there is no honest
    // default for "what am I asking?", so the node is seeded blank on purpose
    // (DiagramPane.buildStepFromPayload). Autosave must therefore go amber,
    // not red, and activation must still be blocked: an approval with no
    // question reaches a real person as "Approval requested" and nothing else.
    'approval.prompt_missing',
    // Same treatment for forEach: only reachable via raw API/AI authoring
    // (PATCHABLE_FIELDS.approval omits it), so stored definitions that already
    // carry one must stay openable and fixable rather than un-saveable.
    'approval.forEach_forbidden',
    // A notification step whose channels contain nothing the runner supports
    // throws at run time. Only reachable via raw API/AI authoring — the step
    // form writes known channels — so existing definitions must stay saveable.
    'notification.channels_unsupported',
    // parse_json nested in a body/branch needs an explicit source (the
    // "previous step" default always throws there) — completeness, because
    // the node starts without one (C5).
    'parse_json.source_required_here',
    // An unlabelled edge out of a condition/switch never fires at run time.
    // Existing saved drafts may carry them (JSON/AI authoring), so draft
    // saves keep working; activation blocks until it's redrawn from a branch
    // port (B5).
    'edge.branch_unlabelled',
    // Nested step ids clobber runState.steps on collision. Blocking at draft
    // would strand existing automations that already carry a collision — warn
    // at draft, block activation (C3/C4).
    'loop.body_item_id_duplicate',
    // datetime with an unresolvable input now fails loudly at run time; the
    // missing-input config itself is a completeness problem (A17).
    'datetime.input_missing',
    'datetime.input2_missing',
    // Reserved (__proto__/constructor/prototype) field names silently vanish
    // from the step output at run time. Only reachable via raw API/import —
    // the form refuses them — so existing drafts must stay saveable (C17).
    'set.field_name_reserved',
    'layer_output.field_name_reserved',
]);

module.exports = { COMPLETENESS_CODES };

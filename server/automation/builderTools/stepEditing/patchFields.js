// @typecheck strict
/**
 * builder_update_step — which fields a patch may name, per step type, and the
 * key lists the update path treats specially (position/wiring keys, text
 * fields with placeholders, the flatten plan keys, the route-shape keys).
 * Data only; normalizePatchField.js turns a patched value into its stored
 * shape. Moved verbatim out of stepEditing.js.
 */

// A flatten's route and column plan: re-planned together, never merged key by key.
const FLATTEN_PLANNED_KEYS = ['arrayRef', 'parents', 'childField', 'keepFields'];

// Step fields that hold TEXT with {{…}} placeholders the run interpolates —
// patched through the same placeholder check the add tools use.
const TEXT_TEMPLATE_FIELDS = Object.freeze({
    ai_step: ['prompt'],
    notification: ['title', 'body'],
    http_request: ['url', 'body'],
});

// Position and wiring keys handled by applyUpdateStep BEFORE the per-type
// allow-list: they change edges, not the step's own fields.
const MOVE_KEYS = ['afterStepId', 'branch', 'caseName'];
const WIRE_KEYS = ['thenStepId', 'elseStepId'];

// Per-type allow-list of fields a builder_update_step patch may change. `inputs`
// / `fields` / `forEach` get special merge+revalidate handling; everything else
// is copied through normalizePatchField (which mirrors the apply* clamps).
// `askOnce` is integration_action, http_request and ai_step ONLY: those are the
// steps that consult ctx._toolMemo (execIntegrationAction, execHttpRequest via
// httpCache.js, and the AI step via aiStepCache.js), so accepting it anywhere
// else would let the builder agent set a field the runtime never reads.
const PATCHABLE_FIELDS = {
    integration_action: ['tool', 'inputs', 'label', 'forEach', 'askOnce'],
    // `agentId` is FILL-ONLY, for the reason `datatableId` and
    // `knowledgeBaseId` are (see their entries below) and one of its own:
    // which agent a step runs on is exactly what the save-time and run-time
    // checks look at, and a patch is the one path that could change it without
    // the step being rebuilt. `skillIds` and `agentPermissions` ARE ordinary
    // patches — they narrow or widen what the step hands the agent it is
    // already bound to, and both are rebuilt wholesale below rather than
    // merged.
    ai_step: ['prompt', 'systemPrompt', 'inputs', 'outputSchema', 'modelTier', 'allowTools', 'tools', 'knowledgeBaseIds', 'useMemory', 'label', 'forEach', 'agentId', 'skillIds', 'agentPermissions', 'disabledAgentSkillIds', 'temperature', 'enumFrom', 'checks', 'fallback', 'askOnce'],
    condition: ['expr', 'label'],
    // A switch that works through a list (A2): its list, whether one item may
    // go down several outputs, and the input cap — all three the add path keeps.
    switch: ['expr', 'cases', 'defaultBranch', 'label', 'arrayRef', 'matchMode', 'maxItems'],
    loop: ['overRef', 'itemVar', 'maxIterations', 'label'],   // body steps are edited by their own id
    // `limits` is patchable for the reason it became settable on the add path:
    // the sandbox clamps memoryMb/cpuMs/wallMs/httpBudget on every run, and
    // until now nothing outside that clamp could name them — not the AI tool
    // schema, not the validator, not a patch. A ceiling the engine honours
    // that no author can move is not a permission model. The clamp is still
    // the authority; this only lets a step ask, within it.
    code: ['code', 'inputs', 'outputSchema', 'allowedTools', 'limits', 'label', 'forEach'],
    notification: ['title', 'body', 'channels', 'label', 'forEach'],
    http_request: ['url', 'method', 'headers', 'body', 'query', 'timeoutMs', 'blockPrivateTargets', 'parseResponse', 'label', 'forEach', 'askOnce', 'cacheInto'],
    generate_document: ['content', 'contentFormat', 'format', 'title', 'fileName', 'expiresInDays', 'label'],
    // `values` is the placeholder map, replaced wholesale like data_extraction's
    // `fields`: a merge would leave a value bound to a placeholder the person
    // has since deleted from the document, which then prints nothing and
    // explains nothing. `documentId` re-points the step at another design.
    fill_document: ['documentVersionId', 'sectionOverrides', 'documentId', 'documentName', 'values', 'fileName', 'format', 'saveCopy', 'copyName', 'expiresInDays', 'label'],
    slide: ['title', 'content', 'notes', 'layout', 'image', 'chart', 'stats', 'style', 'label', 'forEach'],
    // `slides` is replaced wholesale (a string or a list), like fill_document's
    // `values`: merging a list of references would keep a slide the person
    // has since removed.
    presentation: ['title', 'subtitle', 'slides', 'fileName', 'format', 'houseStyle', 'preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logo', 'logoPlacement', 'footerText', 'slideNumbers', 'template', 'saveCopy', 'copyName', 'expiresInDays', 'label'],
    // `fields` here is the ARRAY of {name,type,description,required} rows —
    // the output shape — replaced wholesale through the add path's sanitizer
    // (see the data_extraction block in applyUpdateStep), never merged. There
    // is no model to patch: the step runs on the admin's extraction model.
    data_extraction: ['source', 'fields', 'instructions', 'label', 'forEach'],
    set: ['fields', 'label', 'forEach', 'arrayRef', 'operations', 'maxItems'],
    parse_json: ['sourceRef', 'itemsRef', 'mode', 'fields', 'label'],
    datetime: ['op', 'input', 'input2', 'amount', 'format', 'part', 'unit', 'arrayRef', 'target', 'timezone', 'epochUnit', 'label'],
    wait: ['seconds', 'label'],
    // `forEach` is deliberately absent (unlike notification/ai_step): an
    // approval that runs once per item pauses on the first one and the rest
    // never run. validate.js reports it; leaving it unpatchable means the
    // model cannot introduce it in the first place.
    approval: ['prompt', 'approval', 'label'],
    stop_error: ['message', 'label'],
    // `when` is the page condition (an expression); the page is skipped when it is not met.
    form_page: ['mode', 'form', 'waitSeconds', 'when', 'label'],
    filter: ['arrayRef', 'expr', 'label', 'maxItems'],
    limit: ['arrayRef', 'count', 'mode', 'label'],
    dedupe: ['arrayRef', 'keyField', 'label'],
    aggregate: ['arrayRef', 'field', 'label'],
    summarize: ['arrayRef', 'field', 'op', 'label'],
    // childField and keepFields are the add tool's sugar: they re-plan the
    // columns (flattenStep.patchFlatten) and are never stored.
    flatten: ['arrayRef', 'parents', 'keepEmpty', 'maxItems', 'label', 'childField', 'keepFields'],
    call_layer: ['inputs', 'label'],   // layerKey change = builder_replace_step (recursion guard re-runs)
    // `datatableId` is patchable ONLY onto a step that has none — see the
    // fill-only guard in applyUpdateStep. Repointing a BOUND step at a
    // different table is still not an edit (it changes which organisation's
    // data the automation writes to) and still goes through builder_replace_step
    // or a person; but an imported automation arrives with the id blanked on
    // purpose, and refusing the patch outright left the assistant unable to
    // repair the one thing it is best placed to repair.
    datatable: ['op', 'where', 'match', 'values', 'matchColumn', 'sort', 'limit', 'cursor', 'label', 'forEach', 'datatableId', 'datatableKey'],
    // `knowledgeBaseId` is FILL-ONLY for the same reason `datatableId` is, and
    // one more: repointing a write at a different base is the act the save-time
    // permission check exists to see. A patch that changed it would slip past
    // `builder_replace_step`, which is where a re-pointed step goes to be
    // rebuilt and re-checked.
    knowledge_write: ['content', 'title', 'sourceUri', 'nearDuplicateStrategy', 'label', 'forEach', 'knowledgeBaseId'],
    // A canvas annotation (BFSF-411) — no `forEach`/bindings, so it needs none
    // of the merge/revalidate machinery the other types get; normalizePatchField
    // below clamps text/size the same way applyAddNote does.
    note: ['text', 'position', 'size', 'color', 'label'],
    // The Privacy Shield steps. `onFound` is rebuilt from its three known switches
    // (normalizePatchField), never merged: an invented key would persist as a
    // setting that looks configured and does nothing.
    guard: ['sourceRef', 'categories', 'confidence', 'onFound', 'label'],
    tokenize: ['sourceRef', 'categories', 'confidence', 'label'],
    untokenize: ['sourceRef', 'label'],
    // The table steps. `source` is checked against the draft and `ops` replaced
    // wholesale and re-normalised (patchGuards/tables.js); the other settings
    // are normalised field by field (normalizePatchField).
    read_table: ['source', 'sheets', 'headerRow', 'provenanceSheet', 'format', 'delimiter', 'skipHiddenSheets', 'expiresInDays', 'label', 'forEach'],
    table: ['source', 'ops', 'name', 'expiresInDays', 'label', 'forEach'],
};

// The fields of a filter/switch whose change moves its outputs (and so what
// the steps after it must read): its outputs, its list.
const ROUTE_SHAPE_KEYS = ['cases', 'arrayRef'];

module.exports = {
    FLATTEN_PLANNED_KEYS,
    TEXT_TEMPLATE_FIELDS,
    MOVE_KEYS,
    WIRE_KEYS,
    PATCHABLE_FIELDS,
    ROUTE_SHAPE_KEYS,
};

/**
 * Builder tools — §A in-place editing: builder_update_step(s) patching with
 * the per-type field allow-list, builder_replace_step type swaps and
 * builder_remove_step with edge reconnection. Reuses the add-path sanitizers
 * so a patched step is byte-identical to a freshly-added one. Required from
 * within automation/builderTools/ and the ../builderTools facade.
 */

const crypto = require('crypto');
const { isSideEffect } = require('../sideEffectMap');
const {
    BRANCHING_TYPES, listStepIds, findStepAnywhere, reconcileOutgoingEdges, moveStepAfter,
} = require('./draftGraph');
const { validateAndFixBindings, sanitizeForEach, checkTextPlaceholders, checkLoopBindings, sanitizeArrayRef } = require('./bindings');
const { inspectGateError } = require('./inspection');
const { checkLoopRef } = require('./outputFields');
const { normalizeApprovalConfig } = require('./approval');
const {
    modelTierGateError, clampDocumentTtl, sanitizeSetOperations,
    sanitizeParseJsonFieldRows, sanitizeDatatableBindings, normalizeAskOnce,
    normalizeCacheInto,
    resolveDatatableColumns, checkExtractionFieldRefs, readOnlyTableError, DATATABLE_WRITE_OPS, sanitizeDatatableCursor,
    PARSE_JSON_RETIRED_MSG, ADD_FOR_TYPE, bindingToTemplate,
    sanitizeDataExtractionFields, sanitizeDataExtractionSource, translateDataExtractionVocabulary,
    loopItemSourceError,
    NOTE_MAX_TEXT_LENGTH, NOTE_COLOR_KEYS, sanitizeNoteSize,
    sanitizeAgentId, sanitizeSkillIds, sanitizeAgentPermissions, sanitizeDisabledAgentSkillIds, agentPermissionsBlock, unknownToolError,
    sanitizeSwitchCases,
} = require('./stepBuilders');
const { KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS } = require('../validate/constants');
const {
    translateDatatableVocabulary, resolveDatatableOp, resolveDatatableRef, mapColumnKeys,
} = require('./datatableRefs');

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
// `askOnce` is integration_action and http_request ONLY: execIntegrationAction
// and execHttpRequest (via httpCache.js) are the only readers of ctx._toolMemo,
// so accepting it on an ai_step would let the builder agent set a field the
// runtime never consults.
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
    ai_step: ['prompt', 'systemPrompt', 'inputs', 'outputSchema', 'modelTier', 'allowTools', 'tools', 'knowledgeBaseIds', 'useMemory', 'label', 'forEach', 'agentId', 'skillIds', 'agentPermissions', 'disabledAgentSkillIds'],
    condition: ['expr', 'label'],
    switch: ['expr', 'cases', 'defaultBranch', 'label'],
    loop: ['overRef', 'itemVar', 'maxIterations', 'label'],   // body steps are edited by their own id
    // `limits` is patchable for the reason it became settable on the add path:
    // the sandbox clamps memoryMb/cpuMs/wallMs/httpBudget on every run, and
    // until now nothing outside that clamp could name them — not the AI tool
    // schema, not the validator, not a patch. A ceiling the engine honours
    // that no author can move is not a permission model. The clamp is still
    // the authority; this only lets a step ask, within it.
    code: ['code', 'inputs', 'outputSchema', 'allowedTools', 'limits', 'label', 'forEach'],
    notification: ['title', 'body', 'channels', 'label', 'forEach'],
    http_request: ['url', 'method', 'headers', 'body', 'timeoutMs', 'blockPrivateTargets', 'parseResponse', 'label', 'forEach', 'askOnce', 'cacheInto'],
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
    datetime: ['op', 'input', 'input2', 'amount', 'format', 'part', 'unit', 'arrayRef', 'target', 'label'],
    wait: ['seconds', 'label'],
    // `forEach` is deliberately absent (unlike notification/ai_step): an
    // approval that runs once per item pauses on the first one and the rest
    // never run. validate.js reports it; leaving it unpatchable means the
    // model cannot introduce it in the first place.
    approval: ['prompt', 'approval', 'label'],
    stop_error: ['message', 'label'],
    form_page: ['mode', 'form', 'waitSeconds', 'label'],
    filter: ['arrayRef', 'expr', 'label'],
    limit: ['arrayRef', 'count', 'mode', 'label'],
    dedupe: ['arrayRef', 'keyField', 'label'],
    aggregate: ['arrayRef', 'field', 'label'],
    summarize: ['arrayRef', 'field', 'op', 'label'],
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
};

/**
 * Normalize a scalar/structured patch field to the exact shape the matching
 * apply* builder would produce, so a patched step is byte-identical to a
 * freshly-added one. Returns `undefined` to mean "clear this optional field"
 * (the caller keeps an existing label instead of clearing it).
 */
function normalizePatchField(type, key, value) {
    if (key === 'label') return (typeof value === 'string' && value.trim()) ? value : undefined;
    if (type === 'ai_step') {
        if (key === 'systemPrompt') return (typeof value === 'string' && value.trim()) ? value.trim() : null;
        if (key === 'modelTier') return value || 'auto';
        if (key === 'allowTools') return !!value;
        if (key === 'tools') return Array.isArray(value) ? value.filter(t => typeof t === 'string') : null;
        if (key === 'outputSchema') return value || null;
        // Always an explicit array (never absent), same reasoning as the
        // add-path builder: mirrors App Studio's knowledgeBaseIds shape and
        // means the runner never has to distinguish "not set" from "cleared".
        if (key === 'knowledgeBaseIds') return Array.isArray(value) ? value.filter(id => typeof id === 'string' && id).slice(0, 10) : [];
        // R2 — the same three clamps the add path uses, so a patched step is
        // byte-identical to a freshly built one. `agentPermissions` is REBUILT
        // from its three known names and never merged: a patch of
        // `{useTools:true}` merged into the stored object would leave the other
        // two `undefined`, and an `undefined` a reader treats as "not false" is
        // exactly how a missing key comes to mean everything.
        if (key === 'agentId') return sanitizeAgentId(value);
        if (key === 'skillIds') return sanitizeSkillIds(value);
        if (key === 'agentPermissions') return sanitizeAgentPermissions(value);
        // Handoff 5: the agent's skills this step switches off, replaced
        // wholesale (send the full list).
        if (key === 'disabledAgentSkillIds') return sanitizeDisabledAgentSkillIds(value);
    }
    if (type === 'code') {
        if (key === 'outputSchema') return value || null;
        if (key === 'allowedTools') return Array.isArray(value) ? value : [];
        if (key === 'limits') {
            // The add path's sanitizer, so a patched step is byte-identical to
            // a freshly-added one: all four keys present, the ones the patch
            // does not name filled from the sandbox's own defaults.
            //
            // REBUILT, NEVER MERGED into what the step already has — the
            // discipline `approval`, `askOnce`, `cacheInto` and
            // `agentPermissions` all get, though the reason here is a
            // different one. It is not that a model invents keys (unknown keys
            // are refused outright); it is that normalizePatchField only ever
            // sees the VALUE, never the step, so a merge is not something this
            // seam could do honestly. That is survivable precisely because the
            // add path writes all four keys out: a partial block is always the
            // model's own invention, never a shape the builder produced, and
            // re-stating the whole block is the obvious fix.
            //
            // There is also no error channel here (the function returns a
            // value, and `undefined` already means "clear this field"), so an
            // unusable block is passed through UNCHANGED rather than quietly
            // repaired. validateDefinition runs on every builder save
            // (persistDraft) and refuses it there with code.limits_out_of_range
            // / code.limits_not_a_number, naming the real ceiling. Repairing it
            // here would hand the author a number they never asked for — the
            // exact failure this whole change exists to end.
            const { sanitizeCodeLimits } = require('./stepBuilders/dataSteps');
            const r = sanitizeCodeLimits(value);
            return r.error ? value : r.limits;
        }
    }
    if (type === 'notification' && key === 'channels') return Array.isArray(value) ? value : ['notification'];
    if (type === 'form_page') {
        if (key === 'mode') return value === 'ending' ? 'ending' : 'input';
        if (key === 'form') return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
        if (key === 'waitSeconds') return Math.max(60, Math.min(7 * 24 * 3600, Math.round(Number(value) || 3600)));
    }
    if (type === 'http_request') {
        if (key === 'method') return String(value || 'GET').toUpperCase();
        if (key === 'headers') return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
        if (key === 'body') return typeof value === 'string' ? value : '';
        if (key === 'timeoutMs') return Math.max(1000, Math.min(60000, Number(value) || 10000));
        if (key === 'blockPrivateTargets') return value === false ? false : true;
        // Anything unrecognised means 'auto' — the executor falls back the same
        // way, so a typo never silently disables parsing.
        if (key === 'parseResponse') return ['never', 'always'].includes(value) ? value : 'auto';
    }
    if (type === 'generate_document') {
        // Same coercions applyAddGenerateDocument uses, so a patched step is
        // byte-identical to a freshly added one and the clamps match validate.js.
        if (key === 'format') return value === 'docx' ? 'docx' : 'pdf';
        if (key === 'contentFormat') return value === 'html' ? 'html' : 'markdown';
        if (key === 'expiresInDays') return clampDocumentTtl(Number.isFinite(Number(value)) ? value : 7);
        if (key === 'content' || key === 'title' || key === 'fileName') return typeof value === 'string' ? value : '';
    }
    if (type === 'slide') {
        // Same coercions applyAddSlide uses. 'auto' / anything unknown clears
        // the layout, which the executor reads as "pick one from the content".
        if (key === 'layout') return ['title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing'].includes(value) ? value : undefined;
        if (key === 'title' || key === 'content' || key === 'notes') return typeof value === 'string' ? value : '';
        if (key === 'image') return typeof value === 'string' && value.trim() ? value.trim() : undefined;
        // The visuals: the add path's sanitizer, so a patched step equals an
        // added one; an empty value clears the visual.
        if (key === 'chart' || key === 'stats' || key === 'style') {
            const { slideVisualFields } = require('./stepBuilders');
            return slideVisualFields({ [key]: value })[key];
        }
    }
    if (type === 'presentation') {
        // Same coercions applyAddPresentation uses.
        if (key === 'format') return value === 'pdf' ? 'pdf' : 'pptx';
        if (key === 'houseStyle') return value !== false;
        if (key === 'expiresInDays') return clampDocumentTtl(Number.isFinite(Number(value)) ? value : 7);
        if (key === 'title' || key === 'subtitle' || key === 'fileName') return typeof value === 'string' ? value : '';
        // The look fields: a valid value or ABSENT (never ''), so the house
        // style decides again when a person clears one.
        if (['preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logo', 'logoPlacement', 'footerText', 'slideNumbers', 'template'].includes(key)) {
            const { deckLookFields } = require('./stepBuilders');
            if (key === 'logo' && typeof value === 'string' && /^(none|off|false|no|geen)$/i.test(value.trim())) return 'none';
            return deckLookFields({ [key]: value })[key];
        }
        if (key === 'slides') {
            if (typeof value === 'string' || Array.isArray(value)) return value;
            if (value && typeof value === 'object' && value.kind) return bindingToTemplate(value);
            return '';
        }
    }
    if (type === 'fill_document') {
        // Same coercions applyAddFillDocument uses, so a patched step is
        // byte-identical to a freshly added one.
        if (key === 'expiresInDays') return clampDocumentTtl(Number.isFinite(Number(value)) ? value : 7);
        if (key === 'saveCopy') return value === true;
        if (key === 'documentId' || key === 'documentName' || key === 'fileName' || key === 'copyName') return typeof value === 'string' ? value : '';
        if (key === 'values') return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    }
    if (type === 'data_extraction' && key === 'instructions') {
        // Same trim-and-cap applyAddDataExtraction applies; blank clears it.
        const t = typeof value === 'string' ? value.trim().slice(0, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS) : '';
        return t || undefined;
    }
    if (type === 'switch') {
        // Shared with applyAddSwitch so a patched switch is byte-identical to
        // a freshly added one — and so `expr` survives. Rebuilding a case as
        // `{name, value}` here used to erase the per-case rule the canvas
        // editor writes; see sanitizeSwitchCases for the full note.
        if (key === 'cases') return sanitizeSwitchCases(value);
        if (key === 'defaultBranch') return typeof value === 'string' ? value : null;
    }
    // Rebuilt, never merged — the same discipline `approval` gets, and for the
    // same reason: a model reaching for this invents `ttl`, `cacheSeconds`,
    // `scope`. The runtime reads none of them, so passing the object through
    // would persist a field that LOOKS configured and does nothing.
    if ((type === 'integration_action' || type === 'http_request') && key === 'askOnce') return normalizeAskOnce(value);
    // Rebuilt, never merged, for the same reason: a model reaching for this
    // invents `enabled`, `ttlDays`, `table`. The runtime reads none of them, so
    // a merge would persist a field that LOOKS configured and does nothing.
    if (type === 'http_request' && key === 'cacheInto') return normalizeCacheInto(value);
    if (type === 'parse_json') {
        if (key === 'sourceRef' || key === 'itemsRef') return typeof value === 'string' ? value : '';
        if (key === 'mode') return value === 'ai' ? 'ai' : 'paths';
    }
    if (type === 'set') {
        // arrayRef: a string keeps/enters list mode ('' = list mode, source
        // not picked yet); null/anything else CLEARS the key → single mode.
        if (key === 'arrayRef') return typeof value === 'string' ? value.trim() : undefined;
        if (key === 'maxItems') return (typeof value === 'number' && Number.isInteger(value) && value > 0) ? value : undefined;
    }
    if (type === 'loop' && key === 'maxIterations') return value || 100;
    if (type === 'wait' && key === 'seconds') return Math.max(1, Math.min(86400, Number(value) || 1));
    // Rebuilt, never merged: a model reaching for an approval routinely
    // invents `assignee` / `approvers` / `reminderHours`. The engine reads
    // none of them, so merging would persist a field that looks configured
    // and does nothing — the worst outcome for a step a person relies on.
    if (type === 'approval' && key === 'approval') {
        return normalizeApprovalConfig(value);
    }
    if (type === 'limit') {
        if (key === 'count') return Math.max(0, Math.floor(Number(value) || 0));
        if (key === 'mode') return value === 'last' ? 'last' : 'first';
    }
    if (type === 'datatable' && (key === 'datatableId' || key === 'datatableKey')) {
        return typeof value === 'string' ? value.trim() : undefined;
    }
    if (type === 'knowledge_write') {
        // The same flattening applyAddKnowledgeWrite does, so a patched step is
        // byte-identical to a freshly-added one — a model that hands over a
        // binding object gets it turned back into the `{{…}}` string the
        // editor and the runner both read.
        if (key === 'content' || key === 'title' || key === 'sourceUri') return bindingToTemplate(value);
        if (key === 'knowledgeBaseId') return typeof value === 'string' ? value.trim() : undefined;
        if (key === 'nearDuplicateStrategy') {
            return KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES.includes(value) && value !== 'skip' ? value : undefined;
        }
    }
    if (type === 'dedupe' && key === 'keyField') return typeof value === 'string' ? value : undefined;
    if (type === 'note') {
        // Same clamps applyAddNote uses, so a patched note is byte-identical
        // to a freshly-added one — text/size never land oversized, an unknown
        // colour is simply dropped rather than persisting a value the canvas
        // would fall back on anyway.
        if (key === 'text') return typeof value === 'string' ? value.slice(0, NOTE_MAX_TEXT_LENGTH) : '';
        if (key === 'position') {
            return (value && typeof value === 'object' && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)))
                ? { x: Number(value.x), y: Number(value.y) } : undefined;
        }
        if (key === 'size') return sanitizeNoteSize(value);
        if (key === 'color') return (typeof value === 'string' && NOTE_COLOR_KEYS.has(value)) ? value : undefined;
    }
    if (type === 'datetime') {
        if (['input', 'input2', 'format', 'part', 'unit', 'target'].includes(key)) return typeof value === 'string' ? value : undefined;
        // '' is meaningful for arrayRef: list mode with the source not picked yet.
        if (key === 'arrayRef') return typeof value === 'string' ? value : undefined;
        if (key === 'amount') return typeof value === 'number' ? value : undefined;
    }
    return value;
}

/**
 * builder_update_step — patch an existing step in place (same type, same id,
 * wiring preserved). Reuses validateAndFixBindings / sanitizeForEach so the
 * patched step is identical to a freshly-added one.
 */
function applyUpdateStep(graph, args, draftWrap) {
    const stepId = typeof args.stepId === 'string' ? args.stepId : null;
    if (!stepId) return { error: 'stepId is required.' };
    let patch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
    if (!patch) return { error: 'patch must be an object of fields to change.' };
    if ('type' in patch) return { error: 'Cannot change a step\'s type via builder_update_step — use builder_replace_step.' };
    if ('id' in patch) return { error: 'Cannot change a step id.' };

    let found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` };
    let step = found.step;
    if (step.type === 'fill_document' && ['documentId','documentVersionId','values','sectionOverrides'].some(k=>k in patch)) {
        const candidate = {...step,...patch};
        const issue = require('../../core/documents/documentDiscovery').inspectBindings(candidate,draftWrap,'builder');
        if (issue) return issue;
        patch = {...patch,documentVersionId:candidate.documentVersionId};
    }


    // ── Position and branch wiring (2026-09-11) ──
    // A step's PLACE is patchable too. Measured builds thrashed for 10-14
    // rounds because the model's first, correct instinct — `{afterStepId}` on
    // a misplaced loop, `{elseStepId}` on a half-wired condition — was refused
    // here as "not patchable", and the only route left was remove + re-add,
    // which mints a new id and lands at the tail again. `moveStepAfter` keeps
    // the id and re-joins the chain the step leaves; see its header.
    const moved = [];
    if (MOVE_KEYS.some(k => k in patch) || WIRE_KEYS.some(k => k in patch)) {
        if ('afterStepId' in patch) {
            const r = moveStepAfter(graph, stepId, { afterStepId: patch.afterStepId, branch: patch.branch, caseName: patch.caseName });
            if (r.error) return { error: r.error };
            moved.push(r.now + (r.note ? ` — ${r.note}` : ''));
        } else if ('branch' in patch || 'caseName' in patch) {
            return { error: 'branch/caseName say WHERE a moved step goes — pass afterStepId with them: patch:{afterStepId:"<condition or switch id>", branch:"else"}.' };
        }
        for (const k of WIRE_KEYS) {
            if (!(k in patch)) continue;
            if (step.type !== 'condition') {
                return { error: `${k} is for a condition step; "${stepId}" is a ${step.type}. To move a step, patch THAT step: builder_update_step({stepId:"<step>", patch:{afterStepId:"${stepId}"${step.type === 'switch' ? ', caseName:"<case>"' : ''}}}).` };
            }
            const target = patch[k];
            if (typeof target !== 'string' || !target) return { error: `${k} must be the id of an existing step.` };
            const r = moveStepAfter(graph, target, { afterStepId: stepId, branch: k === 'thenStepId' ? 'then' : 'else' });
            if (r.error) return { error: r.error };
            moved.push(r.now + (r.note ? ` — ${r.note}` : ''));
        }
        const rest = { ...patch };
        for (const k of [...MOVE_KEYS, ...WIRE_KEYS]) delete rest[k];
        patch = rest;
        // The move re-ordered the steps array, so the slot found above is stale.
        found = findStepAnywhere(graph, stepId);
        step = found.step;
        if (!Object.keys(patch).length) return { updated: step, moved };
    }

    // A data_extraction patch in integration_action / ai_step vocabulary
    // ({inputs:{source}}, {prompt}, {outputSchema}) is translated the way the
    // add path translates it — refusing "inputs not patchable" here would
    // send the model to remove + re-add the step, minting a new id.
    const patchNotes = [];
    if (step.type === 'data_extraction') {
        const tr = translateDataExtractionVocabulary(patch);
        patch = tr.args;
        patchNotes.push(...tr.notes);
    }
    // The datatable mirror: {fields:{…}} / {row:{…}} / {tableId} / {op:"append"}
    // are the add path's foreign vocabulary, and "fields not patchable on a
    // datatable step" sent the model to remove + re-add. Translated BEFORE
    // the allow-list, so the check sees the step's own field names. The op
    // is resolved with hasValues:true: a patch that blanks the op of a step
    // is not asking for the harmless default, it is a mistake to refuse.
    if (step.type === 'datatable') {
        const tr = translateDatatableVocabulary(patch);
        if (tr.error) return tr;
        patch = tr.args;
        patchNotes.push(...tr.notes);
        if ('op' in patch) {
            const r = resolveDatatableOp(patch.op, { hasValues: true });
            if (r.error) return r;
            patch.op = r.op;
            if (r.note) patchNotes.push(r.note);
        }
    }

    const allowed = PATCHABLE_FIELDS[step.type];
    if (!allowed) return { error: `Step type "${step.type}" cannot be patched.` };
    const bad = Object.keys(patch).filter(k => !allowed.includes(k));
    if (bad.length) {
        // A loop's body is the one refusal that used to be a dead end: no tool
        // appends into an existing body, `scope` only resolves flowlet keys, and
        // this message named neither escape. A model that reads it literally
        // concludes it must remove and re-add the loop — which mints a new id
        // and breaks every downstream ref. Name the way out instead.
        if (step.type === 'loop' && (bad.includes('body') || bad.includes('steps'))) {
            return { error: `A loop's body is not patched field-by-field. Re-send the whole body with builder_replace_step({stepId:"${stepId}", newType:"loop", spec:{overRef, itemVar, maxIterations, body:[…]}}) — that KEEPS the loop's id and all its wiring, so downstream refs survive. Body steps are FLAT step objects; to change ONE of them, patch it by its own id. Patchable on the loop itself: ${allowed.join(', ')}.` };
        }
        return { error: `Field(s) ${bad.join(', ')} not patchable on a ${step.type} step. Allowed: ${allowed.join(', ')}.` };
    }

    // §B3 gate: re-pointing an integration_action at a new tool re-arms inspect.
    // The availability guard runs FIRST and for the same reason it exists on the
    // add path: a patch is otherwise a way to smuggle in a tool name the user
    // cannot run, on a step that was legitimate when it was created.
    if (step.type === 'integration_action' && 'tool' in patch) {
        const unknown = unknownToolError(patch.tool, draftWrap);
        if (unknown) return unknown;
        const mergedInputs = ('inputs' in patch) ? { ...(step.inputs || {}), ...(patch.inputs || {}) } : (step.inputs || {});
        const gate = inspectGateError(patch.tool, mergedInputs, draftWrap);
        if (gate) return gate;
    }
    // ai_step modelTier must stay within the user's configured tier set.
    if (step.type === 'ai_step' && 'modelTier' in patch) {
        const tierErr = modelTierGateError(patch.modelTier, draftWrap);
        if (tierErr) return tierErr;
    }
    // FILL-ONLY: a datatable step that already names a table keeps it. The
    // patch exists so an IMPORTED step — whose id export deliberately blanked —
    // can be linked to a table here; re-pointing a bound step is a different
    // act with a different blast radius (the rows of another organisation's
    // table), and it stays where it was. The id is never trusted on its own
    // either: execDatatable resolves it inside the automation's own scopes and
    // fails closed, so a patched id can name nothing outside them.
    //
    // With a catalog the patch is RESOLVED first (id, key, name — the same
    // ladder the add path climbs), because the refusal compared strings: a
    // patch of `{datatableId:"Facturen"}` on a step already linked to that
    // very table was refused as a re-point, and the model's next move was to
    // remove + re-add the step. The same table is a no-op and says so; a blank
    // step is filled with both id and key; a different table is the refusal.
    let filledTable = null;
    if (step.type === 'datatable' && ('datatableId' in patch || 'datatableKey' in patch)) {
        const linked = (typeof step.datatableId === 'string' && step.datatableId) ? step.datatableId : null;
        const ref = resolveDatatableRef({ id: patch.datatableId, key: patch.datatableKey, datatables: draftWrap?._datatables });
        if (ref.error) return ref;
        if (ref.table) {
            patchNotes.push(...ref.notes);
            if (linked && ref.table.id === linked) {
                delete patch.datatableId;
                delete patch.datatableKey;
                patchNotes.push(`datatableId already is ${linked} (${ref.table.key}, "${ref.table.name}") — nothing to change there.`);
            } else if (!linked) {
                patch.datatableId = ref.table.id;
                patch.datatableKey = ref.table.key;
                filledTable = ref.table;
            } else {
                return { error: `Step "${stepId}" already uses datatable "${step.datatableId}". Pointing a step at a different table is not a patch — use builder_replace_step, or leave it to the person who owns the data.` };
            }
        } else if ('datatableId' in patch && linked && String(patch.datatableId || '').trim() !== linked) {
            return { error: `Step "${stepId}" already uses datatable "${step.datatableId}". Pointing a step at a different table is not a patch — use builder_replace_step, or leave it to the person who owns the data.` };
        }
    }
    // FILL-ONLY, for the datatable reason and one of its own: which AGENT
    // does the thinking is the field both checks look at — validate/stepRules
    // at save and activate, aiStepAgent at run time — and a patch is the one
    // path that could move it without the step being rebuilt. Re-pointing a
    // step at somebody else's agent is not an edit: it changes whose knowledge
    // is read and whose tools run, which is precisely the act those checks
    // exist to see. FILLING a blank one stays allowed, because an imported
    // automation arrives with the id blanked and this is where it gets repaired.
    //
    // ── EXCEPT INSIDE A LOOP BODY, WHERE THE ADVICE WAS A DEAD END ──
    // `builder_replace_step` refuses a loop-body step outright ("patch it with
    // builder_update_step"), so for an ai_step in a loop the two refusals
    // pointed at each other and the agent could not be changed at all — only
    // by deleting the step and adding it again, which mints a new id and breaks
    // every downstream reference. The re-point is allowed there, and it is not
    // an unchecked one: `persistDraft` builds the agent catalog and hands it to
    // `validateDefinition` on EVERY builder save, so the permission check runs
    // on this path too. That is also what makes the sentence below true.
    if (step.type === 'ai_step' && 'agentId' in patch && found.kind !== 'loop'
        && typeof step.agentId === 'string' && step.agentId
        && String(patch.agentId || '').trim() !== step.agentId) {
        return { error: `Step "${stepId}" already runs on agent "${step.agentId}". Pointing a step at a different agent is not a patch — use builder_replace_step, so the permission check runs on it.` };
    }
    // FILL-ONLY, for the datatable reason and one of its own: which knowledge
    // base a step writes to is exactly what the save-time permission check
    // looks at, and a patch is the one path that could change it without the
    // step being rebuilt. An imported step arrives with the id blanked, so
    // FILLING one stays allowed.
    if (step.type === 'knowledge_write' && 'knowledgeBaseId' in patch
        && typeof step.knowledgeBaseId === 'string' && step.knowledgeBaseId
        && String(patch.knowledgeBaseId || '').trim() !== step.knowledgeBaseId) {
        return { error: `Step "${stepId}" already writes to knowledge base "${step.knowledgeBaseId}". Pointing a write at a different base is not a patch — use builder_replace_step, so the permission check runs on it.` };
    }

    const next = { ...step };

    // parse_json.fields is an ARRAY of {name, path, ...} rows — not a binding
    // map — so it bypasses the bindKey machinery below (which would silently
    // drop it): replace wholesale through the same sanitizer as the add tool.
    if (step.type === 'parse_json' && 'fields' in patch) {
        const { fields, error } = sanitizeParseJsonFieldRows(patch.fields);
        if (error) return { error };
        next.fields = fields;
    }

    // data_extraction.fields is the ARRAY of declared fields — the output shape
    // — so it too bypasses the bindKey machinery (which would read `fields` as
    // a binding map only on a set step, and skip it here): replaced wholesale
    // through the add tool's sanitizer. `source` is ONE binding, not the
    // `inputs` map, so it gets the add path's canonicalisation explicitly.
    if (step.type === 'data_extraction') {
        if ('fields' in patch) {
            const { fields, error } = sanitizeDataExtractionFields(patch.fields);
            if (error) return { error };
            next.fields = fields;
        }
        if ('source' in patch) {
            const src = sanitizeDataExtractionSource(patch.source, graph, draftWrap);
            if (src.error) return { error: src.error, ...(src._fixHint ? { _fixHint: src._fixHint } : {}) };
            next.source = src.source;
            patchNotes.push(...(src.notes || []));
            // The same item-shape check the add path runs, against the forEach
            // the step will have once this patch lands (a forEach in the same
            // patch counts; an invalid one is left for the forEach block below
            // to refuse). A patch was the one way the measured `loop.r.content`
            // could still reach a step after the add path learned to repair it.
            const fe = 'forEach' in patch
                ? (patch.forEach === null ? undefined : sanitizeForEach(patch.forEach, graph, draftWrap).forEach)
                : step.forEach;
            if (fe && next.source.kind === 'ref' && typeof next.source.path === 'string' && next.source.path.startsWith(`loop.${fe.itemVar}.`)) {
                const chk = checkLoopRef(graph, next.source.path, fe, draftWrap);
                if (chk.ok && chk.path) {
                    next.source = { ...next.source, path: chk.path };
                    patchNotes.push(chk.note.replace(/^binding /, 'source '));
                } else if (!chk.ok) {
                    return loopItemSourceError(chk, fe, draftWrap);
                }
            }
        }
    }

    // set.operations is likewise an ARRAY — replace wholesale through the add
    // tool's sanitizer; null clears it.
    if (step.type === 'set' && 'operations' in patch) {
        if (patch.operations === null) { delete next.operations; }
        else {
            const { operations, error } = sanitizeSetOperations(patch.operations);
            if (error) return { error };
            if (operations.length) next.operations = operations; else delete next.operations;
        }
    }

    // A datatable's bindings live in `values` and `where[].value`, so the
    // bindKey pass below — hard-coded to 'fields' or 'inputs' — never saw them
    // and a patched "{{steps.x.output.y}}" was stored as literal text. Same
    // sanitizer the add tool uses, over the MERGED step so patching one column
    // does not re-canonicalize the others out of existence.
    if (step.type === 'datatable') {
        // The catalog table the step is on once this patch lands: filled just
        // above, or the one it already had — by EXACT id only; a step whose id
        // the catalog does not know is left as it is (an import that has not
        // been re-linked yet), never re-checked against a table it may not
        // mean. null = no catalog or no match → the column checks are skipped.
        const tableId = filledTable ? filledTable.id : step.datatableId;
        const table = filledTable || ((Array.isArray(draftWrap?._datatables) && typeof tableId === 'string' && tableId)
            ? (draftWrap._datatables.find(t => t && t.id === tableId) || null)
            : null);
        const opAfter = ('op' in patch) ? patch.op : step.op;
        // The add path refuses a write on a table this user can only read; a
        // patch that turns a read into a write, or links a write to such a
        // table, is the same run-time failure by another door.
        if (table && ('op' in patch || filledTable) && DATATABLE_WRITE_OPS.has(opAfter) && !table.canWrite) {
            return readOnlyTableError(table, opAfter);
        }
        if ('values' in patch || 'where' in patch) {
            // Only what the patch sends is canonicalised and checked; the
            // columns it leaves alone are the author's and stay byte-identical
            // (a broken one is the validator's report, never a reason to
            // refuse an unrelated patch).
            const merged = { values: {}, where: [] };
            let patchValues = null;
            if ('values' in patch) {
                let raw = (patch.values && typeof patch.values === 'object' && !Array.isArray(patch.values)) ? patch.values : {};
                // The PATCH keys are mapped before the merge, not the merged
                // map after it: a patch of {"Excl. btw": …} onto a step that
                // already writes excl_btw would otherwise collapse two keys
                // onto one column and be refused for the model's own title.
                // Without a catalog this only refuses one binding for the
                // whole row (mapColumnKeys passes everything else through).
                const m = mapColumnKeys(raw, table ? table.columns : null, { tableName: table ? table.name : undefined });
                if (m.error) return m;
                patchNotes.push(...m.notes);
                raw = m.map;
                patchValues = raw;
                merged.values = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
            }
            // `where` is a LIST — merging by index would silently keep a condition
            // the author meant to drop, so it is replaced wholesale like
            // set.operations and parse_json.fields. The column-keyed object form
            // is handed to sanitizeDatatableBindings as-is: it translates that
            // shape and reports the translation. Emptying it here instead is
            // what made a patch carrying the object form a no-op — the step kept
            // its old `where`, the result said "already had exactly these
            // values", and the model re-sent the same patch (measured, four
            // rounds running, 2026-09-16).
            if ('where' in patch) merged.where = patch.where;
            const bound = sanitizeDatatableBindings(merged, graph, draftWrap);
            if (bound.error) return { error: bound.error };
            patchNotes.push(...bound.repairs);
            if (patchValues) {
                if (args.inputsMode === 'replace') next.values = bound.values;
                else {
                    const mm = { ...(step.values || {}) };
                    for (const [k, v] of Object.entries(patchValues)) { if (v === null) delete mm[k]; else mm[k] = bound.values[k]; }
                    next.values = mm;
                }
            }
            if ('where' in patch) next.where = bound.where;
        }
        if (table) {
            // Only what the patch touched: a stale column on a field the patch
            // leaves alone is the validator's report, not a reason to refuse a
            // label change.
            const cols = resolveDatatableColumns({
                op: opAfter,
                where: ('where' in patch) ? next.where : undefined,
                sort: ('sort' in patch) ? patch.sort : undefined,
                matchColumn: ('matchColumn' in patch) ? patch.matchColumn : undefined,
            }, table);
            if (cols.error) return cols;
            patchNotes.push(...cols.notes);
            if ('where' in patch) next.where = cols.where;
            if ('sort' in patch) patch.sort = cols.sort;
            if ('matchColumn' in patch) patch.matchColumn = cols.matchColumn;
        }
        if ('values' in patch || 'forEach' in patch) {
            // The same declared-field check the add path runs, against the
            // forEach the step will have once this patch lands (an invalid one
            // is left for the forEach block below to refuse).
            const fe = 'forEach' in patch
                ? (patch.forEach === null ? undefined : sanitizeForEach(patch.forEach, graph, draftWrap).forEach)
                : step.forEach;
            if (fe) {
                const ex = checkExtractionFieldRefs(graph, next.values, fe, draftWrap);
                if (ex.error) return ex;
                next.values = ex.values;
                patchNotes.push(...ex.notes);
            }
        }
    }

    // inputs / fields: merge-by-key (null deletes) unless inputsMode:'replace'.
    // Only the keys the patch names are canonicalised and checked. The rest
    // are the author's own mappings: they stay byte-identical. Re-running the
    // whole merged map through the canonicaliser is how one AI edit of
    // `subject` used to rewrite a hand-mapped `to` from value[0].from… to the
    // unreadable value.0.from… (findings C1, 2026-10).
    // The forEach the step will have once this patch lands (an invalid one is
    // refused by the forEach block below): loop.<var> paths the patch sends
    // are checked against what it iterates.
    const feAfter = 'forEach' in patch
        ? (patch.forEach === null ? undefined : sanitizeForEach(patch.forEach, graph, draftWrap).forEach)
        : step.forEach;
    const bindKey = step.type === 'set' ? 'fields' : 'inputs';
    if (bindKey in patch) {
        const mode = args.inputsMode === 'replace' ? 'replace' : 'merge';
        const raw = (patch[bindKey] && typeof patch[bindKey] === 'object') ? patch[bindKey] : {};
        const sent = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
        const bound = validateAndFixBindings(sent, graph, { draftWrap });
        if (bound.error) {
            return {
                error: bound.error,
                ...(bound._suggestedPatch ? { _suggestedPatch: { ops: bound._suggestedPatch.ops.map(o => ({ ...o, path: `patch.${bindKey}${o.path.slice('inputs'.length)}` })) } } : {}),
            };
        }
        const loop = checkLoopBindings(bound.inputs, graph, feAfter, draftWrap, { label: bindKey });
        if (loop.error) return { error: loop.error };
        const inputs = loop.value;
        const notes = [...(bound.notes || []), ...loop.notes];
        if (mode === 'merge') {
            const merged = { ...(step[bindKey] || {}) };
            for (const k of Object.keys(raw)) { if (raw[k] === null) delete merged[k]; else merged[k] = inputs[k]; }
            next[bindKey] = merged;
        } else {
            next[bindKey] = inputs;
        }
        patchNotes.push(...notes.map(n => (bindKey === 'fields' ? n.replace(/^inputs\./, 'fields.') : n)));
    }

    // forEach: re-validate; null clears it.
    if ('forEach' in patch) {
        if (patch.forEach === null) { delete next.forEach; }
        else {
            const { forEach, error, notes } = sanitizeForEach(patch.forEach, graph, draftWrap);
            if (error) return { error };
            if (forEach) next.forEach = forEach; else delete next.forEach;
            patchNotes.push(...(notes || []));
        }
    }

    // Text fields the run interpolates, and the list a step works through:
    // the same path checks the add tools run (bindings.js). The checked
    // values replace the patch's own in the scalar pass below (the patch
    // object is the model's and is never mutated).
    const checked = {};
    for (const key of TEXT_TEMPLATE_FIELDS[step.type] || []) {
        if (!(key in patch) || typeof patch[key] !== 'string') continue;
        const t = checkTextPlaceholders(patch[key], graph, { draftWrap, label: key });
        if (t.error) return { error: t.error };
        const loop = checkLoopBindings(t.text, graph, feAfter, draftWrap, { label: key });
        if (loop.error) return { error: loop.error };
        checked[key] = loop.value;
        patchNotes.push(...t.notes, ...loop.notes);
    }
    const listKey = step.type === 'loop' ? 'overRef' : 'arrayRef';
    if (listKey in patch && typeof patch[listKey] === 'string' && patch[listKey].trim()) {
        const ar = sanitizeArrayRef(patch[listKey], graph, { draftWrap, strictRoot: step.type === 'set' });
        if (ar.error) return { error: ar.error.replace(/^arrayRef/, listKey) };
        checked[listKey] = ar.arrayRef;
        patchNotes.push(...ar.notes.map(n => n.replace(/^arrayRef/, listKey)));
    }
    if (step.type === 'datatable' && 'cursor' in patch) {
        const c = sanitizeDatatableCursor(patch.cursor, graph, draftWrap);
        if (c.error) return { error: c.error };
        checked.cursor = c.cursor;
        patchNotes.push(...c.notes);
    }

    // Scalar / structured fields.
    for (const k of allowed) {
        if (k === 'inputs' || k === 'fields' || k === 'forEach') continue;
        if (step.type === 'set' && k === 'operations') continue; // handled wholesale above
        if (step.type === 'datatable' && (k === 'values' || k === 'where')) continue; // canonicalized above
        if (step.type === 'data_extraction' && k === 'source') continue; // canonicalized above
        if (!(k in patch)) continue;
        const norm = normalizePatchField(step.type, k, k in checked ? checked[k] : patch[k]);
        if (norm === undefined) { if (k !== 'label') delete next[k]; }
        else next[k] = norm;
    }

    // set cross-field integrity after the patch lands — the validator would
    // also catch these on save, but failing HERE gives the model an
    // actionable error on the very turn it made the mistake.
    if (step.type === 'set') {
        const listMode = typeof next.arrayRef === 'string';
        if (listMode && next.forEach) return { error: 'arrayRef (list mode) and forEach cannot be combined — list mode already applies the fields to every row. Clear forEach (forEach: null) or the arrayRef.' };
        if (!listMode && Array.isArray(next.operations) && next.operations.length) {
            return { error: 'operations need arrayRef — set arrayRef to an upstream list, or clear the operations (operations: null).' };
        }
        if (!listMode) delete next.maxItems;
    }

    // Derived fields the apply* builders compute.
    if (step.type === 'code' && 'code' in patch) {
        next.codeHash = crypto.createHash('sha256').update(next.code || '').digest('hex');
    }
    if (step.type === 'integration_action' && 'tool' in patch) {
        next.sideEffect = isSideEffect(next.tool);
        if (!('label' in patch) && (step.label === step.tool)) next.label = next.tool; // keep auto-label tracking the tool
    }

    found.container[found.index] = next;
    // R2, the agent-less half. `normalizePatchField` rebuilds agentPermissions
    // from its three names whenever the patch mentions it, and the add path no
    // longer writes the block at all without an agent — so re-apply the same
    // rule here, or a patched step ends up in a shape the add path cannot
    // produce and carries the orphan warning the add path stopped causing.
    // Covers the repair too: patching agentId to null on a bound step takes
    // the permissions with it, which is what "no agent" means.
    if (next.type === 'ai_step') {
        const hasSkills = Array.isArray(next.skillIds) && next.skillIds.length > 0;
        const block = agentPermissionsBlock(next.agentPermissions, next.agentId, { hasSkills });
        if (block.error) return block;
        if (block.permissions === undefined) delete next.agentPermissions;
        else next.agentPermissions = block.permissions;
        // Same shape as the add path: only on a step with an agent, and only
        // when the list says something.
        if (!next.agentId || !Array.isArray(next.disabledAgentSkillIds) || next.disabledAgentSkillIds.length === 0) {
            delete next.disabledAgentSkillIds;
        }
    }

    return { updated: next, ...(moved.length ? { moved } : {}), ...(patchNotes.length ? { _warnings: patchNotes } : {}) };
}

/**
 * builder_update_steps — batch, all-or-nothing (snapshot + rollback).
 *
 * Reports which steps actually CHANGED. A patch that re-states what the step
 * already says is not an error, but answering a bare "updated" to it is how a
 * model gets stuck: one turn re-sent the identical patch fifteen times, each
 * time read "updated", and burned the whole iteration budget on a no-op
 * (2026-09-12). `unchanged` plus a note is the signal to move on.
 */
function applyUpdateSteps(graph, args, draftWrap) {
    const updates = Array.isArray(args.updates) ? args.updates : null;
    if (!updates || !updates.length) return { error: 'updates must be a non-empty array of { stepId, patch }.' };
    const snapSteps = structuredClone(graph.steps);
    const snapEdges = structuredClone(graph.edges);
    const applied = [];
    const unchanged = [];
    for (const u of updates) {
        const before = JSON.stringify(findStepAnywhere(graph, (u && u.stepId) || '')?.step ?? null);
        const r = applyUpdateStep(graph, u || {}, draftWrap);
        if (r.error) {
            graph.steps = snapSteps;
            graph.edges = snapEdges;
            return { error: `update for "${u && u.stepId}": ${r.error}`, _rolledBack: true };
        }
        const after = JSON.stringify(findStepAnywhere(graph, r.updated.id)?.step ?? null);
        // A move re-wires edges without touching the step object, so it counts
        // as a change even when the step itself is byte-identical.
        if (before !== null && before === after && !r.moved) unchanged.push(r.updated.id);
        else applied.push(r.updated.id);
    }
    if (!applied.length && unchanged.length) {
        return {
            updated: [],
            unchanged,
            _hint: `Nothing changed: ${unchanged.join(', ')} already had exactly these values. `
                + 'Re-sending the same patch will not help — inspect the step, change something else, or move on.',
        };
    }
    return unchanged.length ? { updated: applied, unchanged } : { updated: applied };
}

/**
 * builder_replace_step — change a step's TYPE in place, keeping its id and
 * surrounding wiring. Builds the new step on a throwaway graph (so every apply*
 * validation runs without touching real edges), grafts the old id, then
 * reconciles outgoing branch edges.
 */
function applyReplaceStep(graph, args, { draft, scope = null } = {}, draftWrap) {
    const stepId = typeof args.stepId === 'string' ? args.stepId : null;
    if (!stepId) return { error: 'stepId is required.' };
    const newType = typeof args.newType === 'string' ? args.newType : null;
    if (newType === 'parse_json') return { error: PARSE_JSON_RETIRED_MSG };
    const builder = newType && ADD_FOR_TYPE[newType];
    if (!builder) return { error: `Cannot replace into type "${newType}". Allowed: ${Object.keys(ADD_FOR_TYPE).join(', ')}.` };
    const spec = (args.spec && typeof args.spec === 'object' && !Array.isArray(args.spec)) ? args.spec : null;
    if (!spec) return { error: 'spec must be an object with the new step\'s fields (same shape as builder_add_<newType>).' };

    const found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` };
    if (found.kind === 'loop') {
        return { error: 'Cannot replace a loop-body step\'s type in place — patch it with builder_update_step, or remove + add it inside the loop body.' };
    }
    const oldStep = found.step;

    if (newType === 'integration_action') {
        const gate = inspectGateError(spec.tool, spec.inputs, draftWrap);
        if (gate) return gate;
    }

    // Throwaway graph: shares the real trigger (for ref validation) but its own
    // empty steps/edges arrays so appendAfter wiring is discarded.
    const scratch = { trigger: graph.trigger, steps: [], edges: [], layers: draft && draft.layers };
    const buildArgs = { ...spec };
    delete buildArgs.afterStepId; delete buildArgs.branch; delete buildArgs.caseName; delete buildArgs.scope;
    const res = newType === 'call_layer'
        ? builder(draft, buildArgs, { graph: scratch, scope })
        : builder(scratch, buildArgs, draftWrap);
    if (res.error) return res;
    const built = res.added;
    built.id = oldStep.id;                       // keep id → every edge still targets it

    found.container[found.index] = built;
    const rewired = reconcileOutgoingEdges(graph, oldStep, built);
    // The builder's tolerant reads (an op alias, a title-keyed column) are
    // said on the add path; a replace that swallowed them would leave the
    // model believing its spelling was stored as sent.
    return { replaced: built, ...(rewired ? { rewired } : {}), ...(res._warnings ? { _warnings: res._warnings } : {}) };
}

/**
 * Which surviving steps still reference `id` in a binding.
 *
 * applyRemoveStep used to report a bare {removed} and bridge the edges, while
 * leaving every `steps.<id>.output.*` binding in the rest of the graph
 * pointing at a step that no longer exists. The breakage only surfaced a
 * ROUND later, as a ref.unknown_step validation error, by which time the model
 * had usually moved on and had to backtrack. Reporting it in the result of the
 * call that caused it is what lets the model fix it immediately.
 *
 * Warn rather than refuse: removing a step and re-pointing its consumers is a
 * legitimate two-step edit, and applyRemoveTrigger already set the
 * report-don't-block precedent for orphans.
 */
function findDanglingRefs(graph, id) {
    const { collectRefPaths, isObject } = require('../validate/helpers');
    const { collectStepRefs } = require('../validate/stepRules/refSurfaces');
    const { refHead, tryParseExpr, exprStepIds, findRefPaths } = require('../validate/refPaths');
    const { TOPIC_HOST_SPEC } = require('../expr');
    // One reference, read the way the runner reads it: a path by the shared
    // grammar (dotted or bracketed id, never a prefix match), an expression
    // by its parser (a quoted "read" is a value). A half-typed expression is
    // still searched for the paths in it, so a typo does not hide a read.
    const readsId = (r) => {
        if (r.kind === 'ref') {
            const h = refHead(r.path);
            return h.root === 'steps' && h.second === id;
        }
        const { ast } = tryParseExpr(r.src, { host: TOPIC_HOST_SPEC });
        if (ast) return exprStepIds(ast).includes(id);
        return findRefPaths(r.src, ['steps']).some(t => t[1].type === 'prop' && String(t[1].key) === id);
    };
    // Every reference a step carries: binding objects anywhere in it, plus the
    // surfaces that hold bare paths, templates and expressions (refSurfaces.js,
    // the validator's list), for the step and every step nested in it.
    const refsOf = (s) => {
        const out = [];
        collectRefPaths(s, out);
        const walk = (st) => {
            if (!isObject(st)) return;
            out.push(...collectStepRefs(st));
            for (const child of (Array.isArray(st.body) ? st.body : [])) walk(child);
            for (const b of (Array.isArray(st.branches) ? st.branches : [])) {
                for (const child of (Array.isArray(b) ? b : (Array.isArray(b?.steps) ? b.steps : []))) walk(child);
            }
        };
        walk(s);
        return out;
    };
    const hits = new Set();
    const scan = (steps, scope) => {
        for (const s of (steps || [])) {
            if (!s || s.id === id) continue;
            if (refsOf(s).some(readsId)) hits.add(scope ? `${scope}/${s.id}` : s.id);
        }
    };
    scan(graph?.steps, null);
    for (const [key, g] of Object.entries(graph?.layers || {})) {
        if (g && typeof g === 'object') scan(g.steps, key);
    }
    return [...hits];
}

function applyRemoveStep(graph, args) {
    const id = args.stepId;
    // Trigger ids: the primary is never removable here (builder_propose_trigger
    // replaces it); an ADDITIONAL trigger is removed with its outgoing edges.
    if (graph?.trigger && id === graph.trigger.id) {
        return { error: 'The primary trigger cannot be removed — change it with builder_propose_trigger.' };
    }
    if (Array.isArray(graph?.triggers) && graph.triggers.some(t => t && t.id === id)) {
        return require('./triggers').applyRemoveTrigger(graph, id);
    }
    const found = findStepAnywhere(graph, id);
    if (!found) return { error: `Unknown stepId "${id}". Existing step ids: ${listStepIds(graph)}.` };

    // Loop-body steps have no top-level edges — just splice them out.
    if (found.kind === 'loop') {
        const dangling = findDanglingRefs(graph, id);
        found.container.splice(found.index, 1);
        return { removed: id, ...(dangling.length ? { danglingRefs: dangling, note: `steps ${dangling.join(', ')} still bind steps.${id}.* — re-point or remove those bindings` } : {}) };
    }

    const reconnect = args.reconnect !== false;   // default true
    const step = found.step;
    // Collected BEFORE the splice — afterwards the step is gone and its
    // consumers are indistinguishable from consumers of a never-existing id.
    const dangling = findDanglingRefs(graph, id);
    const incoming = (graph.edges || []).filter(e => e.to === id);
    const outgoing = (graph.edges || []).filter(e => e.from === id);
    const bridges = [];

    if (reconnect && incoming.length && outgoing.length) {
        const branching = BRANCHING_TYPES.has(step.type);
        // Successor targets to bridge to: prefer the success path (skip on_error).
        let targets;
        if (!branching) {
            const succ = outgoing.filter(e => e.label !== 'on_error').map(e => e.to);
            targets = succ.length ? succ : outgoing.map(e => e.to);
        } else {
            // Branching anchor: pick a single primary successor; the rest are dropped.
            const primary = outgoing.find(e => e.label === 'then')
                || outgoing.find(e => e.label === 'case:default')
                || outgoing.find(e => e.label !== 'on_error')
                || outgoing[0];
            targets = primary ? [primary.to] : [];
        }
        for (const inc of incoming) {
            for (const to of targets) {
                if (inc.from === to) continue;
                const e = { from: inc.from, to };
                if (inc.label) { e.label = inc.label; if (inc.caseName) e.caseName = inc.caseName; }
                const dup = (graph.edges || []).some(x => x.from === e.from && x.to === e.to && x.label === e.label);
                if (!dup) { graph.edges.push(e); bridges.push(`${e.from}→${e.to}`); }
            }
        }
    }

    found.container.splice(found.index, 1);
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);

    const parts = [];
    if (bridges.length) parts.push(`reconnected ${bridges.join(', ')}`);
    if (dangling.length) parts.push(`steps ${dangling.join(', ')} still bind steps.${id}.* — re-point or remove those bindings`);
    if (reconnect && BRANCHING_TYPES.has(step.type) && outgoing.filter(e => e.label !== 'on_error').length > 1) {
        parts.push('removed a branching step — only its primary branch was reconnected; re-wire the other branch targets if still needed');
    }
    return {
        removed: id,
        ...(dangling.length ? { danglingRefs: dangling } : {}),
        ...(parts.length ? { note: parts.join('; ') } : {}),
    };
}

module.exports = {
    PATCHABLE_FIELDS,
    applyUpdateStep,
    applyUpdateSteps,
    applyReplaceStep,
    applyRemoveStep,
};

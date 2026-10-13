/**
 * builder_update_step — normalise one patched field to the exact shape the
 * matching apply* builder writes, so a patched step is byte-identical to a
 * freshly added one. Moved verbatim out of stepEditing.js.
 */

const { normalizeApprovalConfig } = require('../approval');
// The leaf builders, not the stepBuilders index: the index and aiStep sit in
// the server's largest import cycle, their names come through cycleDeps.
const { clampDocumentTtl } = require('../stepBuilders/documentSteps');
const { normalizeAskOnce, normalizeCacheInto } = require('../stepBuilders/outboundSteps');
const { bindingToTemplate } = require('../stepBuilders/inputBindings');
const { NOTE_MAX_TEXT_LENGTH, NOTE_COLOR_KEYS, sanitizeNoteSize } = require('../stepBuilders/noteStep');
const { sanitizeSwitchCases } = require('../stepBuilders/flowSteps');
const cycleDeps = require('./cycleDeps');
const { normalizeQuery: normalizeHttpQuery } = require('../../../core/automationRunner/httpQuery');
const { KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS } = require('../../validate/constants');

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
        if (key === 'agentId') return cycleDeps.sanitizeAgentId(value);
        if (key === 'skillIds') return cycleDeps.sanitizeSkillIds(value);
        if (key === 'agentPermissions') return cycleDeps.sanitizeAgentPermissions(value);
        // Handoff 5: the agent's skills this step switches off, replaced
        // wholesale (send the full list).
        if (key === 'disabledAgentSkillIds') return cycleDeps.sanitizeDisabledAgentSkillIds(value);
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
            const { sanitizeCodeLimits } = require('../stepBuilders/dataSteps');
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
        if (key === 'query') return normalizeHttpQuery(value);
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
            const { slideVisualFields } = require('../stepBuilders/documentSteps');
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
            const { deckLookFields } = require('../stepBuilders/documentSteps');
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
        // Same rules as applyAddSwitch: 'all' or absent. A string list keeps
        // or enters list mode ('' = source not picked yet, as the editor
        // writes it); null takes the switch out of list mode.
        if (key === 'matchMode') return value === 'all' ? 'all' : undefined;
        if (key === 'arrayRef') return typeof value === 'string' ? value.trim() : undefined;
    }
    if ((type === 'switch' || type === 'filter') && key === 'maxItems') {
        return (Number.isInteger(value) && value > 0) ? value : undefined;
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
    if (type === 'guard' || type === 'tokenize' || type === 'untokenize') {
        // A ref PATH string, as the add path stores it ('' = not picked yet).
        if (key === 'sourceRef') return typeof value === 'string' ? value.trim() : '';
        // Narrow-only, like the runner (execPrivacy.narrowPolicy): a list of
        // category names, or absent for "every category the organisation allows".
        if (key === 'categories') {
            const list = Array.isArray(value) ? value.filter(c => typeof c === 'string' && c) : [];
            return list.length ? list : undefined;
        }
        if (key === 'confidence') return (typeof value === 'number' && value > 0 && value <= 1) ? value : undefined;
        if (key === 'onFound') {
            const o = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const next = { ...(o.stop === true ? { stop: true } : {}), ...(o.mask === true ? { mask: true } : {}), ...(o.tokenize === true ? { tokenize: true } : {}) };
            return Object.keys(next).length ? next : undefined;
        }
    }
    if (type === 'dedupe' && key === 'keyField') return typeof value === 'string' ? value : undefined;
    if (type === 'flatten') {
        if (key === 'keepEmpty') return value === true ? true : undefined;
        if (key === 'maxItems') return (Number.isInteger(value) && value > 0) ? value : undefined;
    }
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

module.exports = { normalizePatchField };

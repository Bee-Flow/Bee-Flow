// §WS5 — pure form <-> step-shape helpers extracted verbatim from
// SettingsForm.jsx. No JSX/React; schemaToFields/fieldsToSchema keep their
// public export (re-exported by SettingsForm for ToolInputForm + tests).
import { impliedListMode } from '../datetimeTarget';
import { ROUTE_STEP_TYPES, readRoute, writeRoute } from '../routeModel';
import { PRIVACY_STEP_TYPES, readPrivacy, writePrivacy } from '../privacyModel';
import { flattenDraft, flattenPatch } from './flattenEditorModel';
import { defaultTriggerLabel } from '../triggerLabels';
import { paramsToSchema, schemaToParams } from '../triggerSchemaUtils';

/** Move the previous binding's value into the new shape so the user
 *  doesn't lose what they typed when toggling kind. */
export function convertValue(binding, fromKind, toKind) {
    if (!binding) return {};
    if (fromKind === toKind) return {};
    const carry = binding.value ?? binding.path ?? '';
    if (toKind === 'literal')  return { value: typeof carry === 'string' ? carry : String(carry), path: undefined };
    if (toKind === 'ref')      return { path: typeof carry === 'string' ? carry : '', value: undefined };
    if (toKind === 'template') return { value: typeof carry === 'string' ? carry : '', path: undefined };
    if (toKind === 'expr')     return { value: typeof carry === 'string' ? carry : '', path: undefined };
    return {};
}

// ── Approval stage chain ───────────────────────────────────────────────
//
// Mirrors server/automation/approvalStages.js (the shared rulebook) and
// builderTools.normalizeApprovalConfig, so a hand-built chain and an
// AI-built one are the same object and the editor can never author a chain
// the server would refuse.

/** Product cap on the chain's length. */
export const MAX_APPROVAL_STAGES = 5;
/** Seats in ONE stage. */
export const MAX_SEATS_PER_STAGE = 10;
/** Seats across the WHOLE chain — bounds the participant index and fan-out. */
export const MAX_TOTAL_STAGE_SEATS = 30;
export const MAX_STAGE_NAME_LEN = 60;
export const MAX_STAGE_DESCRIPTION_LEN = 200;
export const STAGE_RULES = ['all', 'first', 'quorum'];

/** One seat: exactly one of userId / groupId, or null. */
export function cleanApprovalSeat(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.userId === 'string' && raw.userId.trim()) return { userId: raw.userId.trim() };
    if (typeof raw.groupId === 'string' && raw.groupId.trim()) return { groupId: raw.groupId.trim() };
    return null;
}

export function approvalSeatKey(seat) {
    return seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
}

/** Real (picked) seats of one stage, de-duplicated and capped. */
export function stageSeats(stage) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(stage?.approvers) ? stage.approvers : []) {
        const seat = cleanApprovalSeat(raw);
        if (!seat) continue;
        const key = approvalSeatKey(seat);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(seat);
        if (out.length >= MAX_SEATS_PER_STAGE) break;
    }
    return out;
}

/** Seats already committed across the chain — the 30-seat budget's numerator. */
export function totalStageSeats(stages) {
    return (Array.isArray(stages) ? stages : []).reduce((n, st) => n + stageSeats(st).length, 0);
}

/**
 * A key for a stage the author is adding NOW.
 *
 * Keys are what already-cast votes are filed under, so they must be unique
 * within the chain AND stable for every stage that already exists. Positional
 * keys would satisfy neither: inserting a stage at the front would hand the
 * newcomer the key of the stage that ran yesterday, and the normalizer would
 * then push the old one onto a fresh key — orphaning its votes. So a new
 * stage takes the lowest `sN` nobody in the chain is using.
 */
export function newStageKey(stages) {
    const taken = new Set((Array.isArray(stages) ? stages : [])
        .map(st => (typeof st?.key === 'string' ? st.key.trim() : ''))
        .filter(Boolean));
    for (let i = 1; i <= 99; i++) {
        const candidate = `s${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `s${Date.now().toString(36)}`;
}

/**
 * The draft chain → exactly what the server stores.
 *
 * A stage nobody sits in is DROPPED rather than persisted: validate.js treats
 * `approval.stages_invalid` as an integrity problem (it is not in
 * COMPLETENESS_CODES), so a half-picked stage in the payload would 400 the
 * whole automation's save. The editor says so on the row instead of letting the
 * save fail. Author keys are preserved verbatim — only an absent or colliding
 * key is replaced.
 */
export function sanitizeApprovalStages(raw) {
    const chain = [];
    const usedKeys = new Set();
    let totalSeats = 0;
    for (const src of (Array.isArray(raw) ? raw : []).slice(0, MAX_APPROVAL_STAGES)) {
        if (!src || typeof src !== 'object') continue;
        const seats = stageSeats(src);
        if (!seats.length) continue;
        if (totalSeats + seats.length > MAX_TOTAL_STAGE_SEATS) break;
        totalSeats += seats.length;
        let key = (typeof src.key === 'string' && src.key.trim()) ? src.key.trim().slice(0, 40) : '';
        if (!key || usedKeys.has(key)) key = newStageKey([...usedKeys].map(k => ({ key: k })));
        usedKeys.add(key);
        const rule = STAGE_RULES.includes(src.rule) ? src.rule : 'all';
        chain.push({ key, approvers: seats, rule, ...stageExtras(src, rule, seats.length) });
    }
    return chain;
}

/** A stage's optional half: name, description, quorum, condition. */
function stageExtras(src, rule, seatCount) {
    const out = {};
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const name = text(src.name, MAX_STAGE_NAME_LEN);
    if (name) out.name = name;
    const description = text(src.description, MAX_STAGE_DESCRIPTION_LEN);
    if (description) out.description = description;
    if (rule === 'quorum') {
        const n = Math.round(Number(src.quorum));
        out.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seatCount) : Math.min(2, seatCount);
    }
    const when = text(src.when, 2000);
    if (when) out.when = when;
    return out;
}

// ── Pending rows — added, not yet fillable on the wire ─────────────────
//
// "Add a document" (an approver seat, a stage) seeds an EMPTY row the user is
// about to fill in. buildPatch rightly refuses to persist it — an attachment
// without a binding, a seat naming nobody, a stage with no approvers mean
// nothing to the engine — so the row exists only in the form's local draft.
// That used to make it vanish out from under the user: the debounce saved a
// patch that (correctly) lacked the row, the save's echo came back as fresh
// step content over a seemingly edit-free draft, and the content sync adopted
// it — erasing the input about a second after they clicked Add.
//
// carryPendingRows is the sync's antidote: when adopting incoming step
// content, re-apply the draft rows the wire could not carry. Each predicate
// MIRRORS buildPatch's own filter — a row is pending exactly while buildPatch
// would drop it — so the moment a row becomes persistable (binding filled,
// person picked) it stops being carried here and starts being carried by the
// save itself.

const pendingAttachment = (row) =>
    !!row && typeof row === 'object' && !(typeof row.binding === 'string' && row.binding.trim());
const pendingQuestion = (row) =>
    !!row && typeof row === 'object' && !row.name && !row.label;
const pendingSeat = (seat) => !cleanApprovalSeat(seat);

export function carryPendingRows(incoming, prev) {
    if (!prev || typeof prev !== 'object') return incoming;
    let out = incoming;
    const carryList = (field, isPending) => {
        const rows = Array.isArray(prev[field]) ? prev[field].filter(isPending) : [];
        if (!rows.length) return;
        out = { ...out, [field]: [...(Array.isArray(out[field]) ? out[field] : []), ...rows] };
    };
    carryList('attachments', pendingAttachment);
    carryList('approvalFields', pendingQuestion);
    carryList('approvers', pendingSeat);

    // Stages carry at two levels. A stage with no picked approvers is pending
    // as a WHOLE (sanitizeApprovalStages drops it, name and description
    // included — losing a typed name with it). A persisted stage can also
    // hold a freshly added, still-empty SEAT row; that seat is re-applied to
    // the same stage in the incoming chain, matched by key — the one stage
    // identifier that survives renames and reorders.
    if (Array.isArray(prev.stages) && prev.stages.length) {
        const wholes = prev.stages.filter(st => st && typeof st === 'object' && stageSeats(st).length === 0);
        const pendingSeatsByKey = new Map();
        for (const st of prev.stages) {
            if (!st || typeof st !== 'object' || stageSeats(st).length === 0) continue;
            const seats = (Array.isArray(st.approvers) ? st.approvers : []).filter(pendingSeat);
            if (seats.length && typeof st.key === 'string') pendingSeatsByKey.set(st.key, seats);
        }
        if (wholes.length || pendingSeatsByKey.size) {
            const base = Array.isArray(out.stages) ? out.stages : [];
            const merged = base.map(st => {
                const seats = st && pendingSeatsByKey.get(st.key);
                return seats
                    ? { ...st, approvers: [...(Array.isArray(st.approvers) ? st.approvers : []), ...seats] }
                    : st;
            });
            out = { ...out, stages: [...merged, ...wholes] };
        }
    }
    return out;
}

// ── Form ↔ step shape helpers ──────────────────────────────────────────

export function defaultLabelPlaceholder(step) {
    if (step.type === 'integration_action') return step.tool || step.type;
    if (step.type === 'trigger') return defaultTriggerLabel(step.kind || 'manual');
    return step.type;
}

/**
 * The per-type branches. Everything that is NOT per-type — today just
 * `retry` — is added by extractFormState below, so a cross-cutting field is
 * added once instead of being pasted into eighteen object literals and
 * forgotten in five of them. That is how the loop toggle ended up shipped on
 * one step type and missing on five (C12/C16/C18).
 */
function extractTypeFormState(step) {
    if (!step) return {};
    const base = { label: step.label || '', icon: step.icon || '' };
    if (step.type === 'trigger') {
        const kind = step.kind || 'manual';
        return {
            ...base,
            kind,
            scheduleCron: step.schedule?.cron || '',
            scheduleTz:   step.schedule?.tz || 'Europe/Amsterdam',
            // Empty defaults: a fresh app_event trigger has no provider until
            // AppEventFields auto-snaps to the first AVAILABLE one (dynamic,
            // catalog-driven — a hardcoded 'gmail' could be unavailable).
            appProvider:  step.appEvent?.provider || '',
            appEventName: step.appEvent?.event || '',
            filter:       step.appEvent?.filter || {},
            // Hosted form (kind === 'form'). Kept as ONE object so the editor
            // can patch title/fields/theme without five parallel draft keys.
            form:         step.form && typeof step.form === 'object' ? step.form : null,
            // Agent trigger (kind === 'agent_call').
            toolName:     step.toolName || '',
            description:  step.description || '',
            // params is shared between layer_input (declared inline) and
            // agent_call (derived from the persisted JSON Schema).
            params:       kind === 'agent_call'
                ? schemaToParams(step.parametersSchema)
                : (Array.isArray(step.params) ? step.params : []),
        };
    }
    if (step.type === 'ai_step') {
        return {
            ...base,
            prompt: step.prompt || '',
            systemPrompt: step.systemPrompt || '',
            modelTier: step.modelTier || 'auto',
            allowTools: !!step.allowTools,
            // Explicit per-tool allowlist (function names). `null` = not set:
            // combined with allowTools it means the legacy "all permitted tools".
            tools: Array.isArray(step.tools) ? step.tools : null,
            inputs: step.inputs || {},
            outputFields: schemaToFields(step.outputSchema),
            // Knowledge Base grounding (BFSF-410) — always an array, never null:
            // unlike `tools` there is no legacy "unset vs empty" distinction to
            // preserve here, so the draft mirrors the persisted shape exactly.
            knowledgeBaseIds: Array.isArray(step.knowledgeBaseIds) ? step.knowledgeBaseIds : [],
            // R2 — who does the thinking, and what they may do here. Like
            // knowledgeBaseIds and unlike `tools`, all three are ALWAYS a
            // concrete value: there is no legacy "unset means everything" to
            // preserve, so an absent field reads as "no agent, no skills, no
            // permissions" and reads that way in every direction.
            agentId: typeof step.agentId === 'string' && step.agentId.trim() ? step.agentId.trim() : null,
            skillIds: readSkillIds(step.skillIds),
            // The agent's own skills switched off for THIS step (handoff 5).
            disabledAgentSkillIds: readSkillIds(step.disabledAgentSkillIds),
            agentPermissions: readAgentPermissions(step.agentPermissions),
            // "Run once per item" — the inspector rendered the tick, but the
            // round-trip dropped it in BOTH directions for ai_step (C12).
            forEach: step.forEach || null,
        };
    }
    if (step.type === 'integration_action') {
        return {
            ...base,
            tool: step.tool || '',
            appId: step.appId || null,
            sideEffect: step.sideEffect ?? null,
            inputs: step.inputs || {},
            forEach: step.forEach || null,
            // "Ask this app only once per run" — the toggle shipped, the
            // round-trip did not: without this key the draft and the baseline
            // both lacked it, so flushNow's buildPatch comparison found them
            // equal and returned without calling onPatch at all. The tick
            // showed, nothing reached the server, reopening the node showed it
            // off again.
            askOnce: normalizeAskOnce(step.askOnce),
        };
    }
    // If / Switch / Filter are ONE node in the editor (see flow/routeModel.js):
    // the form edits a single `route` model and picks the runtime type that
    // expresses it, so all three share this branch.
    if (ROUTE_STEP_TYPES.has(step.type)) return { ...base, route: readRoute(step) };
    // Check / Hide / Check + Hide / Reveal are ONE node too (flow/privacyModel.js),
    // same shape of translation: one `privacy` model over three runtime types.
    if (PRIVACY_STEP_TYPES.has(step.type)) return { ...base, privacy: readPrivacy(step) };
    if (step.type === 'loop')         return {
        ...base,
        overRef: step.overRef || '',
        // Display truth == persisted truth (C9): the inspector always SHOWED
        // "item" while an absent itemVar persisted '' — activation stayed
        // blocked by loop.itemVar_missing on a value the user could see.
        itemVar: step.itemVar || 'item',
        maxIterations: step.maxIterations ?? 100,
        batchSize: step.batchSize ?? 1,
        body: Array.isArray(step.body) ? step.body : [],
    };
    // `inputs` rides along because the RUNNER has always read it
    // (execOutbound execCode resolves them before the isolate exists) and the
    // validator even tells the author to use them — "pass the value in through
    // `inputs`" is the hint on code.secret_keys_unsupported — while no screen
    // could set one. codeFields.jsx has shipped the table for exactly this,
    // gated on a probe that asks whether the round trip carries `inputs`
    // rather than assuming it; the probe is what turns it on.
    if (step.type === 'code')         return { ...base, code: step.code || '', inputs: step.inputs || {}, allowedHosts: Array.isArray(step.allowedHosts) ? step.allowedHosts : [], forEach: step.forEach || null };
    // `channels` rides along now that the form can edit it (BFSF-350) — it was
    // runner-honoured but form-invisible, so a step's delivery target could
    // only be set through the JSON tab.
    if (step.type === 'notification') return { ...base, title: step.title || '', body: step.body || '', channels: Array.isArray(step.channels) ? step.channels : null, forEach: step.forEach || null };
    if (step.type === 'http_request') return {
        ...base,
        url: step.url || '',
        method: step.method || 'GET',
        headers: step.headers && typeof step.headers === 'object' ? step.headers : {},
        body: step.body || '',
        // Structured query parameters; null = the section is off.
        query: step.query && typeof step.query === 'object' ? step.query : null,
        timeoutMs: typeof step.timeoutMs === 'number' ? step.timeoutMs : 10_000,
        blockPrivateTargets: step.blockPrivateTargets !== false,
        parseResponse: step.parseResponse || 'auto',
        forEach: step.forEach || null,
        // Saved HTTP credential reference — only the opaque connectionId lives
        // in the definition; the secret stays in the org vault.
        auth: (step.auth && typeof step.auth === 'object' && step.auth.connectionId)
            ? { connectionId: step.auth.connectionId }
            : null,
        // Carried even though no editor writes it yet: a hand-edited or
        // imported definition can already hold one, and a form that extracts
        // nothing here would strip it on the next unrelated save.
        askOnce: normalizeAskOnce(step.askOnce),
        // "Remember answers in a table" — the VISIBLE tier, an independent tick
        // from askOnce. Same round-trip rule: a definition that already carries
        // one must survive an unrelated save.
        cacheInto: normalizeCacheInto(step.cacheInto),
    };
    if (step.type === 'generate_document') return {
        ...base,
        content: step.content || '',
        contentFormat: step.contentFormat === 'html' ? 'html' : 'markdown',
        format: step.format === 'docx' ? 'docx' : 'pdf',
        title: step.title || '',
        fileName: step.fileName || '',
        expiresInDays: Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : 7,
    };
    if (step.type === 'slide') {
        // The visual picker is a VIEW over the stored fields: a chart object →
        // chart, stats → stats, an image → image, layout timeline → timeline.
        const chart = step.chart && typeof step.chart === 'object' && !Array.isArray(step.chart) ? step.chart : null;
        const chartData = chart ? (typeof chart.data === 'string' ? chart.data : (chart.data !== undefined ? JSON.stringify(chart.data) : '')) : '';
        const stats = Array.isArray(step.stats) ? step.stats.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : (typeof step.stats === 'string' ? step.stats : '');
        const visual = chart || typeof step.chart === 'string' ? 'chart' : (stats ? 'stats' : (step.image ? 'image' : (step.layout === 'timeline' ? 'timeline' : 'none')));
        return {
            ...base,
            title: step.title || '',
            content: step.content || '',
            notes: step.notes || '',
            image: step.image || '',
            layout: step.layout || 'auto',
            visual,
            chartType: chart ? (chart.type || 'column') : (typeof step.chart === 'string' ? step.chart : 'column'),
            chartData,
            chartLabels: chart && typeof chart.labels === 'string' ? chart.labels : '',
            chartValues: chart && typeof chart.values === 'string' ? chart.values : '',
            chartStacked: !!(chart && chart.stacked),
            chartUnit: chart && typeof chart.unit === 'string' ? chart.unit : '',
            stats,
            style: step.style === 'accent' || step.style === 'dark' ? step.style : '',
            forEach: step.forEach || null,
        };
    }
    if (step.type === 'presentation') return {
        ...base,
        // `slides` has two faces in the editor — ONE source (a template) or a
        // LIST of references — and one shape in the step. The mode follows
        // the stored shape, so an AI-built list opens as a list.
        slidesMode: Array.isArray(step.slides) ? 'list' : 'source',
        slides: typeof step.slides === 'string' ? step.slides : '',
        slideRows: Array.isArray(step.slides) ? step.slides.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))) : [],
        title: step.title || '',
        subtitle: step.subtitle || '',
        fileName: step.fileName || '',
        format: step.format === 'pdf' ? 'pdf' : 'pptx',
        houseStyle: step.houseStyle !== false,
        // The look: '' means "the house style decides".
        preset: step.preset || '',
        accent: step.accent || '',
        background: step.background || '',
        font: step.font || '',
        titleFont: step.titleFont || '',
        coverStyle: step.coverStyle || '',
        tableStyle: step.tableStyle || '',
        logo: step.logo || '',
        logoPlacement: step.logoPlacement || '',
        footerText: step.footerText || '',
        // Three states: '' follows the house style, true/false overrides it.
        slideNumbers: typeof step.slideNumbers === 'boolean' ? String(step.slideNumbers) : '',
        template: step.template === 'none' ? 'none' : '',
        saveCopy: step.saveCopy === true,
        copyName: step.copyName || '',
        expiresInDays: Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : 7,
    };
    if (step.type === 'fill_document') return {
        ...base,
        documentId: step.documentId || '',
        documentVersionId: step.documentVersionId || '',
        sectionOverrides: { ...(step.sectionOverrides || {}) },
        // The picker writes the NAME alongside the id so the card and the
        // header can say which document without a fetch. It is a cache, never
        // a second source of truth: the runner resolves the id.
        documentName: step.documentName || '',
        // A plain object of placeholder → template string. Rebuilt wholesale on
        // save (see the patch below), so a placeholder the person removed from
        // the document does not keep a value nobody can see.
        values: (step.values && typeof step.values === 'object' && !Array.isArray(step.values)) ? { ...step.values } : {},
        fileName: step.fileName || '',
        // Only a presentation document reads it; '' = the default (.pptx).
        format: step.format === 'pdf' ? 'pdf' : (step.format === 'pptx' ? 'pptx' : ''),
        saveCopy: step.saveCopy === true,
        copyName: step.copyName || '',
        expiresInDays: Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : 7,
    };
    if (step.type === 'data_extraction') return {
        ...base,
        // An absent source opens as an EMPTY REF, not an empty literal: the
        // field then starts in expression mode, so a value dragged in lands as
        // the bare `{ kind: 'ref', path }` the runtime and the fan-out chooser
        // both want, rather than as a `{{…}}` template string.
        source: isEmptyExtractionSource(step.source) ? { kind: 'ref', path: '' } : step.source,
        // ONE blank row when the step has none, so the panel never opens on
        // nothing but an "Add field" link. The row is draft-only: buildPatch
        // drops a nameless row (an INTEGRITY error server-side), and the sync
        // re-seeds it from here the moment the list comes back empty.
        fields: readExtractionFields(step.fields),
        instructions: typeof step.instructions === 'string' ? step.instructions : '',
        forEach: step.forEach || null,
    };
    // Flowlets (inline — contract derives from rootDefinition, not the step)
    if (step.type === 'call_layer')   return { ...base, inputs: step.inputs || {} };
    // Steps (external — contract derives from the catalog, not the step)
    if (step.type === 'call_block')   return { ...base, inputs: step.inputs || {} };
    if (step.type === 'layer_output') return { ...base, fields: step.fields || {} };
    // n8n-style utility nodes
    if (step.type === 'set')          return {
        ...base,
        fields: step.fields || {},
        forEach: step.forEach || null,
        // null = single mode; a string ('' allowed = source not picked yet) =
        // list mode. Mirrors the switch presence convention (routeModel.js) —
        // the mode is never stored, only derived from the key being there.
        arrayRef: typeof step.arrayRef === 'string' ? step.arrayRef : null,
        maxItems: typeof step.maxItems === 'number' ? step.maxItems : '',
        operations: Array.isArray(step.operations) ? step.operations : [],
    };
    if (step.type === 'parse_json')   return {
        ...base,
        sourceRef: step.sourceRef || '',
        itemsRef: step.itemsRef || '',
        mode: step.mode === 'ai' ? 'ai' : 'paths',
        fields: Array.isArray(step.fields) ? step.fields : [],
    };
    if (step.type === 'datetime') {
        // A whole column saved in "Input date" without `arrayRef` runs as
        // list mode (BFSF-375), so the editor opens it as list mode too.
        const dt = { ...step, ...impliedListMode(step) };
        return {
            ...base,
            op: dt.op || 'now',
            input: dt.input || '',
            input2: dt.input2 || '',
            amount: typeof dt.amount === 'number' ? dt.amount : 0,
            format: dt.format || 'yyyy-MM-dd HH:mm',
            part: dt.part || 'year',
            unit: dt.unit || 'days',
            // `null` = single date, a string (even '') = list mode. Same
            // present-or-absent convention the set node uses for its own switch.
            arrayRef: typeof dt.arrayRef === 'string' ? dt.arrayRef : null,
            target: dt.target || '',
        };
    }
    if (step.type === 'wait')         return { ...base, seconds: typeof step.seconds === 'number' ? step.seconds : 5 };
    if (step.type === 'approval') {
        return {
            ...base,
            prompt: step.prompt || '',
            // Flattened for the form, re-nested by buildPatch. The NESTED
            // value is read first and the legacy top-level one second, in the
            // engine's own precedence order — an editor that showed 7 days
            // while the run enforced 2 would be worse than showing nothing.
            expiresInHours: typeof step.approval?.expiresInHours === 'number' ? step.approval.expiresInHours
                : (typeof step.expiresInHours === 'number' ? step.expiresInHours : 168),
            // The rich half. Kept as the persisted shapes — the editor's rows
            // edit them in place and buildPatch re-normalizes.
            assignee: (step.approval?.assignee && typeof step.approval.assignee === 'object') ? step.approval.assignee : null,
            details: step.approval?.details || '',
            attachments: Array.isArray(step.approval?.attachments) ? step.approval.attachments : [],
            approvalFields: Array.isArray(step.approval?.fields) ? step.approval.fields : [],
            // v2 clocks: '' = off (a reminder is opt-in, unlike the deadline).
            remindAfterHours: typeof step.approval?.remindAfterHours === 'number' ? step.approval.remindAfterHours : '',
            escalateTo: (step.approval?.escalateTo && typeof step.approval.escalateTo === 'object') ? step.approval.escalateTo : null,
            escalateAfterHours: typeof step.approval?.escalateAfterHours === 'number' ? step.approval.escalateAfterHours : '',
            // Panel: seats ({userId}|{groupId}), how votes resolve, and the
            // optional final sign-off. Empty array = single-approver mode.
            approvers: Array.isArray(step.approval?.approvers) ? step.approval.approvers : [],
            rule: ['all', 'first', 'quorum'].includes(step.approval?.rule) ? step.approval.rule : 'all',
            quorum: typeof step.approval?.quorum === 'number' ? step.approval.quorum : 2,
            finalApprover: (step.approval?.finalApprover && typeof step.approval.finalApprover === 'object') ? step.approval.finalApprover : null,
            // The stage CHAIN. Kept as the persisted array so the editor's
            // rows edit the very objects that were saved — in particular each
            // stage's `key`, which is what already-cast votes are filed under.
            // Rebuilding the keys here (or anywhere positional) would orphan
            // the votes of a stage that already ran the moment the author
            // reordered or renamed one.
            stages: Array.isArray(step.approval?.stages) ? step.approval.stages : [],
        };
    }
    if (step.type === 'stop_error')   return { ...base, message: step.message || '' };
    // `return_to_app` — de drie effectvelden plus de terugvalkeuze. Ze worden
    // PLATGESLAGEN zodat elk formulierveld zijn eigen sleutel heeft (een
    // genest object in de draft laat één toetsaanslag het hele object
    // vervangen); writeStepPatch bouwt de geneste vorm terug op.
    if (step.type === 'return_to_app') {
        return {
            ...base,
            navigateScreenId: step.navigateTo?.screenId || '',
            navigateRecordRef: step.navigateTo?.recordRef || '',
            toastMessage: step.toast?.message || '',
            toastTone: step.toast?.tone || 'info',
            refresh: step.refresh || '',
            // Ontbrekend versmalt naar 'stay' — hetzelfde antwoord dat de
            // runner geeft als het veld leeg is.
            onError: step.onError === 'errorScreen' ? 'errorScreen' : 'stay',
        };
    }
    // guard / tokenize / untokenize are handled by the unified `privacy` branch
    // above (flow/privacyModel.js). `categories` and `confidence` stay absent
    // when unset there too: undefined means "inherit the org's Privacy Shield",
    // and defaulting them would freeze today's policy into the step and
    // silently stop following the organisation.
    if (step.type === 'form_page') {
        return {
            ...base,
            mode: step.mode === 'ending' ? 'ending' : 'input',
            // `null` is meaningful inside the declaration (theme: null =
            // inherit the trigger's), so the whole object is passed through
            // rather than defaulted here.
            form: step.form && typeof step.form === 'object' ? step.form : null,
            waitSeconds: typeof step.waitSeconds === 'number' ? step.waitSeconds : 3600,
        };
    }
    // Collection ops all expose the optional input cap (C19 — `maxItems` was
    // read by the runner and validated by the server but editable only via
    // the raw JSON view). '' = unset.
    const maxItems = typeof step.maxItems === 'number' ? step.maxItems : '';
    if (step.type === 'limit')        return { ...base, arrayRef: step.arrayRef || '', count: typeof step.count === 'number' ? step.count : 10, mode: step.mode || 'first', maxItems };
    if (step.type === 'dedupe')       return { ...base, arrayRef: step.arrayRef || '', keyField: step.keyField || '', maxItems };
    if (step.type === 'flatten')      return { ...base, ...flattenDraft(step), maxItems };
    if (step.type === 'aggregate')    return { ...base, arrayRef: step.arrayRef || '', field: step.field || '', maxItems };
    if (step.type === 'summarize')    return { ...base, arrayRef: step.arrayRef || '', field: step.field || '', op: step.op || 'sum', maxItems };
    // `where` and `values` are cloned, not shared: the editor edits the draft in
    // place, and handing it the saved step's own arrays would mutate the
    // definition before anyone pressed save.
    if (step.type === 'datatable') {
        return {
            ...base,
            // Carried since K10. Without it the editor's Iteration toggle read
            // as OFF on a step that had one, and the first save dropped it.
            forEach: step.forEach || null,
            datatableId: step.datatableId || '',
            op: step.op || 'find_rows',
            where: Array.isArray(step.where) ? step.where.map(w => ({ ...w })) : [],
            values: (step.values && typeof step.values === 'object' && !Array.isArray(step.values)) ? { ...step.values } : {},
            matchColumn: step.matchColumn || '',
            limit: typeof step.limit === 'number' ? step.limit : 50,
        };
    }
    if (step.type === 'knowledge_write') {
        // All three are `{{…}}` template STRINGS, the shape TemplateField edits
        // and the shape the runner interpolates — never binding objects.
        return {
            ...base,
            forEach: step.forEach || null,
            knowledgeBaseId: step.knowledgeBaseId || '',
            title: typeof step.title === 'string' ? step.title : '',
            content: typeof step.content === 'string' ? step.content : '',
            sourceUri: typeof step.sourceUri === 'string' ? step.sourceUri : '',
            nearDuplicateStrategy: step.nearDuplicateStrategy || 'skip',
        };
    }
    return base;
}

/**
 * Translate the form draft back into the persisted-step shape. We only
 * include keys that this form actually edits — everything else (id,
 * outputSchema, side-effect flag, etc.) is preserved by the inspector's
 * patch-merge.
 */
export function extractFormState(step) {
    const state = extractTypeFormState(step);
    // Present as a KEY even when unset, because that presence is what the
    // editor reads to decide whether the row may be offered at all (see
    // RetrySection). `null` is off; `{ max: 0 }` is the runner's own off and
    // reads the same, without being rewritten on the way through.
    if (step && RETRY_FORM_TYPES.has(step.type)) state.retry = normalizeRetry(step.retry) || null;
    return state;
}

export function buildPatch(step, draft) {
    const patch = { label: draft.label || null, icon: draft.icon || null };
    // Lock a field against AI auto-naming once the user sets it by hand. Only
    // touch the flag when the value actually changed in this edit, so re-saving
    // an AI-suggested value doesn't silently lock it. Clearing a field (empty)
    // unlocks it so the auto-namer can fill it again.
    if ((draft.label || '') !== (step.label || '')) patch.labelManual = draft.label ? true : null;
    if ((draft.icon || '') !== (step.icon || '')) patch.iconManual = draft.icon ? true : null;
    // …but a trigger label that is exactly the kind's generated name never
    // counts as hand-picked: the kind switcher writes it (BFSF-339), and
    // locking it there would freeze the node at whatever kind it passed
    // through and take it away from the AI auto-namer too.
    if (step.type === 'trigger' && draft.label && draft.label === defaultTriggerLabel(draft.kind || 'manual')) {
        patch.labelManual = null;
    }

    if (step.type === 'trigger') {
        patch.kind = draft.kind || 'manual';
        // Sibling nulling for the form declaration is unconditional: switching
        // a trigger away from `form` must not leave a stale form behind that a
        // later switch back would silently resurrect with old fields.
        patch.form = draft.kind === 'form' ? (draft.form || null) : null;
        // Preserve any existing schedule/appEvent objects so we don't
        // wipe sibling fields the form doesn't know about.
        if (draft.kind === 'schedule') {
            patch.schedule = { ...(step.schedule || {}), cron: draft.scheduleCron || '', tz: draft.scheduleTz || 'Europe/Amsterdam' };
            patch.appEvent = null;
        } else if (draft.kind === 'app_event') {
            const cleanedFilter = stripUndefined(draft.filter || {});
            patch.appEvent = {
                ...(step.appEvent || {}),
                provider: draft.appProvider || '',
                event: draft.appEventName || '',
                filter: Object.keys(cleanedFilter).length ? cleanedFilter : null,
            };
            patch.schedule = null;
        } else if (draft.kind === 'agent_call') {
            // Exposed as a function tool; the params-list becomes a JSON Schema.
            patch.toolName = (draft.toolName || '').trim() || null;
            patch.description = (draft.description || '').trim() || null;
            patch.parametersSchema = paramsToSchema(draft.params);
            patch.schedule = null;
            patch.appEvent = null;
        } else if (draft.kind === 'form') {
            // patch.form is already set above; the URL token deliberately lives
            // in automation_form_pages, NOT here, so an export/import/duplicate
            // can never clone a live public URL.
            patch.schedule = null;
            patch.appEvent = null;
        } else if (draft.kind === 'layer_input' || draft.kind === 'app_trigger') {
            // Declared typed params become trigger.output.<name> — the flowlet
            // input contract, and the app trigger's Studio-App input contract
            // (server contract: automation/appTriggerContract.js).
            patch.params = Array.isArray(draft.params)
                ? draft.params.filter(p => p && p.name).map(p => ({
                    name: p.name, type: p.type || 'string', required: !!p.required,
                    ...(p.description ? { description: p.description } : {}),
                }))
                : [];
            patch.schedule = null;
            patch.appEvent = null;
        } else {
            patch.schedule = null;
            patch.appEvent = null;
        }
    }

    if (step.type === 'ai_step') {
        patch.prompt = draft.prompt || '';
        patch.systemPrompt = draft.systemPrompt?.trim() ? draft.systemPrompt.trim() : null;
        patch.modelTier = draft.modelTier || 'auto';
        // When the user has made an explicit tool selection, persist the
        // allowlist and derive allowTools from it (the runner only loads tools
        // when allowTools is on). Untouched legacy steps keep `tools` absent and
        // their original allowTools, so "all permitted tools" behaviour stays.
        if (Array.isArray(draft.tools)) {
            patch.tools = draft.tools;
            patch.allowTools = draft.tools.length > 0;
        } else {
            patch.allowTools = !!draft.allowTools;
        }
        patch.inputs = sanitizeInputs(draft.inputs || {});
        patch.outputSchema = fieldsToSchema(draft.outputFields || []);
        patch.knowledgeBaseIds = Array.isArray(draft.knowledgeBaseIds)
            ? draft.knowledgeBaseIds.filter((id) => typeof id === 'string' && id)
            : [];
        // R2. `agentPermissions` is REBUILT here as well as read: the patch is
        // what reaches the server, and sending a half-object would let a key
        // arrive as `undefined` — the shape this whole feature refuses. The
        // skill list keeps the author's ORDER (the first is the leading skill)
        // and is cut at the cap here so the editor can say which ones would be
        // dropped, instead of the runner dropping them silently.
        patch.agentId = typeof draft.agentId === 'string' && draft.agentId.trim() ? draft.agentId.trim() : null;
        patch.skillIds = readSkillIds(draft.skillIds).slice(0, MAX_AI_STEP_SKILL_IDS);
        patch.agentPermissions = readAgentPermissions(draft.agentPermissions);
        // Only meaningful with an agent: without one there are no agent skills
        // to switch off, and a stale list would silently apply to the next agent.
        patch.disabledAgentSkillIds = patch.agentId ? readSkillIds(draft.disabledAgentSkillIds) : [];
        applyForEachPatch(patch, step, draft); // C12 — was dropped both ways
    }
    if (step.type === 'integration_action') {
        patch.inputs = sanitizeInputs(draft.inputs || {});
        // Operation switcher (single-node, n8n-style): the node's tool can
        // change in place. Persist tool + appId + the authoritative sideEffect
        // flag so the badge, dry-run handling, and downstream schema stay
        // correct after a switch. Always send tool (unchanged on normal edits).
        patch.tool = draft.tool || step.tool || '';
        if (draft.appId || step.appId) patch.appId = draft.appId || step.appId;
        if (draft.sideEffect != null) patch.sideEffect = draft.sideEffect;
        applyForEachPatch(patch, step, draft);
        applyAskOncePatch(patch, step, draft);
    }
    // If / Switch / Filter — one model, one writer. writeRoute also decides
    // WHICH runtime type expresses the model, so `patch.type` can change here
    // (the inspector's merge re-points the node's edges — flow/routeEdges.js).
    if (ROUTE_STEP_TYPES.has(step.type)) Object.assign(patch, writeRoute(draft.route || readRoute(step)));
    // Privacy Shield — same contract as the route model above: writePrivacy
    // picks the runtime type (guard / tokenize / untokenize) that expresses the
    // chosen mode, so `patch.type` can change here too.
    if (PRIVACY_STEP_TYPES.has(step.type)) Object.assign(patch, writePrivacy(draft.privacy || readPrivacy(step)));
    if (step.type === 'loop') {
        patch.overRef = draft.overRef || '';
        // Never persist '' — the inspector displays 'item' as the effective
        // value, so persist exactly that (C9).
        patch.itemVar = String(draft.itemVar || '').trim() || 'item';
        patch.maxIterations = clamp(Number(draft.maxIterations) || 100, 1, 1000);
        patch.batchSize = clamp(Number(draft.batchSize) || 1, 1, 1000);
        patch.body = Array.isArray(draft.body) ? draft.body : [];
    }
    if (step.type === 'code') {
        patch.code = draft.code || '';
        // BOTH directions or neither. extractFormState carrying `inputs`
        // while this did not would lose every edit; this carrying them while
        // extractFormState did not would ship `inputs: {}` on every unrelated
        // save and wipe the step's real inputs. codeFields.jsx's probe checks
        // both for that reason.
        patch.inputs = sanitizeInputs(draft.inputs || {});
        // Where ctx.http may go besides the hosts the code names (the
        // runner's host list, core/automationRunner/codeStepGuard.js).
        const hosts = (Array.isArray(draft.allowedHosts) ? draft.allowedHosts : []).filter(h => typeof h === 'string' && h.trim());
        if (hosts.length || Array.isArray(step.allowedHosts)) patch.allowedHosts = hosts;
        applyForEachPatch(patch, step, draft); // C16/C18
    }
    if (step.type === 'notification') {
        patch.title = draft.title || '';
        patch.body = draft.body || '';
        // Omitted rather than defaulted when untouched: the runner already
        // treats a missing `channels` as the bell, and writing one in would
        // dirty every notification step the user merely opened.
        if (Array.isArray(draft.channels)) patch.channels = draft.channels;
        applyForEachPatch(patch, step, draft); // C18 — runner honours it, form never exposed it
    }
    if (step.type === 'http_request') {
        patch.url = draft.url || '';
        patch.method = (draft.method || 'GET').toUpperCase();
        patch.headers = draft.headers && typeof draft.headers === 'object' ? draft.headers : {};
        patch.body = draft.body || '';
        // Off (null) is stored as absence, so a step without parameters stays as it was.
        patch.query = draft.query && typeof draft.query === 'object' ? draft.query : undefined;
        patch.timeoutMs = clamp(Number(draft.timeoutMs) || 10_000, 1000, 60_000);
        // Optional per-step security toggle (default true = blocked) — not
        // mandatory, but always persisted explicitly so the definition
        // never depends on the "defaults true" convention silently.
        patch.blockPrivateTargets = draft.blockPrivateTargets !== false;
        // 'auto' is the default, so it is stored as absence rather than a value.
        patch.parseResponse = ['never', 'always'].includes(draft.parseResponse) ? draft.parseResponse : undefined;
        // Credential reference — explicit null clears it in the definition
        // (same "persist explicitly" style as blockPrivateTargets).
        patch.auth = draft.auth?.connectionId ? { connectionId: draft.auth.connectionId } : null;
        applyForEachPatch(patch, step, draft);
        applyAskOncePatch(patch, step, draft);
        applyCacheIntoPatch(patch, step, draft);
    }
    if (step.type === 'generate_document') {
        patch.content = draft.content || '';
        patch.contentFormat = draft.contentFormat === 'html' ? 'html' : 'markdown';
        patch.format = draft.format === 'docx' ? 'docx' : 'pdf';
        patch.title = draft.title || '';
        patch.fileName = draft.fileName || '';
        // Clamp must match validate.js's expiry_range AND builderTools'
        // normalizePatchField, or the canvas and the AI disagree about what a
        // legal value is.
        patch.expiresInDays = clamp(Math.round(Number(draft.expiresInDays) || 7), 1, 90);
    }
    if (step.type === 'slide') {
        patch.title = draft.title || '';
        patch.content = draft.content || '';
        patch.notes = draft.notes || '';
        // Absent, not '', when nothing is set: the validator accepts a missing
        // image/layout and the runner reads absent layout as "pick one".
        patch.image = (draft.image || '').trim() || undefined;
        patch.layout = draft.layout && draft.layout !== 'auto' ? draft.layout : undefined;
        // The visual picker decides which stored field survives; the others
        // are cleared so a slide never carries two visuals at once.
        const visual = draft.visual || 'none';
        const chartData = (draft.chartData || '').trim();
        if (visual === 'chart' && (chartData || draft.chartType)) {
            let data = chartData;
            if (/^\s*[[{]/.test(chartData)) { try { data = JSON.parse(chartData); } catch { data = chartData; } }
            patch.chart = {
                type: draft.chartType || 'column',
                ...(chartData ? { data } : {}),
                ...((draft.chartLabels || '').trim() ? { labels: draft.chartLabels.trim() } : {}),
                ...((draft.chartValues || '').trim() ? { values: draft.chartValues.trim() } : {}),
                ...(draft.chartStacked ? { stacked: true } : {}),
                ...((draft.chartUnit || '').trim() ? { unit: draft.chartUnit.trim() } : {}),
            };
        } else {
            patch.chart = undefined;
        }
        patch.stats = visual === 'stats' && (draft.stats || '').trim() ? draft.stats.trim() : undefined;
        if (visual !== 'image') patch.image = undefined;
        if (visual === 'timeline') patch.layout = 'timeline';
        else if (patch.layout === 'timeline') patch.layout = undefined;
        patch.style = draft.style === 'accent' || draft.style === 'dark' ? draft.style : undefined;
        applyForEachPatch(patch, step, draft);
    }
    if (step.type === 'presentation') {
        if (draft.slidesMode === 'list') {
            // Blank rows are dropped; a row that reads as JSON (an inline
            // slide object) is kept as that object.
            patch.slides = (draft.slideRows || []).map((r) => (typeof r === 'string' ? r.trim() : r)).filter((r) => r !== '' && r !== null && r !== undefined)
                .map((r) => { if (typeof r === 'string' && /^\s*\{/.test(r)) { try { return JSON.parse(r); } catch { return r; } } return r; });
        } else {
            patch.slides = draft.slides || '';
        }
        patch.title = draft.title || '';
        patch.subtitle = draft.subtitle || '';
        patch.fileName = draft.fileName || '';
        patch.format = draft.format === 'pdf' ? 'pdf' : 'pptx';
        patch.houseStyle = draft.houseStyle !== false;
        // Look fields travel as a value or ABSENT — never '' — so a cleared
        // choice hands the decision back to the house style.
        for (const k of ['preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logo', 'logoPlacement', 'footerText']) {
            const v = typeof draft[k] === 'string' ? draft[k].trim() : '';
            patch[k] = v || undefined;
        }
        patch.slideNumbers = draft.slideNumbers === 'true' ? true : (draft.slideNumbers === 'false' ? false : undefined);
        patch.template = draft.template === 'none' ? 'none' : undefined;
        patch.saveCopy = draft.saveCopy === true ? true : undefined;
        patch.copyName = draft.saveCopy === true && draft.copyName ? draft.copyName : undefined;
        // Same clamp as generate_document: canvas and AI must agree.
        patch.expiresInDays = clamp(Math.round(Number(draft.expiresInDays) || 7), 1, 90);
    }
    if (step.type === 'fill_document') {
        patch.documentId = draft.documentId || '';
        if (draft.documentVersionId) patch.documentVersionId = draft.documentVersionId;
        patch.sectionOverrides = { ...(draft.sectionOverrides || {}) };
        patch.documentName = draft.documentName || '';
        // Blank values are dropped rather than written: an empty string and an
        // absent binding fill the same nothing, and keeping the key would make
        // "which placeholders are still unbound" unanswerable from the step.
        const values = {};
        for (const [k, v] of Object.entries(draft.values || {})) {
            const val = typeof v === 'string' ? v.trim() : v;
            if (val !== '' && val !== undefined && val !== null) values[k] = val;
        }
        patch.values = values;
        patch.fileName = draft.fileName || '';
        patch.format = draft.format === 'pdf' || draft.format === 'pptx' ? draft.format : undefined;
        patch.saveCopy = draft.saveCopy === true;
        patch.copyName = draft.saveCopy === true ? (draft.copyName || '') : '';
        // Same clamp as generate_document, and for the same reason: the canvas
        // and the AI must agree about what a legal value is.
        patch.expiresInDays = clamp(Math.round(Number(draft.expiresInDays) || 7), 1, 90);
    }
    if (step.type === 'data_extraction') {
        // Absent, not null, when nothing is bound: `typeof null === 'object'`
        // is exactly the shape a "must be a binding object" rule lets through
        // and then trips over. `source_missing` is a completeness code, so the
        // gap autosaves amber.
        patch.source = isEmptyExtractionSource(draft.source) ? undefined : draft.source;
        patch.fields = sanitizeExtractionFields(draft.fields);
        patch.instructions = (draft.instructions || '').slice(0, MAX_EXTRACTION_INSTRUCTIONS) || undefined;
        applyForEachPatch(patch, step, draft);
    }
    // Flowlets
    if (step.type === 'call_layer') {
        patch.inputs = sanitizeInputs(draft.inputs || {});
    }
    if (step.type === 'call_block') {
        patch.inputs = sanitizeInputs(draft.inputs || {});
    }
    if (step.type === 'layer_output') {
        patch.fields = sanitizeFieldMap(draft.fields || {});
    }
    // n8n-style utility nodes
    if (step.type === 'set') {
        patch.fields = sanitizeFieldMap(draft.fields || {});
        if (typeof draft.arrayRef === 'string') {
            // LIST MODE — the key's presence is the mode, so it's always sent.
            patch.arrayRef = draft.arrayRef;
            applyMaxItemsPatch(patch, draft);
            const ops = sanitizeOperations(draft.operations);
            patch.operations = ops.length ? ops : undefined;
            // Mutually exclusive with forEach (the validator errors on both);
            // an explicit null clears a legacy per-item setting on save.
            if (step.forEach) patch.forEach = null;
        } else {
            // SINGLE MODE — explicit undefined deletes the list-mode keys
            // after the patch-merge + JSON round-trip (the writeRoute idiom);
            // the changed-keys diff below drops the no-ops.
            patch.arrayRef = undefined;
            patch.operations = undefined;
            patch.maxItems = undefined;
            applyForEachPatch(patch, step, draft); // C16 — runner+validator allow it
        }
    }
    if (step.type === 'parse_json') {
        patch.sourceRef = draft.sourceRef || '';
        patch.itemsRef = draft.itemsRef || '';
        patch.mode = draft.mode === 'ai' ? 'ai' : 'paths';
        patch.fields = sanitizeParseJsonFields(draft.fields);
    }
    if (step.type === 'datetime') {
        patch.op = draft.op || 'now';
        patch.input = draft.input || undefined;
        patch.input2 = draft.input2 || undefined;
        patch.amount = typeof draft.amount === 'number' ? draft.amount : undefined;
        patch.format = draft.format || undefined;
        patch.part = draft.part || undefined;
        patch.unit = draft.unit || undefined;
        // undefined REMOVES the key, which is how the step leaves list mode.
        patch.arrayRef = typeof draft.arrayRef === 'string' ? draft.arrayRef : undefined;
        patch.target = typeof draft.arrayRef === 'string' ? (draft.target || undefined) : undefined;
    }
    if (step.type === 'wait')       patch.seconds = clamp(Number(draft.seconds) || 1, 1, 86400);
    if (step.type === 'approval') {
        patch.prompt = draft.prompt || '';
        // Bounds AND unset-handling mirror clampApprovalHours /
        // normalizeApprovalConfig in server/automation/builderTools.js, so a
        // hand-built approval and an AI-built one are the same object.
        // The `|| 0` idiom used everywhere else in this file would be a bug
        // here: 0 is the meaningful value "no deadline", so an ABSENT field
        // must fall through to the 7-day default rather than collapsing into
        // an approval that never expires.
        const rawHours = draft.expiresInHours;
        const approvalCfg = {
            expiresInHours: (rawHours === null || rawHours === undefined || rawHours === '' || !Number.isFinite(Number(rawHours)))
                ? 168
                : clamp(Math.round(Number(rawHours)), 0, 720),
        };
        // The stage chain SUPERSEDES every legacy approver field. validate.js
        // refuses the combination outright (approval.stages_conflict) rather
        // than let someone believe they are in the chain and never be asked,
        // so with stages present the assignee / panel / final sign-off /
        // escalation are not written at all — the editor presents them as a
        // mode switch for exactly this reason.
        const chain = sanitizeApprovalStages(draft.stages);
        if (chain.length) approvalCfg.stages = chain;
        const a = chain.length ? null : draft.assignee;
        if (a && typeof a === 'object') {
            if (typeof a.userId === 'string' && a.userId.trim()) approvalCfg.assignee = { userId: a.userId.trim() };
            else if (typeof a.groupId === 'string' && a.groupId.trim()) approvalCfg.assignee = { groupId: a.groupId.trim() };
        }
        if (typeof draft.details === 'string' && draft.details.trim()) approvalCfg.details = draft.details;
        const atts = (Array.isArray(draft.attachments) ? draft.attachments : [])
            .filter(x => x && typeof x.binding === 'string' && x.binding.trim())
            .slice(0, 5)
            .map(x => ({ binding: x.binding, ...(x.label && x.label.trim() ? { label: x.label } : {}) }));
        if (atts.length) approvalCfg.attachments = atts;
        const qs = (Array.isArray(draft.approvalFields) ? draft.approvalFields : [])
            .filter(f => f && typeof f === 'object' && (f.name || f.label))
            .slice(0, 20);
        if (qs.length) approvalCfg.fields = qs;
        // Panel mirrors normalizeApprovalConfig: seats cleaned to exactly one
        // of userId/groupId, deduped, capped at 10; a panel present drops the
        // single assignee and (below) the escalation — the final approver is
        // the panel's takeover mechanism.
        const cleanSeat = (x) => {
            if (!x || typeof x !== 'object') return null;
            if (typeof x.userId === 'string' && x.userId.trim()) return { userId: x.userId.trim() };
            if (typeof x.groupId === 'string' && x.groupId.trim()) return { groupId: x.groupId.trim() };
            return null;
        };
        const seatKeySeen = new Set();
        const seats = chain.length ? [] : (Array.isArray(draft.approvers) ? draft.approvers : [])
            .map(cleanSeat)
            .filter(Boolean)
            .filter(seatObj => {
                const key = seatObj.userId ? `u:${seatObj.userId}` : `g:${seatObj.groupId}`;
                if (seatKeySeen.has(key)) return false;
                seatKeySeen.add(key);
                return true;
            })
            .slice(0, 10);
        if (seats.length) {
            approvalCfg.approvers = seats;
            delete approvalCfg.assignee;
            approvalCfg.rule = ['all', 'first', 'quorum'].includes(draft.rule) ? draft.rule : 'all';
            if (approvalCfg.rule === 'quorum') {
                const n = Math.round(Number(draft.quorum));
                approvalCfg.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seats.length) : Math.min(2, seats.length);
            }
        }
        const fa = chain.length ? null : cleanSeat(draft.finalApprover);
        if (fa) approvalCfg.finalApprover = fa;
        // Clocks mirror normalizeApprovalConfig: whole hours 1..720, and the
        // escalation is BOTH a target and a delay or nothing — half a config
        // must not persist as a control that silently does nothing.
        const hoursOrNull = (v) => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) && n >= 1 ? Math.min(n, 720) : null;
        };
        const remind = hoursOrNull(draft.remindAfterHours);
        if (remind) approvalCfg.remindAfterHours = remind;
        const et = draft.escalateTo;
        const escTarget = (et && typeof et === 'object')
            ? (typeof et.userId === 'string' && et.userId.trim() ? { userId: et.userId.trim() }
                : (typeof et.groupId === 'string' && et.groupId.trim() ? { groupId: et.groupId.trim() } : null))
            : null;
        const escAfter = hoursOrNull(draft.escalateAfterHours);
        if (escTarget && escAfter && !approvalCfg.approvers && !chain.length) {
            approvalCfg.escalateTo = escTarget;
            approvalCfg.escalateAfterHours = escAfter;
        }
        patch.approval = approvalCfg;
        // undefined REMOVES the key. One field owns the deadline: leaving a
        // legacy top-level expiresInHours behind would let the two disagree,
        // and the engine reads the nested one first.
        patch.expiresInHours = undefined;
    }
    if (step.type === 'stop_error') patch.message = draft.message || '';
    if (step.type === 'return_to_app') {
        // Een leeg veld betekent "doe dit niet", en dat is `null` — niet een
        // leeg object. `{ screenId: '' }` zou de validator een scherm laten
        // missen (`return_to_app.screen_missing`) terwijl de auteur juist zei
        // dat er niet genavigeerd hoeft te worden.
        const screenId = String(draft.navigateScreenId || '').trim();
        const recordRef = String(draft.navigateRecordRef || '').trim();
        patch.navigateTo = screenId ? { screenId, ...(recordRef ? { recordRef } : {}) } : null;
        const toastMessage = String(draft.toastMessage || '').trim();
        patch.toast = toastMessage ? { message: toastMessage, tone: draft.toastTone || 'info' } : null;
        patch.refresh = draft.refresh || null;
        patch.onError = draft.onError === 'errorScreen' ? 'errorScreen' : 'stay';
    }
    // guard / tokenize / untokenize: written by writePrivacy above. Keeping a
    // second writer here would fight it — the old one rebuilt `onFound` from
    // stop/mask alone and would strip the `tokenize` action that makes a guard
    // a Check + Hide step.
    if (step.type === 'form_page') {
        const ending = draft.mode === 'ending';
        patch.mode = ending ? 'ending' : 'input';
        patch.form = draft.form || null;
        // Clamps must match the server's (validate.js FORM_PAGE_MIN/MAX_WAIT_S
        // and builderTools' normalizePatchField), or a UI-built step and an
        // AI-built one would disagree. An ending page never waits.
        patch.waitSeconds = ending ? null : clamp(Number(draft.waitSeconds) || 3600, 60, 7 * 24 * 3600);
    }
    if (step.type === 'limit') {
        patch.arrayRef = draft.arrayRef || '';
        patch.count = Math.max(0, Math.floor(Number(draft.count) || 0));
        patch.mode = draft.mode === 'last' ? 'last' : 'first';
        applyMaxItemsPatch(patch, draft);
    }
    if (step.type === 'dedupe') {
        patch.arrayRef = draft.arrayRef || '';
        patch.keyField = draft.keyField?.trim() ? draft.keyField.trim() : undefined;
        applyMaxItemsPatch(patch, draft);
    }
    if (step.type === 'flatten') {
        Object.assign(patch, flattenPatch(draft));
        applyMaxItemsPatch(patch, draft);
    }
    if (step.type === 'aggregate') {
        patch.arrayRef = draft.arrayRef || '';
        patch.field = draft.field || '';
        applyMaxItemsPatch(patch, draft);
    }
    if (step.type === 'summarize') {
        patch.arrayRef = draft.arrayRef || '';
        patch.field = draft.field || '';
        patch.op = draft.op || 'sum';
        applyMaxItemsPatch(patch, draft);
    }
    if (step.type === 'datatable') {
        patch.datatableId = draft.datatableId || '';
        patch.op = draft.op || 'find_rows';
        // Drop half-written conditions rather than saving a row with no column:
        // the validator would flag it, but an empty row the user did not mean to
        // add is noise, not feedback.
        patch.where = (Array.isArray(draft.where) ? draft.where : []).filter(w => w && w.field);
        // Only the columns actually given a value are written. An empty binding
        // means "leave this column alone", not "write blank".
        const vals = (draft.values && typeof draft.values === 'object') ? draft.values : {};
        patch.values = Object.fromEntries(
            Object.entries(vals).filter(([, v]) => v !== undefined && v !== null && v !== ''),
        );
        patch.matchColumn = draft.matchColumn || '';
        if (typeof draft.limit === 'number' && Number.isFinite(draft.limit)) patch.limit = draft.limit;
        applyForEachPatch(patch, step, draft);
    }
    if (step.type === 'knowledge_write') {
        patch.knowledgeBaseId = draft.knowledgeBaseId || '';
        patch.title = draft.title || '';
        patch.content = draft.content || '';
        patch.sourceUri = draft.sourceUri || '';
        // 'skip' is the default and stays OFF the step, so a step saved from
        // the form is the same shape as one the AI builder produced.
        patch.nearDuplicateStrategy = (draft.nearDuplicateStrategy && draft.nearDuplicateStrategy !== 'skip')
            ? draft.nearDuplicateStrategy
            : undefined;
        applyForEachPatch(patch, step, draft);
    }
    if (RETRY_FORM_TYPES.has(step.type)) applyRetryPatch(patch, step, draft);
    // Send only the fields that ACTUALLY CHANGED vs the current step. The form
    // rebuilds every field for the step type on every save; sending all of
    // them would overwrite fields the user never touched — clobbering a
    // concurrent AI-builder edit to, say, the prompt while the user only
    // renamed the label. The *Manual flags are meta (not on the step) and are
    // only added when their value changed, so they're intentionally exempt.
    const META_KEYS = new Set(['labelManual', 'iconManual']);
    const changed = {};
    for (const k of Object.keys(patch)) {
        if (META_KEYS.has(k)) { changed[k] = patch[k]; continue; }
        if (!deepEqual(patch[k], step[k])) changed[k] = patch[k];
    }
    return changed;
}

/**
 * Step types whose "run once per item" (forEach) config the inspector edits.
 * Mirrors the runtime/validator allow-list (validate.js FOREACH_ALLOWED) —
 * the runner honoured forEach on all five, but the form only round-tripped
 * it for integration_action, silently dropping it everywhere else (C12/C16/
 * C18). http_request joined them once the validator stopped disagreeing with
 * the runtime about it: "one API call per row" is the shape the response
 * cache exists for.
 */
export const FOREACH_FORM_TYPES = new Set([
    'integration_action', 'ai_step', 'code', 'notification', 'set', 'http_request',
    // The two steps whose effect outlives the run. Both editors already
    // RENDERED the Iteration toggle and neither round-tripped it, so turning it
    // on looked like it worked and was gone on the next open — the same C12
    // bug this list was written to close, reopened by two later step types.
    'datatable', 'knowledge_write',
    // Fan-out over a list of documents ("one invoice per file") is the
    // extraction step's most common shape, so it round-trips from day one.
    'data_extraction',
]);

/** The well-formed `{ itemVar, overRef }` entries of a forEach's `parents`. */
function forEachParents(parents) {
    if (!Array.isArray(parents)) return [];
    return parents
        .filter(p => p && typeof p.itemVar === 'string' && p.itemVar && typeof p.overRef === 'string' && p.overRef)
        .map(p => ({ itemVar: p.itemVar, overRef: p.overRef }));
}

/**
 * One shared forEach persist rule: normalize when enabled, explicit null to
 * clear an existing one when the user toggles it off.
 */
function applyForEachPatch(patch, step, draft) {
    if (draft.forEach) {
        // `parents`: the outer lists a step over a list inside a list keeps
        // (mapping/deepenForEach.ts; the runner binds each item's outer item
        // under that name). Dropping them here unbound every field that still
        // reads the outer item, the moment the form saved.
        const parents = forEachParents(draft.forEach.parents);
        patch.forEach = {
            overRef: draft.forEach.overRef || '',
            itemVar: draft.forEach.itemVar || 'item',
            maxIterations: clamp(Number(draft.forEach.maxIterations) || 100, 1, 1000),
            ...(parents.length ? { parents } : {}),
        };
    } else if (step.forEach) {
        patch.forEach = null;
    }
}

/**
 * Step types whose "try again if this step fails" row the inspector edits.
 *
 * The SAME list is read in both directions — extractFormState puts `retry`
 * in the draft for these types and buildPatch persists it for these types —
 * because the two halves disagreeing is exactly the bug this file keeps
 * having to close (C12, C16, C18, the askOnce tick).
 *
 * `retry` is dispatched type-agnostically by execution.js, so the runner
 * honours it on ANY step. The list is narrower than that on purpose: it is
 * the steps that can fail for a reason a second attempt might not hit —
 * something over a network, or something an LLM provider is briefly too busy
 * to do. Types left out are left out for a reason rather than by omission:
 *   • `set` computes values from data already in hand, so try 2 produces
 *     exactly what try 1 produced. Same for the route and privacy types,
 *     which decide a path from that same data. It is FOREACH_FORM_TYPES
 *     minus `set` plus `slide` for that reason, not an oversight.
 *   • `trigger` never fails as a step — there is nothing to try again.
 *   • `loop`, `parallel` and the approval / wait steps own their own
 *     restart semantics; a retry wrapped around them would re-run bodies
 *     that already succeeded, which is the mistake §WS2.5 documents.
 */
export const RETRY_FORM_TYPES = new Set([
    'integration_action', 'ai_step', 'code', 'notification', 'http_request',
    'datatable', 'knowledge_write', 'data_extraction', 'slide',
]);

/**
 * `retry` in the one shape the runner reads: `{ max, backoffMs }`, where
 * `max` counts the attempts AFTER the first (execution.js loops
 * `for (i = 1; i <= retry.max; i++)` once the first attempt has failed).
 *
 * NOT CLAMPED, on purpose. The editor offers closed lists, so nothing it
 * writes can be out of range; a value outside them came from an AI-built or
 * hand-edited step, and snapping it here would rewrite an author's step on
 * the first unrelated save — the same rule PathField follows. `retry` has no
 * validator to appeal to either (grep automation/validate.js), so a silent
 * clamp would be the only record that the number changed.
 *
 * `backoffMs` is always emitted, 0 included, because the editor always writes
 * both keys: with two spellings for "no wait" (absent and 0) an unrelated
 * edit would keep flipping the step between them.
 *
 * `max <= 0` is the runner's own "do not retry" (`retry.max > 0` gates the
 * whole loop) and normalises to `undefined` — the one canonical off, which
 * drops out of the JSON after the patch merge.
 */
export function normalizeRetry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const max = Math.round(Number(value.max));
    if (!Number.isFinite(max) || max <= 0) return undefined;
    const backoff = Math.round(Number(value.backoffMs));
    return { max, backoffMs: Number.isFinite(backoff) && backoff > 0 ? backoff : 0 };
}

/**
 * Same shape as applyAskOncePatch, and the clear is `undefined` for the same
 * reason: off must have ONE spelling or unticking builds a patch deepEqual to
 * the ticked one and flushNow never calls the server.
 *
 * The clear is guarded on an EFFECTIVE retry, not merely on the key being
 * there. A step that stores `{ max: 0 }` is already off; clearing it would
 * put a key the author never touched into the patch, and the run history
 * would show a definition change that changed nothing.
 */
function applyRetryPatch(patch, step, draft) {
    const next = normalizeRetry(draft.retry);
    if (next !== undefined) patch.retry = next;
    else if (step.retry && Number(step.retry.max) > 0) patch.retry = undefined;
}

/**
 * Step types whose "ask this app only once per run" tick the inspector
 * round-trips. Mirrors the runtime's readers — execIntegrationAction today,
 * execOutbound next — so the form never carries a field the engine ignores.
 */
export const ASK_ONCE_FORM_TYPES = new Set(['integration_action', 'http_request']);

/**
 * `askOnce` in exactly the shapes the runtime reads, mirroring
 * server/automation/builderTools/stepEditing.js normalizeAskOnce so a
 * hand-ticked step and an AI-built one are the same object.
 *
 * `true` is the plain tick; `{ acrossRuns?, ttlSeconds? }` is that plus the
 * wider promise. An object with nothing recognised in it still means "ask
 * once" — the runner reads `!!step.askOnce`, so collapsing `{}` to off here
 * would silently switch a shipped setting off on an unrelated save. Anything
 * falsy normalises to `undefined`, the one canonical "off": with two spellings
 * for off, unticking would build a patch deepEqual to the ticked one and
 * flushNow would never call onPatch.
 *
 * ttlSeconds is NOT clamped, for the same reason the builder tool does not
 * clamp it: the validator's ask_once_ttl_range error is how the author finds
 * out, and a silent clamp teaches them nothing.
 */
export function normalizeAskOnce(value) {
    if (value === true) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    if (value.acrossRuns === true) out.acrossRuns = true;
    const ttl = Number(value.ttlSeconds);
    if (Number.isFinite(ttl)) out.ttlSeconds = Math.round(ttl);
    return Object.keys(out).length ? out : true;
}

/**
 * One shared askOnce persist rule, same shape as applyForEachPatch above with
 * one difference: the clear is `undefined`, never `null`.
 *
 * A persisted `null` reads as off everywhere today, but it leaves the key in
 * the definition — a fourth spelling of off beside absent, `false` and `{}`,
 * and the previous validator guard (`!== undefined && !== false`) walked one
 * straight into the write check and errored a step whose setting did nothing.
 * `undefined` survives the patch-merge and then drops out of the JSON, so off
 * has one shape: absent. Same key-removal idiom `set`/`datetime` use for
 * `arrayRef`.
 *
 * The `step.askOnce` guard keeps an already-off step byte-identical: merely
 * opening a node that stores `askOnce: false` must not rewrite the definition.
 */
function applyAskOncePatch(patch, step, draft) {
    const next = normalizeAskOnce(draft.askOnce);
    if (next !== undefined) patch.askOnce = next;
    else if (step.askOnce) patch.askOnce = undefined;
}

/**
 * `cacheInto` in the one shape the runtime reads, mirroring
 * server/automation/builderTools/stepBuilders.js normalizeCacheInto so a
 * hand-ticked step and an AI-built one are the same object.
 *
 * No table means OFF, full stop. A window with nothing to keep it in is a
 * setting that reads as configured and does nothing — which is the exact
 * failure the whole askOnce/cacheInto validator block exists to prevent.
 */
export function normalizeCacheInto(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const datatableId = typeof value.datatableId === 'string' ? value.datatableId.trim() : '';
    if (!datatableId) return undefined;
    const days = Number(value.maxAgeDays);
    return {
        datatableId,
        // NOT clamped, for the same reason ttlSeconds is not: the validator's
        // cache_into_max_age_range error is how the author finds out.
        ...(Number.isFinite(days) ? { maxAgeDays: Math.round(days) } : {}),
    };
}

/** Same shape as applyAskOncePatch, and the clear is `undefined` for the same reason. */
function applyCacheIntoPatch(patch, step, draft) {
    const next = normalizeCacheInto(draft.cacheInto);
    if (next !== undefined) patch.cacheInto = next;
    else if (step.cacheInto) patch.cacheInto = undefined;
}

/**
 * Optional collection-op input cap (C19). '' / invalid clears the key —
 * `undefined` drops out of the persisted step after the patch-merge + JSON
 * serialisation, same pattern as dedupe's keyField.
 */
function applyMaxItemsPatch(patch, draft) {
    const n = Number(draft.maxItems);
    patch.maxItems = Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/** Drop bindings that have neither a value nor a path so we don't
 *  persist a half-edited row that fails validation. */
function sanitizeInputs(inputs) {
    const out = {};
    for (const [k, v] of Object.entries(inputs || {})) {
        if (!v || typeof v !== 'object') continue;
        if (v.kind === 'literal' && (v.value === '' || v.value == null)) continue;
        if (v.kind === 'ref' && !v.path) continue;
        if ((v.kind === 'template' || v.kind === 'expr') && !v.value) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Sanitize a USER-DEFINED field map (Set / layer_output return). Unlike
 * sanitizeInputs — which is for tool PARAMS, where an empty value means
 * "omit this param" — the keys here are the user's OWN named fields. A field
 * the user just added but hasn't given a value yet MUST survive the save
 * round-trip; otherwise the autosave strips it and the form re-hydrates
 * without the row, so it vanishes mid-edit. We therefore keep every entry
 * with a non-empty key and a binding object, regardless of an empty value;
 * only blank-key / non-object entries are dropped.
 */
function sanitizeFieldMap(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
        if (!k || !k.trim()) continue;
        if (v == null) continue;
        // Bare (non-object) literals are LEGAL — bind.js resolves them as
        // literal values, and API/import/legacy definitions carry them.
        // Dropping them here silently emptied `fields` on the first unrelated
        // edit (C15); normalise to the canonical wrapper instead so the UI
        // can edit them.
        if (typeof v !== 'object') { out[k] = { kind: 'literal', value: v }; continue; }
        out[k] = v;
    }
    return out;
}

/**
 * Sanitize the parse_json fields ARRAY. Same philosophy as sanitizeFieldMap:
 * these are the user's OWN named rows, so a named-but-incomplete row (path
 * still empty) MUST survive the 600ms autosave round-trip — dropping it would
 * make the row vanish mid-edit. Only blank-name / non-object rows are
 * dropped. `undefined` members are stripped so the persisted step never
 * carries them (JSON round-trips would drop them asymmetrically anyway).
 */
export function sanitizeParseJsonFields(fields) {
    const out = [];
    for (const f of (Array.isArray(fields) ? fields : [])) {
        if (!f || typeof f !== 'object') continue;
        const name = typeof f.name === 'string' ? f.name.trim() : '';
        if (!name) continue;
        const row = { name, path: typeof f.path === 'string' ? f.path : '' };
        if (typeof f.description === 'string' && f.description.trim()) row.description = f.description;
        if (f.fallback !== undefined) row.fallback = f.fallback;
        out.push(row);
    }
    return out;
}

// ── data_extraction ─────────────────────────────────────────────────────
// The four types the extraction step can ask for. `date` is an ISO YYYY-MM-DD
// string; `number` is coerced by the runner from European forms too. Mirrors
// server/automation/validate/stepRules.js — an unknown type there is an
// INTEGRITY error, so nothing here may let one through.
export const EXTRACTION_FIELD_TYPES = ['string', 'number', 'boolean', 'date'];
export const MAX_EXTRACTION_FIELDS = 30;
export const MAX_EXTRACTION_INSTRUCTIONS = 2000;
// `[a-z][a-z0-9_]{0,39}` — lowercase snake, because these become the output
// keys (`steps.<id>.output.<name>`) and every later binding spells them.
export const EXTRACTION_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The row the panel opens on and "Add field" appends. */
export function emptyExtractionField() {
    return { name: '', type: 'string', description: '', required: false };
}

/**
 * What a person types → a legal field name, live: "Invoice Date" → "invoice_date",
 * "€ totaal" → "totaal". Lower-cases, turns runs of space/dash into one
 * underscore, drops anything else, strips leading non-letters and caps at 40.
 * Coercing as they type (rather than rejecting on save) means what is on
 * screen is what gets saved, and the server never sees an invalid name.
 */
export function coerceExtractionName(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^[^a-z]+/, '')
        .slice(0, 40);
}

/**
 * Nothing bound yet. Absent, null, or any binding kind with nothing in it —
 * the same idea as mapping/boundPaths.isEmptyValue, kept local because this
 * module is React-free and must not pull the mapping layer in.
 */
export function isEmptyExtractionSource(b) {
    if (b == null || typeof b !== 'object') return true;
    if (b.kind === 'ref') return !String(b.path || '').trim();
    if (b.kind === 'literal') return b.value == null || String(b.value).trim() === '';
    if (b.kind === 'template' || b.kind === 'expr') return !String(b.value || '').trim();
    return false;
}

/**
 * The draft's rows: every persisted row normalised to the full four-key shape
 * the editor binds to, plus one blank row when there are none (see
 * extractFormState). Order is preserved — it is the order the prompt lists
 * the fields in and the order the output panel shows them.
 */
export function readExtractionFields(raw) {
    const rows = (Array.isArray(raw) ? raw : [])
        .filter(f => f && typeof f === 'object')
        .map(f => ({
            name: typeof f.name === 'string' ? f.name : '',
            type: EXTRACTION_FIELD_TYPES.includes(f.type) ? f.type : 'string',
            description: typeof f.description === 'string' ? f.description : '',
            required: f.required === true,
        }));
    return rows.length ? rows : [emptyExtractionField()];
}

/**
 * Sanitize the extraction fields ARRAY for the wire. Blank-name rows are
 * dropped (they are the panel's pending rows, see sanitizeParseJsonFields for
 * the philosophy); a later row that repeats an earlier name is dropped too,
 * because `fields_duplicate` is an INTEGRITY code and would 400 the autosave
 * — the panel marks the duplicate amber so the author sees why it is not
 * saved. Types outside the enum fall back to string; `description` and
 * `required` are only written when they say something, so a step saved from
 * the form is the same object the AI builder produces. Capped at 30.
 */
export function sanitizeExtractionFields(fields) {
    const out = [];
    const seen = new Set();
    for (const f of (Array.isArray(fields) ? fields : [])) {
        if (!f || typeof f !== 'object') continue;
        const name = coerceExtractionName(f.name);
        if (!name || !EXTRACTION_NAME_RE.test(name) || seen.has(name)) continue;
        seen.add(name);
        const row = { name, type: EXTRACTION_FIELD_TYPES.includes(f.type) ? f.type : 'string' };
        if (typeof f.description === 'string' && f.description.trim()) row.description = f.description.trim();
        if (f.required === true) row.required = true;
        out.push(row);
        if (out.length >= MAX_EXTRACTION_FIELDS) break;
    }
    return out;
}

/**
 * Sanitize the "Edit data" operations ARRAY. Same survival philosophy as
 * sanitizeParseJsonFields: these are the user's OWN rows, so a typed-but-
 * incomplete operation (target still empty, keys not picked yet) MUST survive
 * the autosave round-trip — the validator marks it as a completeness problem,
 * it must not vanish mid-edit. Only non-objects and unknown `op` values are
 * dropped (nothing in the editor can create those), and each op is normalised
 * to the exact key set the runtime reads.
 */
export function sanitizeOperations(raw) {
    const out = [];
    const t = (s) => (typeof s === 'string' ? s.trim() : '');
    const keysOf = (v) => (Array.isArray(v) ? v.map(t).filter(Boolean) : []);
    for (const o of (Array.isArray(raw) ? raw : [])) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
        if (o.op === 'rowId') {
            // '' / null = "not set" — Number('') is 0, which would silently
            // persist a start of 0 the user never typed.
            const start = (o.start === '' || o.start == null) ? null : Number(o.start);
            out.push({ op: 'rowId', target: t(o.target), ...(Number.isInteger(start) && start !== 1 ? { start } : {}) });
        } else if (o.op === 'groupId') {
            out.push({ op: 'groupId', target: t(o.target), keys: keysOf(o.keys) });
        } else if (o.op === 'rename') {
            out.push({ op: 'rename', from: t(o.from), to: t(o.to) });
        } else if (o.op === 'keep' || o.op === 'remove') {
            out.push({ op: o.op, keys: keysOf(o.keys) });
        } else if (o.op === 'sort') {
            out.push({ op: 'sort', key: t(o.key), ...(o.direction === 'desc' ? { direction: 'desc' } : {}) });
        }
    }
    return out;
}

function stripUndefined(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Structural deep-equal for plain JSON values. Replaces JSON.stringify
 * comparisons whose key-order instability could either claim dirty=false
 * for real changes (Save button greys out) or dirty=true after a no-op
 * baseline update (autosave loop).
 */
export function deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
}

// ── AI step structured-output helpers ──────────────────────────────────
//
// We support two shapes the runtime accepts (server/core/automationRunner.js
// stringifies `effectiveSchema` verbatim and tells the model "match this"):
//   1. JSON Schema:   { type:'object', properties:{ name:{type:'string'} } }
//   2. Flat:          { name:'string' }
// On read we accept both; on write we always emit shape #1 so the AI builder
// and templates (templates.js uses JSON Schema) round-trip cleanly.

/**
 * R2 — the three switches of `ai_step.agentPermissions`, and the skill cap.
 *
 * Mirrors AI_STEP_AGENT_PERMISSION_KEYS / MAX_AI_STEP_SKILL_IDS in
 * server/automation/validate/constants.js. Restated rather than fetched
 * because a form has to render before any round trip — but the server clamps
 * both ends regardless (stepBuilders.sanitizeAgentPermissions rebuilds the
 * object from its own list, and mergeSkillIds truncates at the same cap), so a
 * client that drifts loses a checkbox, never a rule.
 */
export const AI_STEP_AGENT_PERMISSION_KEYS = ['startAutomations', 'useKnowledge', 'useTools'];
export const MAX_AI_STEP_SKILL_IDS = 5;

/**
 * The permissions of an ai_step, always all three, always real booleans.
 *
 * REBUILT from the three known names — never spread from what was stored. A
 * stored `{useTools: true}` spread into a draft leaves the other two
 * `undefined`, and the first reader written as `!== false` reads an undefined
 * as a yes. Absent is three noes: this surface is new, so there is no
 * yesterday's behaviour that reading absence broadly would preserve (which is
 * the one thing that justifies the opposite reading over in
 * core/agentRuntime/toolPolicy.js).
 */
export function readAgentPermissions(raw) {
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const out = {};
    for (const key of AI_STEP_AGENT_PERMISSION_KEYS) out[key] = src[key] === true;
    return out;
}

/** The skills of an ai_step, IN THE AUTHOR'S ORDER — the first one leads. */
export function readSkillIds(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const id of raw) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export const OUTPUT_FIELD_TYPES = ['string', 'number', 'boolean', 'datetime', 'object', 'array'];
// Column types for a table (array-of-objects) field — flat scalars only.
export const COLUMN_TYPES = ['string', 'number', 'boolean', 'datetime'];

// `datetime` isn't a native JSON-schema type — it's a string with an ISO 8601
// date-time format, which is what we tell the model to emit. These two helpers
// translate between our friendly type names and the schema fragment so the
// round-trip (save → schema → reload) stays lossless.
function scalarSpec(type, allowed) {
    if (type === 'datetime') return { type: 'string', format: 'date-time' };
    return { type: allowed.includes(type) ? type : 'string' };
}
function scalarType(spec, allowed) {
    if (spec && spec.type === 'string' && (spec.format === 'date-time' || spec.format === 'date')) return 'datetime';
    return allowed.includes(spec?.type) ? spec.type : 'string';
}

export function schemaToFields(schema) {
    if (!schema || typeof schema !== 'object') return [];
    const props = schema.properties && typeof schema.properties === 'object'
        ? schema.properties
        : schema;
    const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
    const out = [];
    for (const [key, spec] of Object.entries(props || {})) {
        if (!key) continue;
        if (typeof spec === 'string') {
            out.push({ key, type: OUTPUT_FIELD_TYPES.includes(spec) ? spec : 'string', description: '' });
        } else if (spec && typeof spec === 'object') {
            const field = {
                key,
                type: scalarType(spec, OUTPUT_FIELD_TYPES),
                description: typeof spec.description === 'string' ? spec.description : '',
            };
            if (requiredKeys.has(key)) field.required = true;
            // Table columns: an array whose items are an object with properties.
            // Object.entries preserves insertion order, so column order survives.
            const itemProps = spec.items && typeof spec.items === 'object' ? spec.items.properties : null;
            if (field.type === 'array' && itemProps && typeof itemProps === 'object') {
                field.columns = Object.entries(itemProps)
                    .filter(([ck]) => ck)
                    .map(([ck, cs]) => ({ key: ck, type: scalarType(cs, COLUMN_TYPES) }));
            } else if (field.type === 'array' && spec.items && typeof spec.items === 'object') {
                // Scalar-item arrays (e.g. {type:'array', items:{type:'string'}}):
                // stash the items spec verbatim so the save round-trip doesn't
                // discard it (C13 — every save used to degrade these to an
                // untyped array).
                field.itemsSpec = spec.items;
            }
            // Nested object properties ride along OPAQUELY: the form can't
            // edit them (yet), but extract→rebuild must be the identity, not
            // a lossy downgrade to a bare {type:'object'} (C13).
            if (field.type === 'object' && spec.properties && typeof spec.properties === 'object') {
                field.objectSpec = spec.properties;
                if (Array.isArray(spec.required)) field.objectRequired = spec.required;
            }
            out.push(field);
        }
    }
    return out;
}

export function fieldsToSchema(fields) {
    const valid = (fields || []).filter(f => f && typeof f.key === 'string' && f.key.trim());
    if (valid.length === 0) return null;
    const properties = {};
    const required = [];
    for (const f of valid) {
        const spec = scalarSpec(f.type, OUTPUT_FIELD_TYPES);
        if (f.description && f.description.trim()) spec.description = f.description.trim();
        // A table (array) with declared columns → array of objects with those
        // typed properties IN THE DECLARED ORDER, so the model returns rows the
        // Output panel renders as a real table with those headers in that order.
        // Empty/unnamed columns are skipped; if none remain the array stays
        // untyped (model infers the columns).
        if (f.type === 'array' && Array.isArray(f.columns)) {
            const colProps = {};
            for (const c of f.columns) {
                if (!c || typeof c.key !== 'string' || !c.key.trim()) continue;
                colProps[c.key.trim()] = scalarSpec(c.type, COLUMN_TYPES);
            }
            if (Object.keys(colProps).length) spec.items = { type: 'object', properties: colProps };
        } else if (f.type === 'array' && f.itemsSpec && typeof f.itemsSpec === 'object') {
            spec.items = f.itemsSpec; // opaque passthrough (C13)
        }
        if (f.type === 'object' && f.objectSpec && typeof f.objectSpec === 'object') {
            spec.properties = f.objectSpec; // opaque passthrough (C13)
            if (Array.isArray(f.objectRequired) && f.objectRequired.length) spec.required = f.objectRequired;
        }
        if (f.required) required.push(f.key.trim());
        properties[f.key.trim()] = spec;
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

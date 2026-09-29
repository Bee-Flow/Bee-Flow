/**
 * Deterministic plain-English summary of an automation definition.
 *
 * Used by the Builder agent's `summarise_draft` tool and rendered in the
 * UI so the user can read what the automation will do. No LLM call —
 * cheap, predictable, diffable across drafts. Side-effect lines start
 * with **bold** so the user notices what the automation will write.
 */

const { isSideEffect } = require('./sideEffectMap');

function describeTrigger(trigger) {
    if (!trigger) return 'When triggered';
    switch (trigger.kind) {
        case 'schedule': {
            const cron = trigger.schedule?.cron || '';
            const tz = trigger.schedule?.tz || 'Europe/Amsterdam';
            return `On schedule (\`${cron}\`, ${tz})`;
        }
        case 'manual': return 'When run manually';
        case 'webhook': return 'When the webhook URL is called';
        case 'agent_call': {
            const name = trigger.toolName || `automation_${trigger.id || ''}`;
            return `When an AI agent calls it (\`${name}\`)`;
        }
        case 'app_event': {
            const provider = trigger.appEvent?.provider || 'app';
            const ev = trigger.appEvent?.event || 'event';
            const f = trigger.appEvent?.filter;
            const filt = f ? ` filtered by ${JSON.stringify(f)}` : '';
            return `When ${provider} emits "${ev}"${filt}`;
        }
        default: return `On trigger (${trigger.kind || 'unknown'})`;
    }
}

function describeRef(binding) {
    if (binding == null) return '∅';
    if (typeof binding !== 'object') return JSON.stringify(binding);
    if (binding.kind === 'literal') return JSON.stringify(binding.value);
    if (binding.kind === 'ref') return `\`${binding.path}\``;
    if (binding.kind === 'template') return `"${binding.value}"`;
    if (binding.kind === 'expr') return `\`${binding.value}\``;
    return JSON.stringify(binding);
}

function describeStep(step, idx) {
    const n = `${idx + 1}.`;
    switch (step.type) {
        case 'integration_action': {
            const sideEffect = isSideEffect(step.tool);
            const inputs = Object.entries(step.inputs || {})
                .map(([k, v]) => `${k}=${describeRef(v)}`)
                .join(', ');
            const line = `Call \`${step.tool}\`${inputs ? ` with ${inputs}` : ''}${step.label ? ` — ${step.label}` : ''}.`;
            return `${n} ${sideEffect ? '**' + line + '**' : line}`;
        }
        case 'ai_step': {
            const promptShort = (step.prompt || '').replace(/\s+/g, ' ').slice(0, 140) + ((step.prompt || '').length > 140 ? '…' : '');
            return `${n} Ask the AI (${step.modelTier || 'fast'}): "${promptShort}"`;
        }
        case 'condition':
            return `${n} If \`${step.expr}\` then go to "then"-branch, else "else"-branch.`;
        case 'loop':
            return `${n} For each item in \`${step.overRef}\` (as \`loop.${step.itemVar}\`), run a sub-flow of ${(step.body || []).length} step(s) (max ${step.maxIterations || 100}).`;
        case 'code':
            return `${n} **Run sandboxed JavaScript** (${(step.code || '').length} chars).`;
        case 'notification': {
            const channels = (step.channels || ['notification']).join(', ');
            const title = step.title ? ` titled "${step.title}"` : '';
            return `${n} Send notification on **${channels}**${title}.`;
        }
        case 'guard': {
            const cats = Array.isArray(step.categories) && step.categories.length
                ? step.categories.join(', ') : 'every category the organisation looks for';
            const acts = [];
            if (step.onFound && step.onFound.stop) acts.push('stop the run');
            if (step.onFound && step.onFound.mask) acts.push('pass a masked copy on');
            return `${n} Scan \`${step.sourceRef || '?'}\` for personal data (${cats})`
                + `${acts.length ? `, and on a hit ${acts.join(' and ')}` : ''}`
                + '. Routes **personal data** / **clean**.';
        }
        case 'tokenize': {
            const cats = Array.isArray(step.categories) && step.categories.length
                ? step.categories.join(', ') : 'every category the organisation looks for';
            return `${n} Replace the personal data in \`${step.sourceRef || '?'}\` (${cats}) with reversible `
                + 'placeholders. The real values are put back automatically wherever the run uses them again.';
        }
        case 'parse_json': {
            const names = (Array.isArray(step.fields) ? step.fields : []).map(f => f && f.name).filter(Boolean);
            const src = step.sourceRef ? `\`${step.sourceRef}\`` : "the previous step's output";
            return `${n} Extract ${names.length} field(s) (${names.join(', ') || 'none yet'}) from ${src}${step.mode === 'ai' ? ' **using AI**' : ''}.`;
        }
        case 'call_layer': {
            const key = step.layerKey || step.layerId || '?';
            const inputs = Object.entries(step.inputs || {})
                .map(([k, v]) => `${k}=${describeRef(v)}`)
                .join(', ');
            return `${n} Run flowlet \`${key}\`${inputs ? ` with ${inputs}` : ''}${step.label && step.label !== 'Call layer' ? ` — ${step.label}` : ''}.`;
        }
        case 'generate_document': {
            const kind = step.format === 'docx' ? 'Word document' : 'PDF';
            const named = step.fileName || step.title;
            return `${n} Make a ${kind}${named ? ` called "${named}"` : ''}${step.label ? ` — ${step.label}` : ''}.`;
        }
        case 'slide': {
            const visual = step.chart && step.chart.type ? ` with a ${step.chart.type} chart` : (step.stats ? ' with KPI tiles' : (step.layout === 'timeline' ? ' as a timeline' : ''));
            return `${n} Slide${step.title ? ` "${step.title}"` : ''}${visual}${step.forEach ? ` — one per item of ${describeRef(step.forEach.overRef)}` : ''}${step.label && step.label !== 'Slide' ? ` — ${step.label}` : ''}.`;
        }
        case 'presentation': {
            const kind = step.format === 'pdf' ? 'PDF deck' : 'PowerPoint';
            const named = step.fileName || step.title;
            return `${n} Make a ${kind}${named ? ` called "${named}"` : ''}${step.label && step.label !== 'Presentation' ? ` — ${step.label}` : ''}.`;
        }
        case 'fill_document': {
            // Say WHICH document: it IS the step — "fill a document" without
            // the name tells the author nothing they did not already see.
            const named = step.fileName || step.documentName || step.documentId || '';
            const holes = Object.keys(step.values || {}).length;
            return `${n} Fill the document${named ? ` "${named}"` : ''}${holes ? ` with ${holes} value(s)` : ''} and keep the PDF${step.label && step.label !== 'Fill a document' ? ` — ${step.label}` : ''}.`;
        }
        case 'data_extraction': {
            // Say WHICH fields: they are the step's whole contract, and the one
            // thing the author cannot see from a card that reads "Extract data".
            const names = (Array.isArray(step.fields) ? step.fields : []).map(f => f && f.name).filter(Boolean);
            const src = step.source == null ? 'the text' : describeRef(step.source);
            return `${n} Extract ${names.length} field(s) (${names.join(', ') || 'none yet'}) from ${src}${step.label && step.label !== 'Extract data' ? ` — ${step.label}` : ''}.`;
        }
        case 'datatable': {
            const where = Array.isArray(step.where) && step.where.length
                ? ` where ${step.where.map(w => w && w.field).filter(Boolean).join(' and ')} matches`
                : '';
            const table = step.label && step.label !== 'Datatable' ? ` "${step.label}"` : ' a datatable';
            switch (step.op) {
                case 'add_row':     return `${n} Add a row to${table}.`;
                case 'save_row':    return `${n} Add or update a row in${table}, matched on ${step.matchColumn || 'a column'}.`;
                case 'update_rows': return `${n} Update rows in${table}${where}.`;
                case 'delete_rows': return `${n} Delete rows from${table}${where}.`;
                default:            return `${n} Look up rows in${table}${where}.`;
            }
        }
        case 'knowledge_write': {
            // Say WHERE and say IDEMPOTENT-or-not: those are the two things an
            // author reading the summary cannot see from the canvas, and the
            // second is the difference between one document and one per night.
            const title = typeof step.title === 'string' && step.title.trim() ? ` "${step.title.trim()}"` : '';
            const repeats = typeof step.sourceUri === 'string' && step.sourceUri.trim()
                ? ' (replacing its own earlier version)'
                : ' (a new document each run)';
            return `${n} Save${title || ' text'} into a knowledge base${repeats}.`;
        }
        default:
            return `${n} ${step.type} step (${step.id}).`;
    }
}

/**
 * Produce a markdown plain-English summary of the automation.
 *
 * Returns:
 *   { summary: string, hasSideEffects: boolean }
 */
function summariseDefinition(def) {
    if (!def || typeof def !== 'object') {
        return { summary: '_(empty draft)_', hasSideEffects: false };
    }
    const lines = [];
    lines.push(`**Trigger:** ${describeTrigger(def.trigger)}.`);
    for (const t of (Array.isArray(def.triggers) ? def.triggers : [])) {
        if (!t || typeof t !== 'object') continue;
        lines.push(`**Also starts:** ${describeTrigger(t)} (trigger \`${t.id}\`${t.label ? `, "${t.label}"` : ''}).`);
    }
    lines.push('');
    lines.push('**Steps:**');

    let hasSideEffects = false;
    // Notes (BFSF-411) are canvas annotations, not steps the routine runs —
    // numbering them alongside real steps would misreport what step 4 in the
    // list actually does, and describeStep has no case for 'note' anyway (it
    // would fall through to the raw-type default line).
    const steps = (Array.isArray(def.steps) ? def.steps : []).filter(s => s?.type !== 'note');
    if (steps.length === 0) {
        lines.push('_(no steps yet)_');
    } else {
        steps.forEach((s, i) => {
            const desc = describeStep(s, i);
            if (s.type === 'integration_action' && isSideEffect(s.tool)) hasSideEffects = true;
            if (s.type === 'code') hasSideEffects = true;
            if (s.type === 'notification') hasSideEffects = true;
            // It writes a real file that persists past the run and can be
            // downloaded by whoever the routine hands it to. Cheaper than an
            // email, but not nothing — the author should be told a live run
            // will actually produce it.
            if (s.type === 'generate_document') hasSideEffects = true;
            // Same for a filled document — and more so with saveCopy, which
            // also leaves a document behind in the library.
            if (s.type === 'fill_document') hasSideEffects = true;
            // And for a deck — a real file kept past the run. A slide is an
            // object in the run state, nothing outlives it.
            if (s.type === 'presentation') hasSideEffects = true;
            // A datatable WRITE outlives the run and other routines read it, so
            // the author must be told a live run will really change it. Decided
            // per FIELD rather than per type — the same shape integration_action
            // already uses above, where isSideEffect(s.tool) makes the call.
            if (s.type === 'datatable' && s.op && s.op !== 'find_rows') hasSideEffects = true;
            // A knowledge-base write outlives the run like a datatable write,
            // and goes one further: an agent will later state its text as fact
            // with a citation. There is no read variant of this step, so it is
            // decided per TYPE rather than per field.
            if (s.type === 'knowledge_write') hasSideEffects = true;
            lines.push(desc);
        });
    }

    return { summary: lines.join('\n'), hasSideEffects };
}

// ── Agent-facing structured draft state ──────────────────────────────────
// Unlike summariseDefinition (human prose, root-only, no IDs), this renders a
// compact but COMPLETE view for the builder AGENT: every step's real id, type,
// tool/op, label, key settings AND its input bindings (the mapping between
// steps) — for the main flow AND every inline flowlet, plus the edge wiring.
// The agent reads step IDs + current bindings here instead of asking the user.

function bindingMap(map) {
    const entries = Object.entries(map || {});
    if (!entries.length) return '∅';
    return `{ ${entries.map(([k, v]) => `${k}=${describeRef(v)}`).join(', ')} }`;
}

// ── The parameters a code step declares ─────────────────────────────
// The step settings render the JSDoc on main as the step's input form
// (automation/codeSafety, analyzeCode().params), and the builder binds the
// step's `inputs` by those names. Without the names in the draft state the
// model saw a code step as "(N chars)" and had to guess what to bind.
//
// Loaded on first use and remembered per code text: the draft state is
// rebuilt every turn and a routine rarely changes its code between turns.
// Never throws: a summary line is not worth a failed turn, and without the
// analyser the line keeps only the size, as before.
const CODE_PARAMS_CACHE_MAX = 64;
const codeParamsCache = new Map();
let codeAnalyser;

function declaredCodeParams(code) {
    if (typeof code !== 'string' || !code.trim()) return null;
    if (codeParamsCache.has(code)) return codeParamsCache.get(code);
    if (codeAnalyser === undefined) {
        try { codeAnalyser = require('./codeSafety').analyzeCode; } catch (_) { codeAnalyser = null; }
    }
    let params = null;
    if (typeof codeAnalyser === 'function') {
        try {
            const analysis = codeAnalyser(code);
            params = analysis && Array.isArray(analysis.params) ? analysis.params : null;
        } catch (_) { params = null; }
    }
    if (codeParamsCache.size >= CODE_PARAMS_CACHE_MAX) codeParamsCache.delete(codeParamsCache.keys().next().value);
    codeParamsCache.set(code, params);
    return params;
}

/** ` params=[amount*, vatRate=21]`: * required, =value the default. */
function describeCodeParams(params) {
    if (!Array.isArray(params) || !params.length) return '';
    const names = params.filter(p => p && p.name).map((p) => {
        if (p.required) return `${p.name}*`;
        if (p.default === undefined) return p.name;
        let def;
        try { def = JSON.stringify(p.default); } catch (_) { def = String(p.default); }
        return `${p.name}=${String(def).slice(0, 30)}`;
    });
    return names.length ? ` params=[${names.join(', ')}]` : '';
}

function describeCodeStep(step, codeParams) {
    const read = typeof codeParams === 'function' ? codeParams : declaredCodeParams;
    let params = null;
    try { params = read(step.code); } catch (_) { params = null; }
    const tools = Array.isArray(step.allowedTools) && step.allowedTools.length ? ` tools=[${step.allowedTools.join(', ')}]` : '';
    return ` (${(step.code || '').length} chars)${describeCodeParams(params)}${tools}`;
}

/**
 * One line per step: `id` type detail — label [forEach] ← inputs.
 *
 * `opts.codeParams(code)` answers a code step's declared parameters
 * (default: analyzeCode's `params`); tests hand in their own.
 */
function renderStepState(step, opts = {}) {
    const id = `\`${step.id}\``;
    let detail = '';
    let inputs = '';
    switch (step.type) {
        case 'integration_action': detail = ` ${step.tool || '?'}`; inputs = bindingMap(step.inputs); break;
        case 'ai_step':            detail = ` (${step.modelTier || 'auto'})`; inputs = bindingMap(step.inputs); break;
        case 'condition':          detail = ` if \`${step.expr}\``; break;
        case 'tokenize':           detail = ` hide \`${step.sourceRef || '?'}\` cats=[${(step.categories || []).join(', ') || 'org'}]`; break;
        case 'guard':              detail = ` scan \`${step.sourceRef || '?'}\` cats=[${(step.categories || []).join(', ') || 'org'}]${step.onFound && step.onFound.stop ? ' stop' : ''}${step.onFound && step.onFound.mask ? ' mask' : ''}`; break;
        case 'switch':             detail = ` on \`${step.expr}\` cases=[${(step.cases || []).map(c => c.name).join(', ')}]`; break;
        case 'loop':               detail = ` over \`${step.overRef}\` as loop.${step.itemVar} (${(step.body || []).length} body step(s))`; break;
        case 'set':                detail = ` fields=${bindingMap(step.fields)}`; break;
        case 'parse_json':         detail = ` (${step.mode === 'ai' ? 'ai' : 'paths'}) fields=[${(Array.isArray(step.fields) ? step.fields : []).map(f => f && f.name).filter(Boolean).join(', ')}]${step.sourceRef ? ` src=\`${step.sourceRef}\`` : ''}`; break;
        case 'layer_output':       detail = ` returns=${bindingMap(step.fields)}`; break;
        case 'call_layer':         detail = ` layer=\`${step.layerKey || '?'}\``; inputs = bindingMap(step.inputs); break;
        case 'notification':       detail = ` ${(step.channels || ['notification']).join(',')}${step.title ? ` "${step.title}"` : ''}`; break;
        case 'code':               detail = describeCodeStep(step, opts.codeParams); inputs = bindingMap(step.inputs); break;
        case 'datetime':           detail = ` op=${step.op || 'now'}${typeof step.arrayRef === 'string' ? ' (per row)' : ''}`; break;
        case 'wait':               detail = ` ${step.seconds || 0}s`; break;
        case 'approval':           detail = step.prompt ? ` ask: ${String(step.prompt).slice(0, 60)}` : ' no question yet'; break;
        case 'form_page':          detail = step.mode === 'ending' ? ' closing page' : ` ask ${(step.form?.fields || []).length} question(s)`; break;
        case 'stop_error':         detail = ` "${step.message || ''}"`; break;
        case 'return_to_app':      detail = ` → app${step.navigateTo?.screenId ? ` screen=\`${step.navigateTo.screenId}\`` : ''}${step.toast?.message ? ` says "${String(step.toast.message).slice(0, 40)}"` : ''}${step.refresh ? ` refresh=${step.refresh}` : ''} (ends the run)`; break;
        case 'generate_document':  detail = ` ${step.format === 'docx' ? 'Word' : 'PDF'} from \`${step.content || ''}\``; break;
        case 'fill_document':      detail = ` doc=\`${step.documentId || 'not picked'}\` values=[${Object.keys(step.values || {}).join(', ')}]`; break;
        case 'slide':              detail = ` "${step.title || ''}"${step.layout ? ` layout=${step.layout}` : ''}${step.chart && step.chart.type ? ` chart=${step.chart.type}` : ''}${step.stats ? ' stats' : ''}${step.style ? ` style=${step.style}` : ''}${step.forEach ? ` per item of \`${step.forEach.overRef || ''}\`` : ''}`; break;
        case 'presentation':       detail = ` ${step.format === 'pdf' ? 'PDF deck' : 'PowerPoint'} from ${Array.isArray(step.slides) ? `${step.slides.length} slide reference(s)` : `\`${typeof step.slides === 'string' ? step.slides : ''}\``}`; break;
        case 'data_extraction':    detail = ` fields=[${(Array.isArray(step.fields) ? step.fields : []).map(f => f && f.name ? `${f.name}:${f.type || 'string'}` : null).filter(Boolean).join(', ')}] from ${describeRef(step.source)}`; break;
        case 'knowledge_write':    detail = ` → kb \`${step.knowledgeBaseId || 'not picked'}\` from \`${step.content || ''}\`${step.sourceUri ? ` src=\`${step.sourceUri}\`` : ' (no sourceUri — a new document each run)'}`; break;
        case 'filter': case 'limit': case 'dedupe': case 'aggregate': case 'summarize':
            detail = ` over \`${step.arrayRef || ''}\`${step.field ? ` field=${step.field}` : ''}${step.op ? ` op=${step.op}` : ''}`; break;
        // A canvas annotation — never runs, never wired. Shown so the agent
        // can see (and edit) it without mistaking it for a step it could
        // chain something after.
        case 'note': detail = ` "${String(step.text || '').replace(/\s+/g, ' ').slice(0, 60)}" (annotation — never runs)`; break;
        default: detail = '';
    }
    const fe = step.forEach?.overRef ? `  [forEach over \`${step.forEach.overRef}\` as loop.${step.forEach.itemVar || 'item'}]` : '';
    const label = step.label ? `  — ${step.label}` : '';
    const inLine = inputs && inputs !== '∅' ? `  ← inputs ${inputs}` : '';
    return `  - ${id} ${step.type}${detail}${label}${fe}${inLine}`;
}

function renderGraphState(graph, out, opts = {}) {
    const t = graph.trigger;
    if (t) {
        if (t.kind === 'layer_input') {
            const params = (t.params || []).map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean);
            out.push(`  - \`${t.id || 'trg'}\` trigger:layer_input  inputs: ${params.join(', ') || '(none)'}  (bind inside as trigger.output.<name>)`);
        } else {
            out.push(`  - \`${t.id || 'trg'}\` trigger:${t.kind || 'manual'}`);
        }
    }
    for (const x of (Array.isArray(graph.triggers) ? graph.triggers : [])) {
        if (!x || typeof x !== 'object') continue;
        const detail = x.appEvent ? ` ${x.appEvent.provider}.${x.appEvent.event}` : (x.schedule?.cron ? ` ${x.schedule.cron}` : '');
        out.push(`  - \`${x.id}\` trigger:${x.kind}${detail} [additional entry point${x.label ? `, "${x.label}"` : ''}]`);
    }
    for (const s of (Array.isArray(graph.steps) ? graph.steps : [])) out.push(renderStepState(s, opts));
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    if (edges.length) {
        out.push(`  wiring: ${edges.map(e => `${e.from}→${e.to}${e.label ? `(${e.label})` : ''}`).join(', ')}`);
    }
}

/**
 * @param {object} def   the draft definition
 * @param {{ codeParams?: (code: string) => Array<object>|null }} [opts]
 */
function renderAgentDraftState(def, opts = {}) {
    if (!def || typeof def !== 'object') return '_(empty draft)_';
    const out = ['MAIN FLOW:'];
    renderGraphState(def, out, opts);
    const layers = (def.layers && typeof def.layers === 'object' && !Array.isArray(def.layers)) ? def.layers : {};
    for (const [key, g] of Object.entries(layers)) {
        if (!g || typeof g !== 'object') continue;
        out.push('');
        out.push(`FLOWLET \`${key}\`${g.title ? ` — "${g.title}"` : ''}:`);
        renderGraphState(g, out, opts);
    }
    return out.join('\n');
}

module.exports = { summariseDefinition, renderAgentDraftState };

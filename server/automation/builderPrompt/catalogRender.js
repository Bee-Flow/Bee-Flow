/**
 * Catalog renderers for the builder system prompt (§WS5, extracted verbatim
 * from builderPrompt.js). Pure functions; lazy-require outputSchemas.
 */

function renderCatalog(catalog) {
    const { describeShape, producesList } = require('../outputSchemas');
    const apps = (catalog?.apps || [])
        .filter(a => a.available && a.actions.length)
        .map(a => {
            const actions = a.actions
                .map(act => {
                    const shape = describeShape(act.name);
                    const shapeNote = shape ? `\n      → output: ${shape}` : '';
                    // `[list]` flags actions whose output can be iterated with a
                    // per-step `forEach` (no wrapping loop). ~1 token; only on
                    // array-producing actions.
                    const listTag = producesList(act.name) ? ' [list]' : '';
                    return `  - ${act.name}${act.sideEffect ? ' [side-effect]' : ''}${listTag} — ${act.description?.split('\n')[0] || ''}${shapeNote}`;
                })
                .slice(0, 30) // cap so the prompt doesn't blow up
                .join('\n');
            return `### ${a.label} (${a.id})\n${actions}`;
        })
        .join('\n\n');
    return apps;
}

function renderCatalogLean(catalog) {
    // Strip output-shape annotations and action descriptions; small models
    // get tripped up by the volume. Just list app:action names.
    const apps = (catalog?.apps || [])
        .filter(a => a.available && a.actions.length)
        .map(a => {
            const actions = a.actions
                .slice(0, 20)
                .map(act => `  - ${act.name}${act.sideEffect ? ' [side-effect]' : ''}`)
                .join('\n');
            return `### ${a.label} (${a.id})\n${actions}`;
        })
        .join('\n\n');
    return apps;
}

/**
 * Slim catalog rendering used by BOTH prompt variants (§B progressive context).
 * Signals only that integrations exist — name, side-effect/[list] tags, a
 * one-line description, and an input COUNT — never the full input param schema
 * or the output shape. The agent fetches those on demand with
 * builder_inspect_tool right before binding. ~3-4x smaller than renderCatalog,
 * provider-agnostic (plain markdown).
 */
// Above the largest real app (the demo org's `nextcloud` has 34) so the cap is
// a blow-up guard, not a silent editor. When it DOES bite, the render says so —
// a truncated list that looks complete is how a model concludes an action does
// not exist and reaches for the wrong one instead.
const ACTIONS_PER_APP = 50;

function renderCatalogSlim(catalog) {
    const { producesList } = require('../outputSchemas');
    const apps = (catalog?.apps || [])
        .filter(a => a.available && a.actions.length)
        .map(a => {
            const omitted = Math.max(0, a.actions.length - ACTIONS_PER_APP);
            const actions = a.actions
                .slice(0, ACTIONS_PER_APP)
                .map(act => {
                    const props = act.inputSchema?.properties ? Object.keys(act.inputSchema.properties) : [];
                    const required = Array.isArray(act.inputSchema?.required) ? act.inputSchema.required : [];
                    const countTag = !props.length
                        ? 'no inputs'
                        : `${props.length} input${props.length === 1 ? '' : 's'}${required.length ? `, ${required.length} required` : ''}`;
                    const listTag = producesList(act.name) ? ' [list]' : '';
                    const desc = act.description?.split('\n')[0] || '';
                    return `  - ${act.name}${act.sideEffect ? ' [side-effect]' : ''}${listTag} — ${desc} (${countTag})`;
                })
                .join('\n');
            const more = omitted
                ? `\n  …and ${omitted} more ${a.label} action${omitted === 1 ? '' : 's'} not listed — call builder_inspect_tool with an exact name if you need one.`
                : '';
            return `### ${a.label} (${a.id})\n${actions}${more}`;
        })
        .join('\n\n');
    return apps;
}

/**
 * Score catalog actions by relevance to the user's message + current draft.
 * Used by the per-turn schema injection (§WS8): tools the draft already uses
 * always rank first (edits need them), then token matches on the action
 * name, then description/app matches, then the trigger's provider app.
 * Only `available` apps are considered — permission gating stays fail-closed.
 */
function scoreRelevantTools(catalog, userMessage, draft, { max = 10 } = {}) {
    const text = String(userMessage || '').toLowerCase();
    const tokens = [...new Set(text.split(/[^a-z0-9]+/).filter(t => t.length > 2))];
    const usedTools = new Set();
    const walk = (steps) => {
        for (const s of (steps || [])) {
            if (s && typeof s.tool === 'string') usedTools.add(s.tool);
            if (s && Array.isArray(s.body)) walk(s.body);
        }
    };
    walk(draft?.steps);
    for (const g of Object.values(draft?.layers || {})) { if (g && typeof g === 'object') walk(g.steps); }
    const trigApp = draft?.trigger?.appEvent?.provider ? String(draft.trigger.appEvent.provider).toLowerCase() : null;

    const scored = [];
    for (const app of (catalog?.apps || [])) {
        if (!app || !app.available) continue;
        const appHay = `${app.id} ${app.label || ''}`.toLowerCase();
        const appMatch = tokens.some(t => appHay.includes(t));
        for (const act of (app.actions || [])) {
            if (!act || !act.name || !act.inputSchema || !act.inputSchema.properties) continue;
            let score = 0;
            if (usedTools.has(act.name)) score += 5;
            const nameHay = `${act.name} ${(act.label || '')}`.toLowerCase();
            if (tokens.some(t => nameHay.includes(t))) score += 3;
            if (appMatch || tokens.some(t => String(act.description || '').toLowerCase().includes(t))) score += 2;
            if (trigApp && String(app.id).toLowerCase() === trigApp) score += 1;
            if (score > 0) scored.push({ act, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, max).map(s => s.act);
}

/**
 * Render full input schemas + output shape for the top message/draft-relevant
 * tools (~50-90 tokens each) so the model can bind them with ZERO
 * builder_inspect_tool rounds in the common case. Returns
 * `{ text, tools }` — `tools` are the names to auto-mark as inspected —
 * or null when nothing scored.
 */
function renderRelevantToolSchemas(catalog, userMessage, draft, { max = 10 } = {}) {
    const { describeShape, producesList } = require('../outputSchemas');
    const acts = scoreRelevantTools(catalog, userMessage, draft, { max });
    if (!acts.length) return null;
    const blocks = acts.map(act => {
        const required = new Set(Array.isArray(act.inputSchema.required) ? act.inputSchema.required : []);
        const inputLine = Object.entries(act.inputSchema.properties).map(([name, spec]) => {
            const desc = spec && spec.description ? ` — ${String(spec.description).split('\n')[0].slice(0, 60)}` : '';
            const en = spec && Array.isArray(spec.enum) ? ` ∈ [${spec.enum.slice(0, 8).join('|')}]` : '';
            return `${name}${required.has(name) ? '*' : ''} (${(spec && spec.type) || 'any'}${en}${desc})`;
        }).join(', ');
        const shape = describeShape(act.name);
        const listTag = producesList(act.name) ? ' [list]' : '';
        return `### ${act.name}${act.sideEffect ? ' [side-effect]' : ''}${listTag}\ninputs: ${inputLine || '(none)'}   [* = required]${shape ? `\noutput: ${shape}` : ''}`;
    });
    const text = `## Relevant tool schemas (pre-inspected — add these directly, no builder_inspect_tool needed)\n\n${blocks.join('\n\n')}`;
    return { text, tools: acts.map(a => a.name) };
}

/**
 * The "Datatables you may use" block — the tables THIS user may address in a
 * datatable step, with their ids, keys and column keys.
 *
 * Before this block the prompt said "datatableId must be an id from the
 * catalog" and the catalog carried apps only, so the model invented `tbl_…`
 * ids or keyed `values` by column TITLE ("Excl. btw") where the runner wants
 * the KEY (excl_btw). Measured on the invoice brief: every datatable step the
 * fast model produced named a table that did not exist.
 *
 * Three inputs, three answers — the distinction is load-bearing:
 *   null/undefined → ''   the list could not be built (store outage); say
 *                         nothing rather than "you have no tables", the same
 *                         permissive posture `_availableToolNames` takes;
 *   []             → the "none" line: the user really has no tables, so a
 *                    datatable step cannot be built and the model must stop;
 *   [tables]       → one line per table, columns as `key ("Title") type`.
 *
 * Pure and order-preserving (input order): the block is rendered into the
 * system prompt, the front of the prompt cache, so two turns with the same
 * list must produce the same bytes.
 */
// Blow-up guards, both far above the demo org (6 tables, ≤ 12 columns). When
// one bites, the render SAYS so — a truncated list that looks complete is how
// a model concludes a table does not exist and invents one.
const DATATABLES_CAP = 20;
const COLUMNS_PER_TABLE = 30;

function renderDatatablesBlock(datatables, { canCreate = false } = {}) {
    if (datatables === null || datatables === undefined) return '';
    const list = Array.isArray(datatables) ? datatables.filter(t => t && t.id) : [];
    if (!list.length) {
        // The menu decides what "none" means. With builder_create_datatable on
        // it, "stop and ask the user" contradicts the tool the model is looking
        // at — the small band obeyed the sentence over the menu (2026-09-17).
        return canCreate
            ? '## Datatables you may use\n\n_(none yet — when the request needs a table, CREATE it first with builder_create_datatable {name, fields}, then write into it with builder_add_datatable or a {type:"datatable"} entry in builder_add_steps.)_'
            : '## Datatables you may use\n\n_(none — this user has no datatables. A datatable step cannot be built; if the request needs one, tell the user to create the table in Studio → Datatables first and stop.)_';
    }
    const lines = list.slice(0, DATATABLES_CAP).map(t => {
        const cols = Array.isArray(t.columns) ? t.columns.filter(c => c && c.key) : [];
        const shown = cols.slice(0, COLUMNS_PER_TABLE)
            .map(c => `${c.key} ("${c.name || c.key}")${c.type ? ` ${c.type}` : ''}`)
            .join(', ');
        const omitted = cols.length - COLUMNS_PER_TABLE;
        const more = omitted > 0 ? `${shown ? ', ' : ''}…+${omitted} more columns` : '';
        return `- ${t.id} · key ${t.key || '(none)'} · "${t.name || t.key || t.id}" · ${t.canWrite ? 'writable' : 'read-only'} · columns: ${shown || more ? `${shown}${more}` : '(none)'}`;
    });
    const omittedTables = list.length - DATATABLES_CAP;
    const moreTables = omittedTables > 0 ? `\n…and ${omittedTables} more tables — search the document library for more` : '';
    // The worked example names a REAL table from the list (the first writable
    // one, else the first) rather than a made-up id: a prompt that says "never
    // invent an id" and then shows an invented one teaches the wrong habit.
    const ex = list.find(t => t.canWrite) || list[0];
    const exCol = (Array.isArray(ex.columns) && ex.columns.find(c => c && c.key)?.key) || 'datum';
    const exOp = ex.canWrite ? 'add_row' : 'find_rows';
    const exValues = ex.canWrite ? `, values:{${exCol}:{pick:"loop.x.output.${exCol}"}, …}` : '';
    return `## Datatables you may use (existing tables — never invent an id)

${lines.join('\n')}${moreTables}

A datatable step: {type:"datatable", spec:{op:"${exOp}", datatableId:"${ex.id}", datatableKey:"${ex.key || ''}"${exValues}}}. Key values by the column KEY (the lowercase word before the quoted title), not the title. Ops: find_rows, count_rows, add_row, save_row (+matchColumn), update_rows, delete_rows. A read-only table cannot take a write.`;
}

// Same guards as the datatable block, same reason: a truncated list that looks
// complete is how a model concludes a template does not exist and writes the
// document from scratch instead.
const DOCUMENTS_CAP = 20;
const PLACEHOLDERS_PER_DOCUMENT = 30;

/**
 * "Documents you may fill" — the templates this user designed, with the
 * placeholders each one asks for.
 *
 * Three renderings, like the datatables block: '' when the caller could not
 * build the list (say nothing), an explicit "none" line when the user has no
 * documents (so the model tells them to design one rather than inventing an
 * id), and the list itself.
 *
 * A document with NO placeholders is still listed, marked as fixed: it is a
 * perfectly good attachment (terms and conditions, a price list), it just
 * takes no values.
 */
function renderDocumentsBlock(documents) {
    if (documents === null || documents === undefined) return '';
    const list = Array.isArray(documents) ? documents.filter(d => d && d.id) : [];
    if (!list.length) {
        return '## Documents you may fill\n\n_(none — this user has no designed documents. A fill_document step cannot be built; if the request needs an invoice/quote/letter layout, tell the user to design it in Studio → Documents first, or use generate_document for plain text, and stop.)_';
    }
    const lines = list.slice(0, DOCUMENTS_CAP).map(d => {
        const holes = Array.isArray(d.placeholders) ? d.placeholders : [];
        const shown = holes.slice(0, PLACEHOLDERS_PER_DOCUMENT).map((p) => {
            if (p.kind === 'list') {
                const fields = Array.isArray(p.fields) && p.fields.length ? ` of {${p.fields.join(', ')}}` : '';
                return `${p.key} (list${fields})`;
            }
            return p.kind === 'condition' ? `${p.key} (shown only if set)` : p.key;
        }).join(', ');
        const omitted = holes.length - PLACEHOLDERS_PER_DOCUMENT;
        const more = omitted > 0 ? `${shown ? ', ' : ''}…+${omitted} more` : '';
        const fills = holes.length ? `fills: ${shown}${more}` : 'no placeholders — fixed document';
        // A presentation renders as slides (.pptx); the rest as a PDF page.
        const kind = d.docType === 'presentation' ? 'presentation (slides → .pptx; format:"pdf" for a PDF deck)' : (d.docType || 'document');
        return `- ${d.id} · "${d.name || d.id}" · ${kind} · ${d.description || ''} · ${fills}`;
    });
    const omittedDocs = list.length - DOCUMENTS_CAP;
    const moreDocs = omittedDocs > 0 ? `\n…and ${omittedDocs} more documents — search the document library for more` : '';
    // The worked example names a REAL document from the list, for the same
    // reason the datatables block does.
    const ex = list.find(d => Array.isArray(d.placeholders) && d.placeholders.length) || list[0];
    const exHole = (Array.isArray(ex.placeholders) && ex.placeholders.find(p => p.kind === 'value')?.key) || 'customer.name';
    return `## Documents you may fill (existing designs — never invent an id)

${lines.join('\n')}${moreDocs}

This is only a catalog preview. Use builder_search_documents to search all templates, then builder_read_document to read the complete parameter instructions and relevant sections BEFORE binding values. Pin the returned versionId as documentVersionId. Required values and unresolved conditions block final output.

A fill_document step: {type:"fill_document", spec:{documentId:"${ex.id}", values:{"${exHole}":"{{steps.x.output.name}}"}}}. Keys in \`values\` are the placeholder names EXACTLY as listed above; a (list) placeholder must be bound to a whole array — write it as a single "{{steps.x.output.rows}}" and nothing else, or it arrives as text and the block renders empty. The step outputs a PDF as {fileId, filename, …}, the same shape send_email attachments and approval attachments take.`;
}

module.exports = { renderCatalog, renderCatalogLean, renderCatalogSlim, scoreRelevantTools, renderRelevantToolSchemas, renderDatatablesBlock, renderDocumentsBlock };

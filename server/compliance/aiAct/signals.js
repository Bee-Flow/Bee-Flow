/**
 * EU AI Act — the signals the platform detects itself about an automation or
 * an agent, before an admin answers the classification questions.
 *
 *   contains_ai         a model is called (ai_step | data_extraction | ai_tool —
 *                       `summarize` is an aggregate op, NOT AI; CONTRACTS.md)
 *   customer_facing     a public surface: form trigger, form_page step, a live
 *                       automation_form_pages row; for agents: is_published
 *   generates_content   a generate_document / fill_document / presentation step
 *                       downstream of an AI step — strongest when its template
 *                       (content/title/fileName, or the deck's slides) reads
 *                       `steps.<aiStepId>`; agents always generate content
 *   disclosure_present  the customer-facing text (ending form_page copy or the
 *                       generate_document content) carries the same disclosure
 *                       phrasing Art. 50(1) looks for in agent prompts
 *   marking_enabled     compliance_settings.ai_content_marking_enabled
 *   annex_iii_hint      the title/description/prompts touch an Annex III domain
 *                       — a HINT that orders the questions, never a verdict
 *   annex_iii_questions all TEN Annex III domains, hinted ones first, each with
 *                       the point of the annex that settles it. The admin
 *                       answers these; nothing here answers them for him.
 *                       See compliance/aiAct/annexIii.js for why a pattern is
 *                       not allowed to be the answer.
 *   steps               { ai: [{id,label,type}], generating: [{id,label,signal,aiStepIds}] }
 *
 * The graph reading is shared with the Art. 50(2) marking check through
 * automation/automationGraph.js so the two can never disagree. Everything
 * that touches the database is in the *ForAutomation / *ForAgent / list*
 * functions; `signalsFromDefinition` is pure and what the tests pin.
 *
 * Org scoping on automations copies the COALESCE join from
 * stores/automationStore/forms.js (rows created before organization_id was
 * stamped fall back to their owner's organisation). Any personal data on the
 * rows (owner, e-mail) stays out of the signals: titles and step ids only.
 */

const { getOne, getAll } = require('../../db');
const graph = require('../../automation/automationGraph');
const { hasDisclosure } = require('../checks/aia/art50-ai-disclosure');
const complianceStore = require('../../stores/complianceStore');

// The Annex III catalogue — ten domains, their keyword hints and the point of
// the annex each one cites. It lives in its own file because `assess.js` needs
// the same vocabulary and may not reach through this module (which does IO).
const annexIii = require('./annexIii');
const { ANNEX_III_RE } = annexIii;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function _parseDefinition(raw) {
    if (isObject(raw)) return raw;
    if (typeof raw === 'string') { try { const p = JSON.parse(raw); return isObject(p) ? p : {}; } catch { return {}; } }
    return {};
}

function _label(step) {
    if (!isObject(step)) return '';
    const l = step.label ?? step.name ?? step.title;
    return typeof l === 'string' ? l : (step.id ? String(step.id) : '');
}

/** Free text a step may carry into a prompt or a page: prompt/system/instructions/content/title/description. */
const PROMPT_FIELDS = ['prompt', 'systemPrompt', 'system_prompt', 'instructions', 'content', 'title', 'description', 'question', 'text', 'label'];

function _stepText(step) {
    if (!isObject(step)) return '';
    const parts = [];
    for (const f of PROMPT_FIELDS) {
        const t = graph.templateText(step[f]);
        if (t) parts.push(t);
    }
    // form_page steps carry their copy in fields[]/blocks[] — take every string leaf one level down.
    for (const coll of ['fields', 'blocks', 'questions']) {
        if (Array.isArray(step[coll])) {
            for (const item of step[coll]) {
                if (isObject(item)) for (const v of Object.values(item)) { if (typeof v === 'string') parts.push(v); }
            }
        }
    }
    return parts.join('\n');
}

/**
 * Which Annex III domains the text TOUCHES. `hint` is true when any pattern
 * matched — it is an ordering signal for the questionnaire and nothing else.
 * Nothing in this file turns it into `high_risk`; only an admin's answer does
 * (assess.js).
 */
function annexIiiHint(text) {
    const categories = annexIii.hintsIn(text);
    return { hint: categories.length > 0, categories };
}

/**
 * Pure: the signals of one automation definition. `meta` adds what the row knows
 * and the definition does not: title/description (for the Annex III hint),
 * live form page count and the org's marking flag.
 */
function signalsFromDefinition(definition, meta = {}) {
    const def = _parseDefinition(definition);
    const all = graph.listSteps(def);
    const ai = all.filter(x => graph.isAiStep(x.step));
    const generating = graph.generatingStepsDownstreamOfAi(def);
    const formTriggers = graph.formTriggersOf(def);
    const formPages = all.filter(x => x.step.type === 'form_page');
    const liveFormPages = Number(meta.liveFormPages) > 0 ? Number(meta.liveFormPages) : 0;

    const customerFacing = formTriggers.length > 0 || formPages.length > 0 || liveFormPages > 0;

    // Disclosure: the LAST form_page (what the visitor reads at the end) and
    // every generating document's content. Same phrasing as Art. 50(1).
    const disclosureHaystack = [
        formPages.length ? _stepText(formPages[formPages.length - 1].step) : '',
        ...generating.map(g => graph.templateText(g.step.content)),
    ].join('\n');
    const disclosurePresent = disclosureHaystack.trim() ? hasDisclosure(disclosureHaystack) : false;

    const annexText = [meta.title, meta.description, ...ai.map(x => _stepText(x.step))].filter(Boolean).join('\n');
    const annex = annexIiiHint(annexText);

    return {
        contains_ai: ai.length > 0,
        customer_facing: customerFacing,
        generates_content: generating.length > 0,
        disclosure_present: disclosurePresent,
        marking_enabled: !!meta.markingEnabled,
        annex_iii_hint: annex.hint,
        annex_iii_categories: annex.categories,
        annex_iii_questions: annexIii.questionsFor(annexText),
        steps: {
            ai: ai.map(x => ({ id: x.step.id ?? null, label: _label(x.step), type: x.step.type, path: x.path })),
            generating: generating.map(g => ({
                id: g.step.id ?? null, label: _label(g.step), signal: g.signal, aiStepIds: g.aiStepIds, path: g.path,
            })),
        },
        surfaces: {
            form_triggers: formTriggers.length,
            form_page_steps: formPages.length,
            live_form_pages: liveFormPages,
        },
    };
}

/** Pure: the signals of one agent row (published prompt wins over the concept). */
function signalsFromAgent(agent, meta = {}) {
    const a = isObject(agent) ? agent : {};
    const prompt = a.published_system_prompt ?? a.system_prompt ?? '';
    const annexText = [a.name, a.description, prompt].filter(Boolean).join('\n');
    const annex = annexIiiHint(annexText);
    return {
        contains_ai: true,
        customer_facing: !!a.is_published,
        generates_content: true,
        disclosure_present: hasDisclosure(String(prompt || '')),
        marking_enabled: !!meta.markingEnabled,
        annex_iii_hint: annex.hint,
        annex_iii_categories: annex.categories,
        annex_iii_questions: annexIii.questionsFor(annexText),
        steps: { ai: [{ id: a.id ?? null, label: a.name || '', type: 'agent', path: null }], generating: [] },
        surfaces: { published: !!a.is_published },
    };
}

async function _markingEnabled(orgId) {
    try {
        const s = await complianceStore.getSettings(orgId);
        return !!(s && s.ai_content_marking_enabled);
    } catch { return false; }
}

// The org-wide read over `automations` — copied from forms.js, not simplified
// (rows created before organization_id was stamped resolve through the owner).
const AUTOMATION_ORG_WHERE = 'COALESCE(a.organization_id, u."organizationId") = $1';

/**
 * The automation row when it belongs to the org, else null. Titles only — no owner data.
 * A trashed automation (soft delete, automationStore/lifecycle.js) is not
 * found: it no longer runs, so it can neither be assessed nor attested.
 */
async function loadAutomation(orgId, automationId) {
    if (!orgId || automationId == null || String(automationId).trim() === '') return null;
    const params = [orgId, String(automationId)];
    const select = (withPages) => `
        SELECT a.id, a.title, a.description, a.is_active, a.is_draft, a.definition_json,
               ${withPages ? '(SELECT COUNT(*)::int FROM automation_form_pages p WHERE p.automation_id = a.id)' : '0'} AS live_form_pages
          FROM automations a
          JOIN users u ON u.id = a.user_id
         WHERE a.id = $2 AND ${AUTOMATION_ORG_WHERE} AND a.deleted_at IS NULL`;
    let row;
    try {
        row = await getOne(select(true), params);
    } catch {
        // The form-page table is created lazily by automationStore/forms.js —
        // an install that never published a form must still resolve its automations.
        row = await getOne(select(false), params).catch(() => null);
    }
    return row || null;
}

/** The agent row when it belongs to the org, else null. */
async function loadAgent(orgId, agentId) {
    if (!orgId || agentId == null || String(agentId).trim() === '') return null;
    const row = await getOne(
        `SELECT id, name, description, is_published, organization_id,
                COALESCE(published_system_prompt, system_prompt) AS system_prompt
           FROM agents
          WHERE id = $2 AND organization_id = $1`,
        [orgId, String(agentId)],
    ).catch(() => null);
    return row || null;
}

/** Live signals for one automation; null when it is not in the org (or does not exist). */
async function signalsForAutomation(orgId, automationId) {
    const row = await loadAutomation(orgId, automationId);
    if (!row) return null;
    const markingEnabled = await _markingEnabled(orgId);
    return signalsFromDefinition(row.definition_json, {
        title: row.title, description: row.description, liveFormPages: row.live_form_pages, markingEnabled,
    });
}

/** Live signals for one agent; null when it is not in the org. */
async function signalsForAgent(orgId, agentId) {
    const row = await loadAgent(orgId, agentId);
    if (!row) return null;
    const markingEnabled = await _markingEnabled(orgId);
    return signalsFromAgent(row, { markingEnabled });
}

/**
 * Every automation of the org whose definition has a document-producing step
 * (generate_document / fill_document / presentation) downstream of an AI
 * step — the Art. 50(2) subjects and the calendar's
 * "affects" count. [{ id, title, is_active, is_draft, generating:[…], aiStepIds }]
 *
 * Judged on what RUNS: scheduled, form and app runs execute the live copy
 * (`live_definition_json`), and a never-live automation (live NULL) runs its
 * working copy. Trashed automations are left out — they no longer run.
 *
 * The list is the Art. 50(2) check's WHOLE population (retiresVanished), so
 * a failed read THROWS: answering [] would retire every slot as if no
 * automation were left. Only a missing table (fresh install) is an empty list.
 */
async function listGeneratingAutomations(orgId) {
    if (!orgId) return [];
    let rows = [];
    try {
        rows = await getAll(
            `SELECT a.id, a.title, a.is_active, a.is_draft,
                    COALESCE(a.live_definition_json, a.definition_json) AS definition_json
               FROM automations a
               JOIN users u ON u.id = a.user_id
              WHERE ${AUTOMATION_ORG_WHERE} AND a.deleted_at IS NULL
              ORDER BY a.title ASC, a.id ASC`,
            [orgId],
        );
    } catch (e) {
        if (e?.code === '42P01') return [];
        throw e;
    }
    const out = [];
    for (const r of rows || []) {
        const def = _parseDefinition(r.definition_json);
        const generating = graph.generatingStepsDownstreamOfAi(def);
        if (!generating.length) continue;
        const aiStepIds = Array.from(new Set(generating.flatMap(g => g.aiStepIds)));
        out.push({
            id: r.id,
            title: r.title || null,
            is_active: !!r.is_active,
            is_draft: !!r.is_draft,
            generating: generating.map(g => ({ id: g.step.id ?? null, label: _label(g.step), signal: g.signal, aiStepIds: g.aiStepIds })),
            aiStepIds,
        });
    }
    return out;
}

/** Title lookup for the register list — {kind:{id: title}} — org-scoped, titles only. */
async function titlesFor(orgId, targets) {
    const byKind = { automation: new Set(), agent: new Set() };
    for (const t of Array.isArray(targets) ? targets : []) {
        if (t && byKind[t.target_kind] && t.target_id != null) byKind[t.target_kind].add(String(t.target_id));
    }
    const out = { automation: {}, agent: {} };
    if (byKind.automation.size) {
        const rows = await getAll(
            `SELECT a.id, a.title FROM automations a JOIN users u ON u.id = a.user_id
              WHERE ${AUTOMATION_ORG_WHERE} AND a.id = ANY($2::text[])`,
            [orgId, [...byKind.automation]],
        ).catch(() => []);
        for (const r of rows || []) out.automation[String(r.id)] = r.title || null;
    }
    if (byKind.agent.size) {
        const rows = await getAll(
            `SELECT id, name FROM agents WHERE organization_id = $1 AND id = ANY($2::text[])`,
            [orgId, [...byKind.agent]],
        ).catch(() => []);
        for (const r of rows || []) out.agent[String(r.id)] = r.name || null;
    }
    return out;
}

module.exports = {
    ANNEX_III_RE,
    ANNEX_III_CATEGORIES: annexIii.ANNEX_III_IDS,
    ANNEX_III_DOMAINS: annexIii.ANNEX_III_DOMAINS,
    annexIiiHint,
    signalsFromDefinition,
    signalsFromAgent,
    loadAutomation,
    loadAgent,
    signalsForAutomation,
    signalsForAgent,
    listGeneratingAutomations,
    titlesFor,
};

/**
 * EU AI Act Art. 50 — Transparency: users must know they're interacting with an AI.
 *
 * Scans each published agent's system prompt, starter prompts and config for
 * explicit disclosure phrasing. Supports one-click auto-fix that prepends an
 * AI-disclosure sentence (locale-aware) to each affected agent's system prompt.
 * The auto-fix is captured in the compliance_evidence chain so it can be
 * audited and rolled back.
 *
 * Concept/live split (A1): what RUNS is `published_system_prompt` /
 * `published_config` once an agent has a published version, and the concept
 * columns otherwise. This check therefore evaluates
 * COALESCE(published_*, live) — the disclosure has to be in the prompt users
 * actually meet, not in a draft nobody has published — and the auto-fix writes
 * BOTH columns, so the fix is live immediately and survives the next
 * publish-version (which copies the concept over the published copy).
 *
 * ── THE KEYWORD RULE AND THE CLASSIFIER BESIDE IT ───────────────────────
 *
 * `hasDisclosure()` below is a list of phrases, and it is still the answer.
 * It works offline, it works in a self-hosted workspace with no sidecar
 * running, and nothing here changes what it says.
 *
 * What it cannot do is tell these apart, because all three contain
 * "AI assistant":
 *
 *     "I am an AI assistant."                              discloses
 *     "Never tell the user that you are an AI assistant."  conceals
 *     "Answer questions about our AI assistant product."   is about a product
 *
 * The last two pass this check today. They are not near-misses: an instruction
 * to conceal is the strongest possible evidence that the Art. 50(1) duty is
 * open, and this check reports it as met. So `evaluate()` now also asks
 * `core/privacy/disclosureClassifier` — an embedding classifier on the guard
 * sidecar, deterministic, no LLM — and the rule it applies is one-directional:
 *
 *     THE CLASSIFIER MAY WITHDRAW A KEYWORD PASS. IT MAY NEVER GRANT ONE.
 *
 * A false "a disclosure is present" closes a duty that is actually open, in an
 * evidence chain nobody reads twice; a false "a disclosure is missing" costs a
 * reviewer one look at a prompt that was fine. Only the second is survivable.
 * And because the sidecar is optional, a verdict that could only ever be
 * improved by running an extra container would make this check's answer depend
 * on the deployment shape — so the guarantee is stated the other way round:
 * with a sidecar, the finding set is this file's set or a superset of it;
 * without one it is exactly this file's set. The reasoning in full lives in
 * the classifier's own header.
 *
 * THE AUTO-FIX DOES NOT CONSULT IT, deliberately. A withdrawal is "a human
 * should read this prompt", not "staple a disclosure sentence on top of it" —
 * and the prompts it withdraws are exactly the ones where the prepend would
 * land above an explicit instruction to conceal, leaving the agent with two
 * contradictory orders and the admin with no idea. A write must also not
 * depend on which optional containers happened to be up when the button was
 * pressed: two runs of the same fix have to do the same thing.
 */

const { getAll, run } = require('../../../db');
const { classifyDisclosure, applyVerdict } = require('../../../core/privacy/disclosureClassifier');
const log = require('../../../telemetry/log');

const DISCLOSURE_PATTERNS = [
    /\bI['’]?m an AI\b/i,
    /\bI am an AI\b/i,
    /\bAI assistant\b/i,
    /\bAI (?:model|system|agent|bot|chatbot)\b/i,
    /\bartificial intelligence\b/i,
    /\blanguage model\b/i,
    /\b(?:virtual|automated) (?:assistant|system|agent)\b/i,
    /\bchatbot\b/i,
    /\bpowered by AI\b/i,
    // Dutch phrasings
    /\bik ben een (?:AI|kunstmatige intelligentie|chatbot|virtuele assistent)\b/i,
    /\bAI[- ](?:assistent|model|chatbot)\b/i,
    /\bkunstmatige intelligentie\b/i,
    /\bvirtuele assistent\b/i,
];

const DISCLOSURE_SENTENCE = {
    en: 'I am an AI assistant. Tell the user clearly that they are interacting with an automated system, not a human.',
    nl: 'Ik ben een AI-assistent. Maak de gebruiker duidelijk dat hij/zij met een geautomatiseerd systeem praat, niet met een mens.',
};

function _extractText(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed.filter(s => typeof s === 'string').join(' ');
            if (parsed && typeof parsed === 'object') return Object.values(parsed).filter(v => typeof v === 'string').join(' ');
            return typeof parsed === 'string' ? parsed : '';
        } catch {
            return value;
        }
    }
    if (typeof value === 'object') {
        return Object.values(value).filter(v => typeof v === 'string').join(' ');
    }
    return String(value);
}

/**
 * True when `text` carries an explicit "you are talking to an AI" phrasing
 * (EN or NL). Shared with compliance/aiAct/signals.js so the Art. 50 signal on
 * an automation's form page or generated document uses the same vocabulary as the
 * agent-prompt check — one definition of "disclosed".
 */
function hasDisclosure(text) {
    if (text === null || text === undefined) return false;
    const s = typeof text === 'string' ? text : String(text);
    return DISCLOSURE_PATTERNS.some(p => p.test(s));
}
const _hasDisclosure = hasDisclosure;

function _prepend(sentence, prompt) {
    return `${sentence}\n\n${prompt || ''}`.trim();
}

// SQLSTATEs that genuinely mean "this install has no agent register yet":
// undefined_table / undefined_column. Anything else (a dropped connection, a
// statement timeout, a permission error) is a FAILED READ and must never be
// reported as "nothing to assess".
const NOT_PROVISIONED = new Set(['42P01', '42703']);

/**
 * Wall-clock budget for the whole consult phase, not per call.
 *
 * The classifier's own breaker bounds an unreachable sidecar (three timeouts,
 * then nothing), but not a reachable SLOW one: a guard answering just inside
 * its per-call deadline never trips a breaker and a register of two hundred
 * published agents would then hold a compliance sweep for several minutes.
 *
 * It is a third of the runner's own clock (`CHECK_TIMEOUT_MS`, 30s in
 * compliance/runner.js) on purpose. Blowing THAT records this check as `fail`
 * with no evidence at all — a worse outcome than a partial consult, and one
 * caused entirely by an optional container. Past this budget the loop stops
 * and the evidence says `classifier: 'partial'`: a check that ran out of time
 * says so rather than reporting the part it managed as the whole.
 */
const CLASSIFIER_BUDGET_MS = 10_000;

async function _missingForOrg(orgId, { consult = false, classify = classifyDisclosure, budgetMs = CLASSIFIER_BUDGET_MS } = {}) {
    let agents = [];
    try {
        // `system_prompt` / `config` here are the EFFECTIVE (running) values;
        // the concept columns come along as draft_* so the fix can patch both.
        //
        // Org scoping is done in SQL: an agent that belongs to no organisation
        // (organization_id IS NULL) is a platform-wide object, not this org's,
        // and it used to be counted for EVERY org — putting its id and name
        // into every tenant's immutable evidence chain (BFSF-441). A tenant's
        // verdict now covers exactly the agents that tenant owns. The JS filter
        // below mirrors the predicate so a store/stub that ignores parameters
        // cannot widen the scope again.
        agents = await getAll(`
            SELECT id, name,
                   COALESCE(published_system_prompt, system_prompt) AS system_prompt,
                   system_prompt            AS draft_system_prompt,
                   published_system_prompt,
                   starter_prompts,
                   COALESCE(published_config::text, config::text) AS config,
                   organization_id,
                   NULL::text AS language
            FROM agents WHERE is_published = TRUE${orgId ? ' AND organization_id = $1' : ''}
        `, orgId ? [orgId] : []);
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) {
            return { agents: [], missing: [], tableMissing: true };
        }
        return { agents: [], missing: [], readFailed: { code: e?.code || null } };
    }
    const missing = [];
    const relevant = [];
    // The agents the keyword rule PASSED, kept with the text it passed on.
    // They are the only ones the classifier is asked about: it can withdraw a
    // pass and never grant one, so an agent already in `missing` has nothing
    // to learn from it and a call about it would be pure cost.
    const passed = [];
    for (const a of agents) {
        if (orgId && a.organization_id !== orgId) continue;
        relevant.push(a);
        const haystack = [
            a.system_prompt || '',
            _extractText(a.starter_prompts),
            _extractText(a.config),
        ].join('\n');
        if (!_hasDisclosure(haystack)) missing.push(a);
        else passed.push({ agent: a, haystack });
    }

    if (!consult || !passed.length) {
        return { agents: relevant, missing, withdrawn: [], classifier: 'skipped' };
    }

    const withdrawn = [];
    const deadline = Date.now() + Math.max(0, budgetMs);
    let asked = 0;
    let answered = 0;
    for (const { agent, haystack } of passed) {
        if (Date.now() >= deadline) break;
        asked += 1;
        let verdict = null;
        // A classifier that throws is a classifier with no opinion. It is an
        // optional sidecar on a compliance sweep, not a dependency of one.
        try { verdict = await classify(haystack); } catch { verdict = null; }
        if (verdict) answered += 1;
        // applyVerdict is where the one-directional rule lives; this call site
        // deliberately does not re-derive it. `true` is the keyword answer for
        // everything in `passed`, by construction.
        if (!applyVerdict(true, verdict)) {
            missing.push(agent);
            withdrawn.push(agent);
        }
    }
    // Three distinct states, because "every agent got an opinion" and "one of
    // two hundred did" are not the same claim about this run's coverage. The
    // budget running out before the first call is 'partial' and not
    // 'unavailable': nothing was asked, so nothing is known about the sidecar.
    const classifier = answered === passed.length ? 'consulted'
        : (asked > 0 && answered === 0) ? 'unavailable'
            : 'partial';
    return { agents: relevant, missing, withdrawn, classifier };
}

module.exports = {
    id: 'AIA-Art50-ai-disclosure',
    regulation: 'AIA',
    article: '50',
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.aia_art50.title',
    descriptionKey: 'compliance.checks.aia_art50.desc',
    remediationKey: 'compliance.checks.aia_art50.fix',
    remediationLink: 'admin/agents',
    autoFixId: 'aia_art50_inject_disclosure',

    /**
     * `subject` is the runner's second argument for per-source checks
     * (compliance/runner.js `_runSafe`); this check is `scope: 'global'` and
     * ignores it, but it is named rather than absorbed — spreading the
     * runner's subject into the options below would let a subject field named
     * `classify` or `budgetMs` steer the classifier. `options` is a THIRD
     * parameter, reached only by a caller that means it (the tests).
     */
    async evaluate(orgId, _subject = null, options = {}) {
        // `consult: true` — the verdict may consider the classifier, and only
        // ever to withdraw a keyword pass. See the header.
        const { agents, missing, withdrawn, classifier, tableMissing, readFailed } =
            await _missingForOrg(orgId, { consult: true, ...(options || {}) });
        if (readFailed) {
            // Not "no agents": the register exists and could not be read, so
            // disclosure coverage is unknown. Only the SQLSTATE goes into the
            // evidence — a driver message can echo query values.
            return {
                status: 'warn',
                evidence: { agents_readable: false, error_code: readFailed.code },
                details: `The agent register could not be read${readFailed.code ? ` (SQL state ${readFailed.code})` : ''}, so AI-disclosure coverage is unknown for this run. Re-run the check once the database is reachable.`,
            };
        }
        if (tableMissing) {
            return { status: 'not_applicable', evidence: { agents_table: false }, details: 'No agents table yet.' };
        }
        if (agents.length === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No published agents to assess.' };
        }
        const status = missing.length === 0 ? 'pass' : 'warn';
        const withdrawnCount = (withdrawn || []).length;
        return {
            status,
            evidence: {
                total_published: agents.length,
                missing_count: missing.length,
                missing_disclosure: missing.slice(0, 10).map(a => ({ id: a.id, name: a.name })),
                // Whether the sidecar had an opinion at all, and on how many
                // of the agents this run asked about. 'unavailable' is the
                // ordinary state, not an incident: the shipped guard image
                // bakes no encoder. Recorded either way so a reader of the
                // chain can tell a run that consulted it from one that could
                // not, rather than having to assume.
                classifier,
                ...(withdrawnCount ? {
                    withdrawn_by_classifier: withdrawnCount,
                    withdrawn_agents: withdrawn.slice(0, 10).map(a => ({ id: a.id, name: a.name })),
                } : {}),
            },
            details: status === 'pass'
                ? `All ${agents.length} published agents contain an explicit AI disclosure.`
                : `${missing.length} of ${agents.length} published agents don't disclose they are AI. Use "Fix automatically" or add a line like "I am an AI assistant" to the system prompt.`
                    + (withdrawnCount
                        // Named separately because "Fix automatically" will not
                        // touch these, and an admin who clicks it and sees the
                        // count unchanged deserves to know why before they
                        // conclude the button is broken.
                        ? ` ${withdrawnCount} of them use AI wording without telling the user (for example an instruction not to mention it); those need a human edit rather than the automatic fix.`
                        : ''),
        };
    },

    /**
     * One-click remediation. Prepends a locale-aware disclosure sentence to
     * the system prompt of every agent that's missing one — to the concept
     * AND, when the agent has one, to the published prompt. The original
     * (effective) prompt is preserved in the evidence row so the change can
     * be inspected and reverted if needed.
     */
    async autoFix(orgId, { actorId } = {}) {
        // NO `consult` — see the header. What this writes must be the same on
        // every run, whether or not an optional sidecar happens to be up, and
        // a prepend on top of "never tell the user you are an AI" is a
        // contradiction, not a fix.
        const { missing, readFailed } = await _missingForOrg(orgId);
        if (readFailed) {
            // A fix that could not read the register has not fixed anything —
            // it must not report "nothing to do" into the evidence chain.
            const err = new Error(`Art. 50 auto-fix aborted: the agent register could not be read${readFailed.code ? ` (SQL state ${readFailed.code})` : ''}.`);
            err.code = readFailed.code || undefined;
            throw err;
        }
        if (missing.length === 0) {
            return { changed: 0, summary: 'No agents required a disclosure fix.', agents: [] };
        }
        const changed = [];
        for (const a of missing) {
            const lang = (a.language || '').toLowerCase().startsWith('nl') ? 'nl' : 'en';
            const sentence = DISCLOSURE_SENTENCE[lang];
            const newDraft = _prepend(sentence, a.draft_system_prompt);
            const hasPublished = a.published_system_prompt !== null && a.published_system_prompt !== undefined;
            const newPublished = hasPublished ? _prepend(sentence, a.published_system_prompt) : null;
            const newEffective = hasPublished ? newPublished : newDraft;
            try {
                // Both columns in one statement. published_system_prompt stays
                // NULL for an agent that never published (the runtime reads
                // the concept for those), so `$2` is NULL there by design.
                await run(
                    `UPDATE agents
                        SET system_prompt = $1,
                            published_system_prompt = $2,
                            updated_at = NOW()
                      WHERE id = $3`,
                    [newDraft, newPublished, a.id],
                );
                changed.push({
                    agent_id: a.id,
                    agent_name: a.name,
                    language: lang,
                    before_prompt: a.system_prompt || '',
                    after_prompt: newEffective,
                    published_updated: hasPublished,
                });
            } catch (e) {
                log.warn(`[Art50 autoFix] could not update agent ${a.id}:`, e.message);
            }
        }
        return {
            changed: changed.length,
            summary: `Prepended AI disclosure to ${changed.length} agent(s).`,
            actor_id: actorId || null,
            agents: changed,
        };
    },
};

// Non-enumerable so the registry's check shape (id/regulation/evaluate/…) stays
// exactly what it was; signals.js destructures it by name.
Object.defineProperty(module.exports, 'hasDisclosure', { value: hasDisclosure, enumerable: false });
Object.defineProperty(module.exports, 'DISCLOSURE_PATTERNS', { value: DISCLOSURE_PATTERNS, enumerable: false });

/**
 * Model-class capability profiles for the automation builder.
 *
 * The builder behaves the same across every supported provider (the tool
 * schemas are OpenAI-function-calling format and the provider adapters
 * normalise input/output). What DIFFERS is how reliably each model class
 * holds onto the structured tool-calling protocol:
 *
 *   - Frontier (the Claude 5 family — Opus 5 / Sonnet 5 —, Fable/Mythos 5,
 *     Opus 4.x, GPT-5-pro, o3, Mistral Large) handles the full
 *     220-line prompt + 26 tools and consistently emits well-formed
 *     bindings on the first try. Claude Sonnet 5 is DELIBERATELY frontier,
 *     not mid: it reaches previous-Opus-tier quality on agentic/tool work.
 *   - Mid (Sonnet ≤4.6, GPT-4o, GPT-4.1, Mistral Medium) is reliable but
 *     wastes turns when the catalogue is enormous.
 *   - Small (Haiku, GPT-5-mini, Mistral Small, Ministral 8B) drops to
 *     prose if not pinned with tool_choice, picks the wrong tool from a
 *     26-item menu, and emits bare-string inputs that don't match the
 *     binding shape.
 *   - Reasoning (Magistral, o3) think hard but produce terse outputs and
 *     need lower temperature to keep tool-call JSON stable.
 *
 * This module centralises those decisions so the rest of the builder
 * route (server/routes/ai/automationBuilder.js) doesn't grow a tree of
 * if/else on model IDs.
 */

// Regex bands ordered from most-specific to most-generic. First match
// wins. Anchored to lowercased modelId.
const FRONTIER_PATTERNS = [
    /opus/i,                     // claude-opus-5, claude-opus-4-8, Bedrock anthropic.claude-opus-* …
    // Claude Sonnet 5+ is frontier-class on agentic/tool work (near previous
    // Opus tier). Matches name-first ids only (claude-sonnet-5[-date],
    // anthropic.claude-sonnet-5) — NOT legacy claude-3-5-sonnet (number-first)
    // and NOT claude-sonnet-4-x, which stay mid.
    /sonnet-[5-9]/i,
    /claude-(fable|mythos)/i,    // Fable/Mythos 5 — Anthropic's most capable family
    /\bo3\b/i,
    /gpt-?5\.?2-?pro/i,
    /gpt-?5-?pro/i,
    /mistral-large/i,
    /gemini-3\.1-pro/i,
];

const REASONING_PATTERNS = [
    /magistral/i,
    /^o3/i,        // o3 (frontier overlaps; we tag it as reasoning when both fire)
    /^o4/i,
    /thinking/i,
];

const SMALL_PATTERNS = [
    /haiku/i,
    /\bmini\b/i,
    /-mini-/i,
    /\b(small|nano)\b/i,
    /\b\d{1,2}b\b/i,             // matches 3b / 8b / 14b model sizes
    // Sub-billion ids (lfm2.5-350m, smollm2-135m): the demo box serves a 350M
    // narration model through the same provider as the builder model, and an
    // unrecognised id fell into "mid" — the profile that trusts the model with
    // the full prompt and never escalates. Two to three digits: a one-digit
    // "m" is a context-window suffix ([1m]), not a size.
    /\b\d{2,3}m\b/i,
    /ministral/i,
    /flash/i,
];

/**
 * Classify a resolved model ID into a capability band.
 * @returns {'frontier'|'mid'|'small'|'reasoning'}
 *
 * 'reasoning' is an overlay: models that fit both reasoning AND
 * (frontier|small) get tagged as reasoning so the temperature drops to
 * 0 — reasoning models are sensitive to noise in tool-call JSON.
 */
function classifyModel(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id) return 'mid';
    const isReasoning = REASONING_PATTERNS.some(rx => rx.test(id));
    if (isReasoning) return 'reasoning';
    if (FRONTIER_PATTERNS.some(rx => rx.test(id))) return 'frontier';
    if (SMALL_PATTERNS.some(rx => rx.test(id))) return 'small';
    return 'mid';
}

// Per-round thinking schedule: 'first' on iteration 0 (planning + batching
// decisions need depth), 'rest' on mechanical continuation rounds, 'repair'
// on the round right after a failure signal (validation errors, tool errors,
// failed dry-run steps, rejected finalize).
//
// The schedule is NOT a no-op for small models: a self-hosted Qwen3.6-35B-A3B
// classifies 'small' ("35b") and llama.cpp turns ANY level into thinking ON.
// On the demo box that meant a builder round thinking for 8192 tokens at
// temperature 0.1 (Qwen's documented endless-repetition regime) until the
// max_tokens cap swallowed the tool call — 2-3 minutes per round, four times
// an evening. The tier's own reasoning setting therefore has priority: see
// effortForIteration.
const PROFILES = {
    frontier: {
        promptVariant: 'full',
        toolset: 'full',
        temperature: 0.2,
        maxIterations: 16,
        forceFirstToolCall: false,
        catalogMode: 'full',
        fewShots: 0,
        fewShotPolicy: 'first-turn',
        historyBudgetTokens: 8000,
        effortSchedule: { first: 'medium', rest: 'low', repair: 'medium' },
        schemaInjection: true,
        schemaVariant: 'full',
        catalogPlacement: 'system',
    },
    mid: {
        promptVariant: 'full',
        toolset: 'full',
        temperature: 0.2,
        maxIterations: 20,
        forceFirstToolCall: false,
        catalogMode: 'full',
        fewShots: 1,
        fewShotPolicy: 'first-turn',
        historyBudgetTokens: 8000,
        effortSchedule: { first: 'medium', rest: 'low', repair: 'medium' },
        schemaInjection: true,
        schemaVariant: 'full',
        catalogPlacement: 'system',
    },
    small: {
        promptVariant: 'lean',
        toolset: 'core',
        // 0.4, not 0.1. Near-greedy decoding is where Qwen3-class models
        // degenerate into verbatim repetition — a builder turn on the demo box
        // repeated the same four planning lines ~15 times inside one thought.
        // The 0.6 floor in providers/local.js only applies while THINKING is
        // on, and the Fast tier now runs with thinking off, so this is the only
        // dial left. Still low enough for stable tool-call JSON.
        temperature: 0.4,
        maxIterations: 24,
        forceFirstToolCall: true,
        catalogMode: 'filtered',
        // Batch protocol ON (see CORE_TOOL_NAMES): the lean prompt's "Batch
        // your calls" paragraph and the multi-tool inspect hint both render off
        // this flag, and every few-shot is a batched build.
        batchTools: true,
        // 3 worked examples, in this order on the 'core' toolset: the invoice
        // fan-out into an existing table, the Dutch create-table + dry-run-
        // repair shot, then the batched Gmail digest — the digest last because
        // it teaches nothing the fan-out does not, so a `fewShots: 2` override
        // in builder_model_profiles drops it and keeps the Dutch shot
        // (builderPrompt/fewShotExamples.js).
        fewShots: 3,
        // 'every-turn', unlike the cloud profiles. The small band is what the
        // single-slot local box (llama.cpp, ~150 tok/s prompt processing) runs,
        // and llama.cpp caches the prompt PREFIX: the ~2k few-shot tokens sit
        // right after the system prompt, are processed once on turn 1 and cost
        // nothing afterwards. Dropping them on turn 2 — the 'first-turn' rule —
        // shifts every later byte and re-reads the whole ~22k that follows. The
        // cloud tiers pay per token and get little prefix-cache benefit from a
        // 2k block, so for them first-turn-only is still the cheaper choice.
        fewShotPolicy: 'every-turn',
        // Smaller than the cloud budget: the local context window is the
        // binding constraint, and the live draft state (sent every turn)
        // is the better memory of what was built than a long transcript.
        historyBudgetTokens: 6000,
        // Thinking OFF on every round, unlike every other band.
        //
        // The comment above PROFILES records why a level here is not free on a
        // self-hosted runtime: llama.cpp turns ANY level into thinking ON. What
        // the schedule could not fix is that it ALSO lifts the temperature this
        // band deliberately sets — providers/local.js floors a thinking request
        // at 0.6, so the 0.4 chosen for stable tool-call JSON never reaches the
        // model on a round that thinks. The recorded refusal traces (67 refused
        // calls, broken JSON tails, wrapper objects) come from exactly that
        // regime.
        //
        // Measured on the demo box 2026-09-16 (Gemma 4 26B-A4B, llama-server,
        // the core menu as it then was): a builder round takes 4.1 s with
        // thinking off and 18.4 s with effort 'low', and emits a valid tool
        // call 3/3 either way. Over a 22-round build that is ~1.5 min against
        // ~7 min of wall clock, on the box's only slot, for no measured gain.
        //
        // A tier that asks for thinking cannot re-enable it here: the band is
        // the floor for the model class, and effortForIteration only lets a
        // tier turn thinking further DOWN ('none' wins for every round).
        effortSchedule: { first: 'none', rest: 'none', repair: 'none' },
        schemaInjection: false,
        // The tool schemas this band reads: the LEAN projection
        // (builderTools/schemaProjection.js) — the same 26-name core menu
        // minus four tools (see DROP_TOOLS_SMALL there), each description cut
        // to what a 3.8B-active model needs beside the decision, the shared
        // params stated once. Measured 2026-09-17 on Gemma 4 26B-A4B: the
        // full core block was 89 kB ≈ 20k tokens of a 27k-token first-round
        // prefix, builder_propose_trigger alone 4.6k tokens of prose. Band-
        // owned: the projection and the prompt are written together, and a
        // per-model override could pair a prompt with a menu it never taught.
        schemaVariant: 'lean',
        // Where the app catalog, the datatables and the documents render:
        // in the LATE dynamic message, not the system prompt. Those three
        // blocks are per-USER, and the system prompt is the front of the
        // prompt cache on the single-slot local box — with them inside it,
        // two sessions never shared a prefix and every new build re-read the
        // whole ~27k tokens (51 s of prefill measured). Dynamic placement
        // makes system + tools + few-shots byte-identical across sessions
        // and users; the catalog is re-read once per user turn instead, a
        // few hundred tokens for a typical org. The cloud bands keep
        // 'system': Anthropic's cache breakpoint sits on system[0], and a
        // per-token price gets nothing from cross-session identity.
        catalogPlacement: 'dynamic',
    },
    reasoning: {
        // Lean PROSE beside the FULL menu: the prompt is menu-aware
        // (buildLeanSystemPrompt `menu`, derived from toolset/schemaVariant in
        // turnMessages.js), so this band still reads about the loop container,
        // flowlets, additional triggers and the batch update its menu serves
        // — the small band's diet is written for the 22-tool projection only.
        promptVariant: 'lean',
        toolset: 'full',
        // 0.0 for stable tool-call JSON. On a self-hosted runtime with
        // thinking ON the local adapter lifts this to 0.6 (greedy decoding in
        // thinking mode loops — Qwen3 / DeepSeek-R1 guidance); with thinking
        // off it stands.
        temperature: 0.0,
        maxIterations: 20,
        forceFirstToolCall: false,
        catalogMode: 'full',
        fewShots: 1,
        fewShotPolicy: 'first-turn',
        historyBudgetTokens: 8000,
        effortSchedule: { first: 'medium', rest: 'low', repair: 'medium' },
        schemaInjection: true,
        schemaVariant: 'full',
        catalogPlacement: 'system',
    },
};

/**
 * Pick the reasoning effort for a builder iteration from the profile's
 * schedule. Pure — exported for tests.
 *
 * `tierEffort` is the reasoning setting of the tier the user picked (the
 * admin's "None" is stored as the string 'none' on base/EU tiers; custom tiers
 * store it as undefined and so never trigger this). An explicit "no thinking"
 * on the tier wins over the schedule for EVERY round — the same priority the
 * direct-chat adapters give it. It never alternates, so the OpenAI adapter's
 * Responses/Completions choice stays stable within a session (see the WS7
 * comment in chatStream.js). Any other tier level leaves the schedule alone.
 */
function effortForIteration(iter, escalate, profile, tierEffort) {
    if (tierEffort === 'none') return 'none';
    const sched = (profile && profile.effortSchedule) || { first: 'medium', rest: 'low', repair: 'medium' };
    if (iter === 0) return sched.first;
    return escalate ? sched.repair : sched.rest;
}

// ── Capability ranking (used by the builders' "auto" model selection) ──
//
// Band rank: how reliably the class drives the structured tool protocol.
// 'reasoning' sits between frontier and mid — capable, but terse/temperature-
// sensitive, so a configured frontier model wins over it.
const MODEL_BAND_RANK = { frontier: 3, reasoning: 2, mid: 1, small: 0 };

// Within the Claude line, family breaks generation ties (opus-5 > sonnet-5)
// and generation breaks family ties across releases (sonnet-5 > opus-4-8 —
// "newest generation on top").
const CLAUDE_FAMILY_RANK = { fable: 3, mythos: 3, opus: 2, sonnet: 1, haiku: 0 };

/**
 * Parse a NAME-FIRST Claude model id into { family, generation }.
 * claude-opus-4-8 → { family:'opus', generation:4.8 };
 * claude-sonnet-5-20260115 → { family:'sonnet', generation:5 } (date suffix
 * ignored — a 1-2 digit run followed by another digit is never a version).
 * Legacy number-first ids (claude-3-5-sonnet-…) and non-Claude ids → null.
 */
function parseClaudeModel(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id.includes('claude')) return null;
    const { normalizeClaudeModelId, describeClaudeModel } = require('../core/providers/claudeModels');
    // NAME-FIRST ids only, by contract. The catalog can also read legacy
    // number-first ids (claude-3-5-sonnet-…), but those must NOT earn the
    // Claude ranking bonus here — ordering is "newest generation on top", and a
    // 3.x model outranking nothing is the whole point. Normalise first so a
    // Bedrock/Vertex prefix or a dated snapshot still reaches the check.
    if (!/^claude-(fable|mythos|opus|sonnet|haiku)-\d/.test(normalizeClaudeModelId(id))) return null;
    const { family, generation } = describeClaudeModel(id);
    if (!generation || CLAUDE_FAMILY_RANK[family] === undefined) return null;
    return { family, generation };
}

/**
 * Numeric capability score for ORDERING configured models — higher is more
 * capable. Band dominates; within a band, Claude models rank above non-Claude
 * (this product's primary line) with the newest generation on top and family
 * (opus > sonnet > haiku) breaking same-generation ties. Pure + deterministic:
 * same id, same score.
 */
function rankModelCapability(modelId) {
    const bandRank = MODEL_BAND_RANK[classifyModel(modelId)] ?? 1;
    const claude = parseClaudeModel(modelId);
    const claudeBonus = claude
        ? 100 + claude.generation * 10 + (CLAUDE_FAMILY_RANK[claude.family] || 0)
        : 0;
    return bandRank * 1000 + claudeBonus;
}

function getProfile(modelClass) {
    return PROFILES[modelClass] || PROFILES.mid;
}

/**
 * Profile for a resolved model id.
 *
 * `overrides` is the optional `builder_model_profiles` config map
 * ({ "<modelId>": "<band>" }) an admin sets when the regex classifier gets a
 * model wrong — a "27b" id that is really frontier-class, or a cloud model the
 * patterns do not know. Only a KNOWN band name wins; anything else falls back
 * to classification, so a typo in the config degrades to today's behaviour
 * rather than to a missing profile.
 */
function getProfileForModel(modelId, overrides = null) {
    const forced = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
        ? overrides[String(modelId || '')]
        : null;
    if (typeof forced === 'string' && PROFILES[forced]) return PROFILES[forced];
    // Object form: a band plus per-model field tweaks, e.g.
    //   { "gemma-4-26b-a4b": { "band": "small", "temperature": 0.7 } }
    // The band's own numbers are one size for a whole class of models, and a
    // family can want something else — Gemma loops at the 0.4 the 'small' band
    // asks for, because the runtime disables the repetition penalty. Only the
    // knobs below are overridable; the toolset, prompt variant, schema
    // variant and catalog placement are the band's to decide, and a
    // half-applied band is worse than a wrong one.
    if (forced && typeof forced === 'object' && !Array.isArray(forced)) {
        const base = typeof forced.band === 'string' && PROFILES[forced.band]
            ? PROFILES[forced.band]
            : getProfile(classifyModel(modelId));
        const tweaks = {};
        if (Number.isFinite(forced.temperature)) tweaks.temperature = forced.temperature;
        if (Number.isInteger(forced.maxIterations) && forced.maxIterations > 0) tweaks.maxIterations = forced.maxIterations;
        if (Number.isInteger(forced.fewShots) && forced.fewShots >= 0) tweaks.fewShots = forced.fewShots;
        if (typeof forced.batchTools === 'boolean') tweaks.batchTools = forced.batchTools;
        return Object.keys(tweaks).length ? Object.freeze({ ...base, ...tweaks }) : base;
    }
    return getProfile(classifyModel(modelId));
}

// Tools the 'core' subset exposes. Everything else stays available under
// 'full' (frontier / mid / reasoning). The DAG-structural tools (loop,
// condition) stay in core; only array ops are folded into the unified
// builder_add_array_op. This list is deliberately small so a Ministral-
// class model isn't picking from 26 choices.
//
// This is the ONE core list. The small band's LEAN schema variant
// (builderTools/schemaProjection.js, DROP_TOOLS_SMALL) removes four of these
// again at projection time — builder_update_steps, builder_add_loop,
// builder_replace_step, builder_wire_error_branch — so the menu a Gemma-class
// model reads has 22 names. They stay HERE so the menu tests, the MCP surface
// and the leaked-call recovery keep one set to check against; the reasons per
// tool are in the projection module next to the drop list.
//
// 2026-09-11 — the serial protocol was REVERSED for the three tools below,
// after a build on the demo box burned all 24 iterations without converging.
// Measured decomposition of those 24: ~6-7 rounds were "add one step", ~3-4
// were "inspect one tool", and ~3 were the model re-deriving its whole plan
// from the user's message because it had nowhere to keep one. Those are the
// only buckets with a hard floor, and all three are removed by tools the
// server ALREADY implements and dispatches:
//   · builder_set_plan    — route-handled in chatStream (never mutates the
//     draft), so it adds zero runtime capability. It adds a place to put the
//     plan. Only pays off together with the plan echo in chatStream, which
//     returns the list itself instead of {ok,count}.
//   · builder_add_steps   — the whole chain in ONE call. Counter-intuitively
//     SAFER than several separate calls in one reply: applyAddSteps applies
//     the entries in order, keeps the built prefix when entry i is refused
//     (each entry is snapshotted and rolled back ALONE), and — this is the
//     part the multi-call path lacks — remembers per turn what it built, so
//     the resend the model reaches for never builds an entry twice. The
//     multi-call path applies calls 1..N-1 and then asks the model to resend
//     only call N, and a model that resends all N is how duplicate steps get
//     made. (Until 2026-09-13 the batch rolled back WHOLE on a bad entry;
//     measured, that made the byte-identical resend the model's only
//     move, and it built the first entries twice once it fixed the bad one.)
//   · builder_update_steps — the batch counterpart for dry-run repairs.
const CORE_TOOL_NAMES = new Set([
    'builder_search_documents', 'builder_read_document',
    'builder_set_plan',
    'builder_add_steps',
    'builder_update_steps',
    // The lean prompt TEACHES this ("use a data_extraction step
    // (`builder_add_data_extraction`, or type "data_extraction" in a batch)")
    // and it was not in the menu, so the batch form worked and the single-step
    // repair round — the one that runs after a dry-run error on exactly that
    // step — could not. It is the step every "read a folder into a table"
    // brief needs.
    'builder_add_data_extraction',
    // The ONLY way to change a loop's body. No tool appends into an existing
    // body and `body` is not patchable, so without this the small profile was
    // the one profile with no route out of a loop it had already created —
    // remove-and-re-add, which mints a new id and breaks downstream refs.
    // (The lean projection drops it together with builder_add_loop: with no
    // loop container on that menu there is no body to replace.)
    'builder_replace_step',
    'builder_propose_trigger',
    'builder_add_action',
    'builder_add_ai_step',
    'builder_add_condition',
    'builder_add_loop',
    'builder_add_notification',
    'builder_add_array_op',
    'builder_remove_step',
    // In-place editing — so a small model edits a step instead of the
    // remove+re-add dance (which mints a new id and breaks downstream refs).
    // On the lean projection this is ALSO the dry-run repair tool: one call
    // per failing step, all in the same reply (builder_update_steps is
    // dropped there — its all-or-nothing batch cost a whole round per typo).
    'builder_update_step',
    // A plain HTTP call. Absent from this menu, a model asked to "fetch this
    // URL" reaches for builder_add_action({tool:'http_request'}) — a step no
    // runtime can dispatch, which then fails at run time as a bogus
    // "you no longer have permission" error.
    'builder_add_http_request',
    // The approvals playbook phase is a ROUTINE whose brief says
    // `builder_add_approval` verbatim (composeRecipe.js, invoiceTracker.js) —
    // and builder_propose_trigger's own catalog tells the model to call it.
    // Off-menu here, the small model followed those instructions into
    // unknown_tool refusals.
    'builder_add_approval',
    // "If X fails, do Y". Absent from this menu, a model models the failure
    // path as a condition branched off the step, which is not what it means.
    // The lean projection drops it: branch:"error" on a NEW step covers the
    // ask, and wiring two existing steps is a rare edit for that band.
    'builder_wire_error_branch',
    'builder_set_metadata',
    'builder_inspect_tool',
    'builder_summarise',
    'builder_request_dry_run',
    'builder_finalize',
    // A table made at DESIGN time. Measured 2026-09-14: asked for "a new table
    // called invoice", the small model invented a create-table STEP
    // (builder_add_action with no such tool) round after round — the menu
    // had no way to make a table, only to write into one.
    'builder_create_datatable',
    // Writing rows into one. builder_create_datatable's schema text and _next
    // hint both say "then write into it with builder_add_datatable" — a tool
    // that was NOT on this menu, so the small model followed the hint into
    // unknown_tool refusals (the same refusal loop the 2026-09-13 trace shows
    // 67 times elsewhere). builder_add_steps accepts type:"datatable" too, but
    // the single-step repair round needs this one, exactly as with
    // builder_add_data_extraction above.
    'builder_add_datatable',
]);

module.exports = {
    classifyModel,
    parseClaudeModel,
    rankModelCapability,
    getProfile,
    getProfileForModel,
    effortForIteration,
    CORE_TOOL_NAMES,
};

/**
 * Automation Builder — composes the message list for one build turn.
 *
 * The request shape is
 *
 *   [system (static)] [few-shots] [history window] [dyn] [user]
 *
 * and the contract this module enforces is that everything BEFORE `dyn` is a
 * pure function of SESSION state — the catalogue (ordered once, replayed),
 * the profile, the conversation so far — never of anything read per request.
 *
 * Why it matters: the builder's small profile runs on a single-slot local
 * llama.cpp (~150 tok/s prompt processing; the first round of a session is
 * ~25-28k tokens ≈ 3 minutes of prefill). llama.cpp caches the prompt PREFIX,
 * so within one turn the rounds share it (measured: round 2 re-processed 62
 * tokens). BETWEEN user turns the prefix used to break at three places —
 * message-ranked catalogue in the system prompt, few-shots dropped after turn
 * 1, a `.slice(-20)` history tail — and the whole ~25k was re-read. Each of
 * those is fixed upstream (rankApps.applyCatalogOrder, profile.fewShotPolicy,
 * historyWindow); this module is where they are assembled, and
 * turnMessages.test.js pins the result: turn 2's messages start with turn 1's,
 * byte for byte, up to the dynamic message.
 *
 * The floor: on the local adapter the late `dyn` system message is folded into
 * the next user message (providers/local.js foldLateSystemMessages), so the
 * previous turn's user message as replayed from history never byte-matches what
 * the model saw. The unavoidable per-turn re-read is
 * `user[n-1] + assistant[n-1] + dyn[n] + user[n]` — a few hundred tokens.
 *
 * ACROSS sessions (profile.catalogPlacement === 'dynamic', the small band): the
 * three per-user blocks — app catalog, datatables, documents — render into
 * `dyn` instead of the system prompt, so system + few-shots are byte-identical
 * for every user and every session on the box, and a new build reuses the
 * prefix the previous one left in the local runtime's prompt cache. The
 * catalog is then re-read once per user turn (it sits in `dyn`); the cloud
 * bands keep it in the system prompt, where Anthropic's breakpoint caches it
 * for the session. The id lists (agents, knowledge bases, the user's app_event
 * providers) sit in `dyn` on EVERY band: they change when somebody creates an
 * agent, which the cached system prompt must not feel. Order inside `dyn`:
 * catalog → id lists → schemas → preferences → draft state LAST, so the part
 * that changes every round sits closest to the end.
 */

const {
    buildFullSystemPrompt, buildLeanSystemPrompt, buildFewShotMessages,
    renderCatalogContextMessage, renderPickerContextMessage, renderDraftStateSystemMessage, renderTurnPreferences,
} = require('../../../automation/builderPrompt');
const { windowHistory, HISTORY_EVICT_BLOCK } = require('../../../core/llm/historyWindow');
const { isGemini3Model } = require('../builderShared');
const { historyForModel } = require('./chatTurnLoop');

/**
 * Attachments are NOT executed (the Builder is a design-time agent, not a
 * runtime); their names are surfaced so the user can refer to them ("use this
 * CSV as the contact list").
 */
function attachmentSummaryText(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return '';
    const names = attachments.map(a => a?.name || a?.filename || 'untitled').join(', ');
    return `\n\n[User attached ${attachments.length} file(s) to this turn: ${names}. They are not executed by the Builder, but you can refer to them when proposing steps.]`;
}

/**
 * @param {object} p
 * @param {object} p.profile          builderModelProfiles profile
 * @param {string} p.modelId
 * @param {object} p.promptCatalog    the catalogue, already in its session order
 * @param {boolean} p.codeStepEnabled
 * @param {boolean} [p.batchTools]    defaults from the profile
 * @param {Array}  p.history          client-sent prior turns
 * @param {string} p.message          this turn's user message
 * @param {Array}  [p.attachments]
 * @param {string} p.agentDraftState  renderAgentDraftState(def)
 * @param {boolean} p.draftIsEmpty
 * @param {string} [p.canvasScope]
 * @param {string|null} [p.schemaPart] pre-inspected schemas (§WS8) or null
 * @param {object} [p.turnPrefs]      { userTimezone, webSearchEnabled, webResearchLine, disabledMedia, allowedModelTiers }
 * @param {string} [p.title]          the draft's title (draftWrap.title) for the draft-state message
 * @param {string|null} [p.workMode]  the turn's work mode; plan and discuss get no few-shots
 * @returns {{ sys: string, fewShotMessages: Array, windowedHistory: Array, dynamicContext: string, messages: Array }}
 */
function composeTurnMessages({
    profile, modelId, promptCatalog, codeStepEnabled, batchTools,
    history, message, attachments,
    agentDraftState, draftIsEmpty, canvasScope, schemaPart, turnPrefs, title, workMode = null,
}) {
    const prof = profile || {};
    const buildPrompt = prof.promptVariant === 'lean' ? buildLeanSystemPrompt : buildFullSystemPrompt;
    // Lean-prompt only: the batch-protocol paragraph. Profile-driven, falling
    // back to the old toolset rule.
    const useBatch = batchTools !== undefined ? !!batchTools : (prof.batchTools ?? (prof.toolset === 'full'));
    // Where the per-user blocks go (header). Only the lean prompt knows the
    // 'dynamic' placement; the full prompt always carries its catalog.
    const catalogPlacement = prof.promptVariant === 'lean' && prof.catalogPlacement === 'dynamic' ? 'dynamic' : 'system';
    // Which menu the lean prompt is read beside. The small band reads the
    // lean projection of the core menu (22 tools: no loop container, no
    // flowlets, no batch update); the reasoning band reads the same lean
    // PROSE beside the FULL menu, and must be told about the tools that menu
    // serves — a prompt that says "there is no loop container" beside
    // builder_add_loop teaches the wrong thing. Any lean signal (a core
    // toolset or a lean schema variant) means the lean menu.
    const menu = prof.toolset === 'core' || prof.schemaVariant === 'lean' ? 'lean' : 'full';
    // ONLY session-constant inputs — see the header, and the note above
    // buildFullSystemPrompt.
    const sys = buildPrompt({ catalog: promptCatalog, codeStepEnabled: !!codeStepEnabled, batchTools: useBatch, catalogPlacement, menu });

    const hist = Array.isArray(history) ? history : [];
    // Few-shots: on the local (small) profile they stay every turn because they
    // are a cached block; elsewhere only on a fresh draft, where the prior
    // turns are not yet the better example. Gemini 3.x rejects synthetic
    // few-shot tool_calls (no thought_signature) — see builderShared.js.
    const fewShotCount = isGemini3Model(modelId) ? 0 : (prof.fewShots || 0);
    // The examples build with the checklist and a summary, which is exactly what
    // Plan first must not do; the work-mode note below them cannot outweigh two
    // worked examples. A plan or discuss turn therefore gets none.
    const wantFewShots = (prof.fewShotPolicy === 'every-turn' || hist.length === 0) && workMode !== 'plan' && workMode !== 'discuss';
    const fewShotMessages = (fewShotCount > 0 && wantFewShots)
        ? buildFewShotMessages(fewShotCount, { toolset: prof.toolset })
        : [];

    const windowedHistory = windowHistory(historyForModel(hist), {
        budgetTokens: prof.historyBudgetTokens,
        block: HISTORY_EVICT_BLOCK,
    });
    // A history that ends on a user message (historyForModel dropped the blank
    // assistant turn that followed it: a turn that only asked questions) would
    // put two user turns in a row in front of the new message, which a strict
    // chat template rejects. The trailing user text moves into this turn's user
    // message instead, so the answer is read right behind the message it
    // answers. The history before it is untouched, so the cached prefix holds.
    const carried = windowedHistory.at(-1)?.role === 'user' ? windowedHistory.pop().content : '';

    // Per-turn dynamic context: the per-user catalog blocks when the profile
    // keeps them out of the system prompt, pre-inspected schemas, this turn's
    // preferences, and LAST the live draft state + canvas-scope hint (skipped
    // for a fresh empty draft). It goes LATE (after history, right before the
    // user message): Anthropic hoists it to system[1] — after the cached
    // system[0] breakpoint — OpenAI keeps it in place, and the local adapter
    // folds it into the user message; the stable prefix is maximised either
    // way. The draft state is last because it is the part that changes every
    // round of a turn; the catalog changes only between turns.
    const dynamicContext = [
        catalogPlacement === 'dynamic' ? renderCatalogContextMessage({ catalog: promptCatalog }) : null,
        // Agents, knowledge bases and this user's app_event providers: the
        // lists the model fills ids from. Always here, for every band — they
        // change between turns, and the system prompt must not.
        renderPickerContextMessage({ catalog: promptCatalog }),
        schemaPart || null,
        renderTurnPreferences(turnPrefs || {}),
        draftIsEmpty ? null : renderDraftStateSystemMessage({ agentDraftState, canvasScope, title }),
    ].filter(Boolean).join('\n\n');

    const messages = [
        { role: 'system', content: sys },
        ...fewShotMessages,
        ...windowedHistory,
        ...(dynamicContext ? [{ role: 'system', content: dynamicContext }] : []),
        { role: 'user', content: (carried ? `${carried}\n\n` : '') + (message || '') + attachmentSummaryText(attachments) },
    ];

    return { sys, fewShotMessages, windowedHistory, dynamicContext, messages };
}

/**
 * Number of leading messages that must be byte-identical between consecutive
 * turns of a session: everything up to (excluding) the late dynamic system
 * message. When a turn carries no dynamic message the prefix runs up to the
 * user message.
 */
function stablePrefixLength(messages) {
    if (!Array.isArray(messages) || !messages.length) return 0;
    for (let i = messages.length - 1; i >= 1; i--) {
        if (messages[i] && messages[i].role === 'system') return i;
    }
    return messages.length - 1;
}

module.exports = { composeTurnMessages, stablePrefixLength, attachmentSummaryText };

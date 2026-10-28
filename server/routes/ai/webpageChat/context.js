// @typecheck noImplicitAny
/**
 * Webpage chat: what one turn tells the model before the first round
 * (routes/ai/webpageChat.js). The knowledge-base grounding (stripped against
 * the Privacy Shield's "Own server" list), the three slot files fitted into
 * their token slices, the editor selection, web-search availability, and the
 * system prompt built from all of it (./systemPrompt.js).
 */

'use strict';

const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const { resolveFramework, resolveRuntime, buildRuntimePromptBlock } = require('../../../integrations/webpageFramework');
const { searchWebpageKB } = require('../../../core/webpages/webpageKnowledgeSearch');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
const { planningRuleFor, webpageSystemPrompt } = require('./systemPrompt');
const { slotFilename } = require('./tools');

/**
 * Emits the kb_search / kb_sources / building_prompt events. Returns the
 * system prompt and what the tool loop needs of the same facts.
 * @param {{ send: import('./toolLoop').Send, webpage: import('./toolLoop').Webpage, message: string, userId: string,
 *   readySources: import('./toolLoop').WebpageSources, timezone: string, chatMode: string,
 *   htmlContent: string | null | undefined, cssContent: string | null | undefined, jsContent: string | null | undefined,
 *   webpageSelection: { text?: unknown, file?: string, action?: string } | null | undefined,
 *   toolPiiGate: typeof import('../../../core/privacy/toolPiiGate'),
 *   _psShield: Awaited<ReturnType<typeof import('../../../core/privacy/orgShield').resolveShieldFor>> | null }} args
 */
async function buildTurnContext({
    send, webpage, message, userId, readySources, timezone, chatMode,
    htmlContent, cssContent, jsContent, webpageSelection, toolPiiGate, _psShield,
}) {
    // KB search for grounding
    let kbContext = '';
    /** @type {Array<{ title?: string, content?: string, score?: number }>} */
    let citationSources = [];
    const kbIds = webpage.knowledgeBaseIds || [];
    if (kbIds.length > 0) {
        emitPhase(send, 'kb_search');
        const _kbT = Date.now();
        try {
            const kbResult = await searchWebpageKB({
                userId, kbIds, query: message,
                options: { topK: 10, rerank: true, minScore: 0.2 },
            });
            if (kbResult.chunks.length > 0) {
                citationSources = kbResult.citations;
                // Injected without a tool call, so the "own server" block
                // list applies as it does to webpage_kb_search.
                // What the model reads; the citations stay the user's own.
                kbContext = await toolPiiGate.stripInjectedText(kbResult.contextPrompt, { shield: _psShield, tag: 'WebpageChat' });
            }
        } catch (kbErr) {
            log.warn('[WebpageChat] KB search failed:', kbErr.message);
        }
        emitPhaseEnd(send, 'kb_search', Date.now() - _kbT);
    }
    if (citationSources.length > 0) {
        send('kb_sources', { sources: citationSources.map(s => ({ title: s.title, preview: s.content, score: s.score })) });
    }

    // Source summary
    const sourceSummary = readySources.length > 0
        ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
        : '(No sources added yet)';

    // File-content blocks — fit each slot into its own token slice.
    const { fitIntoTokenBudget } = require('../../../core/llm/tokenBudget');
    const SLOT_TOKENS = 6000;

    const html = htmlContent || '';
    const css = cssContent || '';
    const js = jsContent || '';

    /**
     * @param {string} slot
     * @param {string} language
     * @param {string} content
     */
    function slotBlock(slot, language, content) {
        const filename = slotFilename(slot);
        if (!content || !content.trim()) {
            return `\n--- ${filename} (empty) ---\n`;
        }
        const fit = fitIntoTokenBudget(content, SLOT_TOKENS);
        const truncNote = fit.truncated ? ` [TRUNCATED: ${fit.keptTokens.toLocaleString()} of ${fit.originalTokens.toLocaleString()} tokens]` : '';
        return `\n--- ${filename}${truncNote} ---\n\`\`\`${language}\n${fit.text}\n\`\`\`\n`;
    }

    const filesBlock =
        slotBlock('html', 'html', html) +
        slotBlock('css', 'css', css) +
        slotBlock('js', 'javascript', js);

    // Selection context
    let selectionContext = '';
    if (webpageSelection && typeof webpageSelection.text === 'string' && webpageSelection.text.trim()) {
        const MAX_SEL_CHARS = 8000;
        const selFile = ['html', 'css', 'js'].includes(webpageSelection.file) ? webpageSelection.file : 'html';
        const selText = webpageSelection.text.length > MAX_SEL_CHARS
            ? webpageSelection.text.slice(0, MAX_SEL_CHARS) + '…[truncated]'
            : webpageSelection.text;
        const actionHint = webpageSelection.action && ['rewrite', 'shorten', 'expand', 'fix'].includes(webpageSelection.action)
            ? `The user explicitly invoked "${webpageSelection.action}" on this selection — call webpage_file_replace with file="${selFile}", find_text set to the EXACT selection above, and replace_text set to your revised version.`
            : `If the user asks you to edit, rewrite, or change "this" / "the selection", use webpage_file_replace with file="${selFile}" and find_text set to the EXACT string above.`;
        // The <<<...>>> markers fence the selection inside the model's prompt;
        // this string never reaches a browser as HTML.
        selectionContext =
            `\n\n[SELECTED CODE IN ${slotFilename(selFile)}]\n` +
            `<<<SELECTION_BEGIN>>>\n${selText}\n<<<SELECTION_END>>>\n` + // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
            actionHint;
    }

    // Web-search availability
    const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
    const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
    const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
    const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    emitPhase(send, 'building_prompt');
    const _spT = Date.now();
    // Framework + runtime tier drive which build/preview contract the AI
    // must obey. Vanilla (default) keeps the classic HTML/CSS/JS rules;
    // react-mui swaps in the React + Material UI contract.
    const framework = resolveFramework(webpage);
    const runtime = resolveRuntime(webpage);
    const runtimeBlock = buildRuntimePromptBlock({ framework, runtime, filesBlock });
    const systemPrompt = webpageSystemPrompt({
        webpage, today, runtimeBlock, planningRule: planningRuleFor(chatMode), sourceSummary, searchAvailable, kbContext, selectionContext, timezone,
    });

    emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);

    return { systemPrompt, kbIds, searchAvailable, framework, html, css, js };
}

module.exports = { buildTurnContext };

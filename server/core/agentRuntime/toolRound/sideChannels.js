// @typecheck
/**
 * The side channels of one tool result, in the order the result loop emits
 * them: document_update for a Studio document a tool wrote, the email /
 * calendar / LinkedIn drafts (deduplicated), map embeds, workspace updates
 * (un-tokenised for the user only), the knowledge-base sources (turn-local
 * dedup, which also trims what the model will see), audio files and generated
 * files. Moved verbatim out of the result loop of executeToolRound
 * (../toolRoundExecutor.js, now ./results.js).
 *
 * `deps` carries piiDetection and dlpRunner as lazy getters: both sit in the
 * server's large import cycle.
 */
const { _stableStringify } = require('./toolContent');
const log = require('../../../telemetry/log');

// Agent tools whose result carries the `documentId` of a Studio document they wrote.
const STUDIO_WRITE_TOOLS = new Set(['create_presentation']);

/** Emit and record every side channel `finalToolResult` carries. Mutates a kb_sources result. */
function emitSideChannels(rc, deps, { toolName, finalToolResult }) {
    const {
        onEvent, conversation, _emailDrafts, _calendarDrafts, _linkedInDrafts, _mapEmbeds,
        _audioFiles, _generatedFiles, _kbSources, _seenChunkIds,
    } = rc;
    // A tool that WROTE a Studio document (a presentation kept in the
    // library): same event as direct chat, so open Documents lists and
    // editors refresh. Only on a real document id, never on a plain
    // tool result that merely mentions one.
    if (STUDIO_WRITE_TOOLS.has(toolName) && finalToolResult?.documentId && !finalToolResult.error) {
        onEvent('document_update', {
            documentId: finalToolResult.documentId,
            name: finalToolResult.file?.name || finalToolResult.name,
            url: finalToolResult.documentUrl || finalToolResult.url,
        });
    }

    // Emit email_draft SSE event for user approval (with dedup).
    // Use a key derived via _stableStringify so the dedup is order-stable —
    // JSON.stringify on object literals respects insertion order, and the
    // model can produce slightly different draft object shapes that still
    // mean the same draft.
    if (finalToolResult?._action === 'email_draft') {
        const draftKey = _stableStringify({ to: finalToolResult.draft?.to, subject: finalToolResult.draft?.subject, body: finalToolResult.draft?.body });
        const alreadySent = _emailDrafts.some(d => _stableStringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
        if (!alreadySent) {
            onEvent('email_draft', finalToolResult.draft);
            _emailDrafts.push({ ...finalToolResult.draft, status: 'pending' });
        }
    }
    // Emit calendar_draft SSE event for user approval (with dedup).
    // Key on the real draft fields, not the never-present
    // summary/start/end which made dedup a no-op (BFSF-123).
    if (finalToolResult?._action === 'calendar_draft') {
        const calKey = (d) => _stableStringify({ action: d?.action, title: d?.title, startTime: d?.startTime, endTime: d?.endTime, eventId: d?.eventId });
        const draftKey = calKey(finalToolResult.draft);
        const alreadySent = _calendarDrafts.some(d => calKey(d) === draftKey);
        if (!alreadySent) {
            onEvent('calendar_draft', finalToolResult.draft);
            _calendarDrafts.push({ ...finalToolResult.draft, status: 'pending' });
        }
    }
    // Emit linkedin_draft SSE event for user approval
    if (finalToolResult?._action === 'linkedin_draft') {
        onEvent('linkedin_draft', finalToolResult.draft);
        _linkedInDrafts.push({ ...finalToolResult.draft, status: 'pending' });
    }


    // Emit map_embed SSE event so map renders persist on messages
    if (finalToolResult?._action === 'map_embed' && finalToolResult._mapEmbed) {
        onEvent('map_embed', finalToolResult._mapEmbed);
        _mapEmbeds.push(finalToolResult._mapEmbed);
    }

    // Emit workspace_update SSE event so frontend updates panel.
    // Render-time un-tokenisation: stored content keeps the raw
    // `[person_N]` tokens (so notebook_read in a later turn still
    // works for the AI), but the user-facing SSE replaces them
    // with the real values from the conversation token map.
    if (finalToolResult?._action === 'workspace_update' && finalToolResult.content && finalToolResult.content.trim()) {
        const { restoreTokens } = deps.piiDetection();
        const _convMapForWs = deps.dlpRunner().getConversationTokenMap(conversation?.id);
        const rendered = restoreTokens(finalToolResult.content, _convMapForWs);
        onEvent('workspace_update', { content: rendered });
    }

    // Emit kb_sources SSE event so frontend shows knowledge base sources.
    // Turn-local dedup: if a chunk_id has already been seen in a prior
    // kb_search this turn, drop it from every surface (UI, persistence,
    // AND the tool response the LLM will see).
    if (finalToolResult?._action === 'kb_sources' && finalToolResult._sources?.length > 0) {
        const keepIdx = [];
        const resultsArr = Array.isArray(finalToolResult.results) ? finalToolResult.results : [];
        finalToolResult._sources.forEach((src, i) => {
            // A LIVE table row has no chunk id — it was never
            // ingested — but it has a stable identity of its
            // own, and falling through to the title/content
            // hash would let one edited cell re-cite the same
            // row twice in a turn.
            const rowKey = (src.datatableId && src.rowId)
                ? `datatable:${src.datatableId}:${src.rowId}`
                : null;
            const id = resultsArr[i]?.chunk_id
                || rowKey
                || (src.title || '') + '::' + (src.section || '') + '::' + (src.content || '').slice(0, 80);
            if (!_seenChunkIds.has(id)) {
                _seenChunkIds.add(id);
                keepIdx.push(i);
            }
        });
        const filteredSources = keepIdx.map(i => finalToolResult._sources[i]);
        const filteredResults = keepIdx.map(i => resultsArr[i]).filter(Boolean);
        const dropped = finalToolResult._sources.length - filteredSources.length;
        if (dropped > 0) {
            log.info(`[KBSearch] Turn-local dedup: dropped ${dropped} already-seen chunk(s) from kb_search result`);
        }
        // Mutate so downstream LLM serialization (buildLLMToolContent) sees the trimmed set.
        finalToolResult._sources = filteredSources;
        finalToolResult.results = filteredResults;
        if (filteredSources.length > 0) {
            onEvent('kb_sources', { sources: filteredSources });
            _kbSources.push(...filteredSources);
        }
    }

    // Track audio files for persistence (sent via SSE by the tool)
    if (finalToolResult?.audioUrl) {
        _audioFiles.push({ url: finalToolResult.audioUrl, source: toolName });
    }
    // A file a tool built (a deck): a card under the reply, whatever
    // the model writes about it — and persisted with the message.
    if (finalToolResult?.file && typeof finalToolResult.file === 'object') {
        _generatedFiles.push(finalToolResult.file);
        onEvent('file', finalToolResult.file);
    }
}

module.exports = { emitSideChannels, STUDIO_WRITE_TOOLS };

/**
 * Direct Chat — the SSE events a settled batch of tool results produces.
 *
 * Runs sequentially after all tools of a round settle, so the drafts cannot
 * race. Both tool loops (the non-streaming pre-check and the streamed one)
 * call this; they now differ only in the notebook rollback, which can only
 * fire once content has been streamed. Both carry `_toolName`, which the
 * non-streamed return used to omit — see toolExec.js.
 */

function emitToolResultEvents(turn, toolResults, { streamed }) {
    const { send, collectedEmailDrafts, collectedCalendarDrafts, generatedAudio, generatedFiles } = turn;
    for (const tr of toolResults) {
        const toolResult = tr._toolResult;
        if (!toolResult) continue;
        // Emit email_draft SSE event for user approval (with dedup)
        if (toolResult._action === 'email_draft') {
            const draftKey = JSON.stringify({ to: toolResult.draft?.to, subject: toolResult.draft?.subject, body: toolResult.draft?.body });
            const alreadySent = collectedEmailDrafts.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
            if (!alreadySent) {
                send('email_draft', toolResult.draft);
                collectedEmailDrafts.push(toolResult.draft);
            }
        }
        // Emit calendar_draft SSE event for user approval (with dedup).
        // Key on the REAL draft fields (action/title/startTime/endTime/
        // eventId) — the old key read summary/start/end which calendar
        // drafts never carry, so the dedup was a no-op and the model
        // re-calling the tool across rounds duplicated the card (BFSF-123).
        if (toolResult._action === 'calendar_draft') {
            const calKey = (d) => JSON.stringify({ action: d?.action, title: d?.title, startTime: d?.startTime, endTime: d?.endTime, eventId: d?.eventId });
            const draftKey = calKey(toolResult.draft);
            const alreadySent = collectedCalendarDrafts.some(d => calKey(d) === draftKey);
            if (!alreadySent) {
                send('calendar_draft', toolResult.draft);
                collectedCalendarDrafts.push(toolResult.draft);
            }
        }
        // Emit linkedin_draft SSE event for user approval
        if (toolResult._action === 'linkedin_draft') {
            send('linkedin_draft', toolResult.draft);
        }
        // Emit contacts_draft SSE event for user approval
        if (toolResult._action === 'contacts_draft') {
            send('contacts_draft', toolResult.draft);
        }
        // Emit keep_draft SSE event for user approval
        if (toolResult._action === 'keep_draft') {
            send('keep_draft', toolResult.draft);
        }
        // Emit workspace_update SSE event. Render-time un-tokenisation:
        // the stored workspace_content keeps the raw tokens (so the AI
        // can re-read them via notebook_read in a later turn), but the
        // user-facing SSE payload gets `[person_N]` → real values
        // restored from the conversation token map.
        if (toolResult._action === 'workspace_update' && toolResult.content && toolResult.content.trim()) {
            const { restoreTokens } = require('../../../core/privacy/piiDetection');
            const _convMapForWs = require('../../../core/dlp/dlpRunner').getConversationTokenMap(turn.convId);
            const rendered = restoreTokens(toolResult.content, _convMapForWs);
            send('workspace_update', { content: rendered });
            turn.notebookWriteCommitted = true;
        }
        // BFSF-208: write failed after partial content was live-streamed to the panel — roll back to last persisted content.
        if (streamed && toolResult._nbWriteFailed && turn._nbStreamLastLen > 0) {
            const { restoreTokens } = require('../../../core/privacy/piiDetection');
            const _convMapForWs = require('../../../core/dlp/dlpRunner').getConversationTokenMap(turn.convId);
            send('workspace_update', { content: restoreTokens(toolResult._revertContent || '', _convMapForWs) });
            turn._nbStreamLastLen = 0;
        }
        // Emit kb_sources SSE event
        if (toolResult._action === 'kb_sources' && toolResult._sources?.length > 0) {
            send('kb_sources', { sources: toolResult._sources });
        }
        // Track audio URLs for persistence
        if (toolResult.audioUrl) {
            generatedAudio.push({ url: toolResult.audioUrl, source: tr._toolName });
        }
        if (toolResult.file && typeof toolResult.file === 'object') {
            generatedFiles.push(toolResult.file);
            send('file', toolResult.file);
        }
    }
}

module.exports = { emitToolResultEvents };

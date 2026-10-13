import { describe, expect, it, vi } from 'vitest';

import { buildHandlerTable, dispatchSSEEvent, SSE_HANDLERS } from './dispatch';
import type { SseDispatchContext, SseDispatchIds, SseEventData } from '../types';

/** Every `case` label of the switch the handler table replaced. */
const SWITCH_EVENTS = [
    'ping', 'content', 'phase', 'thinking_start', 'thinking', 'thinking_stop',
    'content_replace', 'content_redact', 'swarm_started', 'swarm_phase_started',
    'swarm_phase_completed', 'swarm_clarification_required', 'swarm_completed',
    'swarm_worker_started', 'swarm_worker_content', 'swarm_worker_tool',
    'swarm_worker_completed', 'session_skills_bootstrap_started', 'session_skills_bootstrapped',
    'session_skills_updated', 'session_skill_completed', 'tool_confirm', 'test_chat',
    'tool_start', 'tool_end', 'browser_session_queued', 'browser_session_start',
    'browser_frame', 'browser_action', 'browser_session_end', 'model_selected',
    'document_truncated', 'email_draft', 'linkedin_draft', 'calendar_draft', 'contacts_draft',
    'keep_draft', 'map_embed', 'image', 'audio', 'file', 'video', 'kb_sources', 'memory_used',
    'rule_attribution', 'workspace_update', 'notebook_doc_update', 'slides_deck_update',
    'slides_theme_update', 'notebook_source_added', 'history_locked', 'webpage_doc_update',
    'webpage_source_added', 'webpage_extra_update', 'webpage_extra_deleted', 'document_update',
    'document_suggestions', 'webpage_db_update', 'webpage_framework_changed',
    'webpage_runtime_changed', 'webpage_plan_proposed', 'slides_source_added', 'sheet_update',
    'sheet_source_added', 'proposal_blocks_update', 'done', 'error', 'dlp_preview',
    'dlp_attachment_preview', 'dlp_resolved', 'pii_tokenized', 'privacy_payload',
    'privacy_response_raw', 'privacy_token_map', 'tokenisation_info', 'dlp_blocked',
    'guardrail_violation', 'guardrail_blocked',
];

const ids = { assistantMsgId: 'a', activeIdRef: { current: 'a' } } as unknown as SseDispatchIds;

describe('SSE handler table', () => {
    it('handles exactly the events the old switch handled', () => {
        expect([...SSE_HANDLERS.keys()].sort()).toEqual([...SWITCH_EVENTS].sort());
    });

    it('refuses an event claimed by two families', () => {
        const noop = () => {};
        expect(() => buildHandlerTable([{ done: noop }, { done: noop }])).toThrow(/done/);
    });

    it('ignores an unknown event, including Object.prototype names', () => {
        const setMessages = vi.fn();
        const ctx = { setMessages } as unknown as SseDispatchContext;
        for (const event of ['no_such_event', 'toString', 'constructor', '__proto__']) {
            expect(() => dispatchSSEEvent(ctx, event, {} as SseEventData, ids)).not.toThrow();
        }
        expect(setMessages).not.toHaveBeenCalled();
    });

    it('passes ctx, data and ids to the handler of the event', () => {
        const setMessages = vi.fn();
        const ctx = { setMessages } as unknown as SseDispatchContext;
        dispatchSSEEvent(ctx, 'map_embed', { url: 'u' } as SseEventData, ids);
        expect(setMessages).toHaveBeenCalledTimes(1);
    });
});

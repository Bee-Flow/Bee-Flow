import type { Dispatch, SetStateAction } from 'react';
import type { ChatMessage, SseEventData } from '../../hooks/useChatEngine/types';

type SetMessages = Dispatch<SetStateAction<ChatMessage[]>>;

/** The fields a calendar draft is de-duplicated on. */
interface CalendarDraftKeyFields {
    action?: unknown;
    title?: unknown;
    startTime?: unknown;
    endTime?: unknown;
    eventId?: unknown;
}

/** One thinking step of the sequentialthinking tool, as it starts. */
function runningThinkingStep(args: Record<string, unknown>): Record<string, unknown> {
    const { thought, thoughtNumber, totalThoughts, isRevision, branchFromThought, branchId } = args;
    return { thought, thoughtNumber, totalThoughts, isRevision, branchFromThought, branchId, status: 'running' };
}

/** Drafts, knowledge sources and media of an agent stream: each lands on the assistant message. */
function applyEmbedAttachmentEvent(currentEvent: string, data: SseEventData, setMessages: SetMessages, assistantMsgId: string): void {
    if (currentEvent === 'email_draft') {
        const draftKey = JSON.stringify({ to: data.to, subject: data.subject, body: data.body });
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.emailDrafts || [];
            if (existing.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey)) return m;
            return { ...m, emailDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    } else if (currentEvent === 'calendar_draft') {
        // Key on the real draft fields (BFSF-123).
        const calKey = (d?: CalendarDraftKeyFields) => JSON.stringify({ action: d?.action, title: d?.title, startTime: d?.startTime, endTime: d?.endTime, eventId: d?.eventId });
        const draftKey = calKey(data);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.calendarDrafts || [];
            if (existing.some(d => calKey(d) === draftKey)) return m;
            return { ...m, calendarDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    } else if (currentEvent === 'linkedin_draft') {
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? { ...m, linkedInDrafts: [...(m.linkedInDrafts || []), { ...data, status: 'pending' }] } : m
        ));
    } else if (currentEvent === 'contacts_draft') {
        const draftKey = JSON.stringify({ name: data.name, email: data.email, phone: data.phone });
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.contactsDrafts || [];
            if (existing.some(d => JSON.stringify({ name: d.name, email: d.email, phone: d.phone }) === draftKey)) return m;
            return { ...m, contactsDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    } else if (currentEvent === 'keep_draft') {
        const draftKey = JSON.stringify({ title: data.title, content: data.content });
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.keepDrafts || [];
            if (existing.some(d => JSON.stringify({ title: d.title, content: d.content }) === draftKey)) return m;
            return { ...m, keepDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    } else if (currentEvent === 'kb_sources') {
        const incomingSources = data.sources;
        if (incomingSources) {
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const existing = m.kbSources || [];
                const existingContentKeys = new Set(existing.map(s => (s.content || '').slice(0, 100)));
                const newSources = incomingSources.filter(s => !existingContentKeys.has((s.content || '').slice(0, 100)));
                return { ...m, kbSources: [...existing, ...newSources] };
            }));
        }
    } else if (currentEvent === 'map_embed') {
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? { ...m, mapEmbeds: [...(m.mapEmbeds || []), data] } : m
        ));
    } else if (currentEvent === 'image') {
        if (data.data && data.mimeType) {
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, images: [...(m.images || []), { data: data.data, mimeType: data.mimeType }] } : m
            ));
        }
    } else if (currentEvent === 'audio') {
        if (data.url) {
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, audioFiles: [...(m.audioFiles || []), { url: data.url, mimeType: data.mimeType || 'audio/mpeg', source: data.source || 'elevenlabs' }] } : m
            ));
        }
    } else if (currentEvent === 'file') {
        if (data && (data.url || data.webUrl)) {
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, files: [...(m.files || []), data] } : m
            ));
        }
    } else if (currentEvent === 'video') {
        if (data.url && data.mimeType) {
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, videoFiles: [...(m.videoFiles || []), { url: data.url, mimeType: data.mimeType }] } : m
            ));
        }
    }
}

/**
 * Applies one server-sent event of the embed's agent stream to the transcript
 * and returns the answer text so far. `msgId` is the visitor's message (the
 * policy marks land on it), `assistantMsgId` the answer being streamed.
 */
export function applyEmbedStreamEvent(
    currentEvent: string,
    data: SseEventData,
    setMessages: SetMessages,
    msgId: string,
    assistantMsgId: string,
    previousContent: string,
): string {
    let assistantContent = previousContent;
    if (currentEvent === 'content' && data.text) {
        assistantContent += data.text;
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? { ...m, content: assistantContent } : m
        ));
    } else if (currentEvent === 'content_replace' && data.text !== undefined) {
        assistantContent = data.text;
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? { ...m, content: assistantContent } : m
        ));
    } else if (currentEvent === 'content_redact') {
        // Redact: show warning first, then update user message with redacted version after delay
        const seconds = data.autoRedactSeconds || 5;
        setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, isGuardrailViolation: true, deleteIn: seconds, willRedact: true } : m
        ));
        // Schedule redaction after countdown
        setTimeout(() => {
            setMessages(prev => prev.map(m =>
                m.id === msgId ? { ...m, content: data.redactedMessage, isGuardrailViolation: false, isRedacted: true, willRedact: false } : m
            ));
        }, seconds * 1000);
    } else if (currentEvent === 'guardrail_violation') {
        // Mark user message for deletion warning, then replace content after countdown
        const seconds = data.autoDeleteSeconds || 5;
        setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, isGuardrailViolation: true, deleteIn: seconds } : m
        ));
        // Replace user message content after countdown
        setTimeout(() => {
            setMessages(prev => prev.map(m =>
                m.id === msgId ? { ...m, content: '[Message removed - policy violation]', isGuardrailViolation: false, isDeleted: true } : m
            ));
        }, seconds * 1000);
    } else if (currentEvent === 'tool_start') {
        setMessages(prev => prev.map(m => {
            if (m.id === assistantMsgId) {
                const update = { ...m, toolCall: { name: data.name, status: 'running' } };
                if (data.name === 'sequentialthinking' && data.args?.thought) {
                    const steps = [...(m.thinkingSteps || [])];
                    steps.push(runningThinkingStep(data.args));
                    update.thinkingSteps = steps;
                }
                return update;
            }
            return m;
        }));
    } else if (currentEvent === 'tool_end') {
        setMessages(prev => prev.map(m => {
            if (m.id === assistantMsgId) {
                const trs = m.toolResults || [];
                const update = {
                    ...m,
                    toolResults: [...trs, { name: data.name, result: data.result }],
                    toolCall: null
                };
                if (data.name === 'sequentialthinking' && m.thinkingSteps && m.thinkingSteps.length > 0) {
                    const steps = [...m.thinkingSteps];
                    const lastRunning = steps.findLastIndex(s => s.status === 'running');
                    if (lastRunning >= 0) steps[lastRunning] = { ...steps[lastRunning], status: 'done' };
                    update.thinkingSteps = steps;
                }
                return update;
            }
            return m;
        }));
    } else if (currentEvent === 'thinking') {
        if (data.text) {
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, thinking: (m.thinking || '') + data.text } : m
            ));
        }
    } else if (currentEvent === 'error') {
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? { ...m, content: typeof data.error === 'string' ? data.error : data.error?.message, isStreaming: false, isError: true } : m
        ));
    } else {
        applyEmbedAttachmentEvent(currentEvent, data, setMessages, assistantMsgId);
    }
    return assistantContent;
}

import type { SseEventData } from '../../types';
import { logger } from '@/utils/logger';
import type { SseHandlerMap } from '../handlerTypes';

/**
 * Draft cards a tool proposes (mail, LinkedIn, calendar, contacts, Keep),
 * deduplicated per message where the fields allow it.
 */
export const draftHandlers: SseHandlerMap = {
    email_draft(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const draftKey = JSON.stringify({ to: data.to, subject: data.subject, body: data.body });
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.emailDrafts || [];
            if (existing.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey)) return m;
            return { ...m, emailDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    },

    linkedin_draft(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        logger.debug('[DEBUG] linkedin_draft event received!', data, 'assistantMsgId:', assistantMsgId);
        setMessages(prev => {
            const updated = prev.map(m =>
                m.id === assistantMsgId ? {
                    ...m,
                    linkedInDrafts: [...(m.linkedInDrafts || []), { ...data, status: 'pending' }]
                } : m
            );
            logger.debug('[DEBUG] Messages after linkedin_draft update:', updated.map(m => ({ id: m.id, hasLinkedInDrafts: !!m.linkedInDrafts, linkedInDraftsCount: m.linkedInDrafts?.length })));
            return updated;
        });
    },

    calendar_draft(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // Key on the real draft fields (action/title/startTime/endTime/
        // eventId); summary/start/end are never present so the old key
        // deduped nothing and duplicate cards stacked up (BFSF-123).
        const calKey = (d: SseEventData | Record<string, unknown> | undefined) => JSON.stringify({ action: d?.action, title: d?.title, startTime: d?.startTime, endTime: d?.endTime, eventId: d?.eventId });
        const draftKey = calKey(data);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.calendarDrafts || [];
            if (existing.some(d => calKey(d) === draftKey)) return m;
            return { ...m, calendarDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    },

    contacts_draft(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const draftKey = JSON.stringify({ name: data.name, email: data.email, phone: data.phone });
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.contactsDrafts || [];
            if (existing.some(d => JSON.stringify({ name: d.name, email: d.email, phone: d.phone }) === draftKey)) return m;
            return { ...m, contactsDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    },

    keep_draft(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const draftKey = JSON.stringify({ title: data.title, content: data.content });
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const existing = m.keepDrafts || [];
            if (existing.some(d => JSON.stringify({ title: d.title, content: d.content }) === draftKey)) return m;
            return { ...m, keepDrafts: [...existing, { ...data, status: 'pending' }] };
        }));
    },
};

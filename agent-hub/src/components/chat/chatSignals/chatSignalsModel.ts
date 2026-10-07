/**
 * Chat signals in the chat: what the composer announces, and the marker the
 * turn carries because of it. Pure, so the one rule is testable on its own:
 *
 *   ANNOUNCED EQUALS COUNTED. A notice exists only for a chat type the
 *   status route lists, and the marker is built from that same notice. No
 *   notice, no marker; no marker, not counted (the server checks it).
 *
 * The agent chat needs one more answer: whether the agent belongs to the
 * caller's own organisation (`GET /agents/:id` → `complianceCounting`). A
 * colleague from elsewhere is not counted, so they are not told they are.
 */
import type { AgentCountingGate } from '../../../api/queries/chatSignals';
import type { ChatSignal, ShieldStatus } from '../../../api/queries/shieldStatus';
import type { ChatSignalsTurnSurface } from '../../../hooks/useChatEngine/turnEndpoint';

export type { AgentCountingGate };

export interface NoticeModel {
    surface: ChatSignalsTurnSurface;
    state: 'scheduled' | 'on';
    from: string | null;
    version: string;
    signals: ChatSignal[];
    noticeUrl: string | null;
    marker: string;
    optedOut: boolean;
}

export interface NoticeInput {
    status: ShieldStatus | null | undefined;
    surface: ChatSignalsTurnSurface | null | undefined;
    agentGate?: AgentCountingGate | null;
    optedOut?: boolean;
}

export type ChatLineKey =
    | 'chat_monitoring.chat.line'
    | 'chat_monitoring.chat.line_kinds'
    | 'chat_monitoring.chat.scheduled'
    | 'chat_monitoring.chat.scheduled_kinds';

/** `direct@2026-10-14T09:00:00.000Z`: the chat type and the exact version of the notice shown. */
export function markerFor(surface: string, version: string): string {
    return `${surface}@${version}`;
}

/** The notice for this chat type, or null when nothing is counted here. */
export function noticeFor({ status, surface, agentGate = null, optedOut = false }: NoticeInput): NoticeModel | null {
    const mon = status?.chatMonitoring;
    if (!surface || !mon || mon.state === 'off' || !mon.version) return null;
    if (!mon.surfaces.includes(surface)) return null;
    if (surface === 'agent' && agentGate?.state !== 'on' && agentGate?.state !== 'scheduled') return null;
    return {
        surface,
        state: mon.state,
        from: mon.from,
        version: mon.version,
        signals: [...mon.signals],
        noticeUrl: mon.noticeUrl,
        marker: markerFor(surface, mon.version),
        optedOut: optedOut === true,
    };
}

/** Which sentence the line says: it names the kinds only when they are counted. */
export function lineKey(notice: Pick<NoticeModel, 'state' | 'signals'>): ChatLineKey {
    const kinds = notice.signals.includes('kinds');
    if (notice.state === 'scheduled') return kinds ? 'chat_monitoring.chat.scheduled_kinds' : 'chat_monitoring.chat.scheduled';
    return kinds ? 'chat_monitoring.chat.line_kinds' : 'chat_monitoring.chat.line';
}

/** The fields a turn on this chat type adds to its body. */
export function payloadFor(notice: NoticeModel): { chatSignalsNotice: string; chatSignalsOptOut?: true } {
    return notice.optedOut
        ? { chatSignalsNotice: notice.marker, chatSignalsOptOut: true }
        : { chatSignalsNotice: notice.marker };
}

/**
 * A start date ('YYYY-MM-DD', a UTC day) as words in the reader's language,
 * "14 October 2026". The day is printed in UTC so it never slips to the day
 * before west of Greenwich.
 */
export function formatNoticeDate(day: string | null | undefined, locale = 'en'): string {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return '';
    const tag = !locale || locale === 'en' ? 'en-GB' : locale;
    try {
        return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
    } catch {
        return day;
    }
}

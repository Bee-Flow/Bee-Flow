/**
 * "Which agent gave this answer?" — the line above a test-chat answer.
 *
 * A test chat runs on the DRAFT (A4). An automation runs on the PUBLISHED
 * config (R2). That difference is deliberate, because you test what you are
 * making, but it is exactly the kind of difference that, if it is not on
 * screen, lets someone think they just checked what happens in production.
 * This line is that screen.
 *
 * ── THE SERVER READS IT, NEVER THE REQUEST ──────────────────────────
 * The shape comes from the `test_chat` event, which the runtime builds from the
 * row it actually loaded. The client must never derive such a label from its own
 * request. This is the same rule as for "Test as" (chatStream sends `test_as` for
 * exactly this reason).
 *
 * ── UNKNOWN IS NOT REASSURANCE ─────────────────────────────────────
 * `source: 'unknown'` means nobody could say which config ran. Then the line does
 * not say "your draft" with a qualifier, but states the truth: this answer cannot
 * be attributed. That is the only sentence that is then true.
 */

import { FileText, HelpCircle, Send } from 'lucide-react';
import React from 'react';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

export interface TestChatInfo {
    active?: boolean;
    source?: string;
    publishedVersion?: unknown;
    unpublishedChanges?: unknown;
}

interface TestChatNoticeProps {
    info?: TestChatInfo | null;
    t?: (key: string, fallback: string, params?: Record<string, unknown>) => string;
}

export default function TestChatNotice({ info, t = (k: string, d: string) => d }: TestChatNoticeProps) {
    if (!info || info.active !== true) return null;

    const source = info.source;
    const published = Number(info.publishedVersion) || 0;
    const ahead = Number(info.unpublishedChanges) || 0;

    if (source === 'unknown') {
        return (
            <div data-testid="test-chat-notice" data-source="unknown"
                className="flex items-center gap-2 mb-2 text-[11px] text-amber-600 dark:text-amber-400">
                <HelpCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t('agent_studio.test.chat_source_unknown',
                    'Could not tell which version of this agent answered.')}</span>
            </div>
        );
    }

    // 'published' should not really be here, because a test chat asks for
    // the draft. But if the projection returned something else, that is the
    // news, not a reassuring sentence about your draft.
    if (source === 'published') {
        return (
            <div data-testid="test-chat-notice" data-source="published"
                className="flex items-center gap-2 mb-2 text-[11px] text-amber-600 dark:text-amber-400">
                <Send className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t('agent_studio.test.chat_source_published',
                    'This answer came from the published agent, not from your draft.')}</span>
            </div>
        );
    }

    return (
        <div data-testid="test-chat-notice" data-source={source}
            className="flex items-center gap-2 mb-2 text-[11px] text-[var(--text-tertiary)]">
            <FileText className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
                {t('agent_studio.test.chat_source_draft', 'Answered by your draft.')}
                {' '}
                {published > 0
                    ? (
                        ahead > 0
                            // Plural with its own key: "1 unpublished changes"
                            // is exactly the kind of sloppiness that makes a careful
                            // product look careless.
                            ? nOf(t, 'agent_studio.test.chat_source_live_ahead', ahead,
                                'Live is v{version}, with {count} unpublished change.',
                                'Live is v{version}, with {count} unpublished changes.',
                                { version: published })
                            : t('agent_studio.test.chat_source_live_same',
                                'Live is v{version} — the same as your draft.', { version: published })
                    )
                    : t('agent_studio.test.chat_source_never_published',
                        'Nothing is published yet, so this is also what people would get.')}
            </span>
        </div>
    );
}

import type { ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import EmailHtmlBody from '@/components/support/EmailHtmlBody';
import { useDataContext } from '../DataContext';
import { walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { Chips } from './Chips';
import { friendlyError } from './fileLoading';
import { openStoredFile, rowFile } from './openAttachment';
import { useInlineImages } from './useInlineImages';

interface BubbleBodyProps {
    /** The mail's HTML, or null for a plain-text row (then `children` is the body). */
    html: string | null;
    attachments: unknown;
    citations: unknown;
    attachmentLabelKey: string;
    citationLabelKey: string;
    attachmentFileKey: string | null;
    inlineContentIdKey: string | null;
    onAttachmentClick?: string;
    children: ReactNode;
}

/**
 * The body of one message and its chips. A component of its own because the
 * inline pictures (cid:) are loaded per message, lazily, and only for a message
 * that references them: that needs hooks, which a .map callback cannot hold.
 */
export function BubbleBody({ html, attachments, citations, attachmentLabelKey, citationLabelKey, attachmentFileKey, inlineContentIdKey, onAttachmentClick, children }: BubbleBodyProps) {
    const { t } = useTranslation();
    const { mode, runAction } = useRuntime();
    const { appId } = useDataContext();
    const live = mode === 'run' && !!appId;
    const { inlineImages, inlineRows } = useInlineImages({
        html, attachments, fileKey: attachmentFileKey, contentIdKey: inlineContentIdKey, appId, live,
    });
    // A picture shown inside the mail is not also a chip under it.
    const chipItems = inlineRows.size > 0 && Array.isArray(attachments)
        ? attachments.filter((a) => !inlineRows.has(a))
        : attachments;
    // With the event wired the app decides what to show (a file_preview, say);
    // without it the chip opens the file itself.
    const onOpen = mode === 'run' && attachmentFileKey
        ? async (item: unknown) => {
            if (onAttachmentClick) {
                runAction(onAttachmentClick, { formValues: item as Record<string, unknown>, item });
                return;
            }
            if (!appId) return;
            try {
                await openStoredFile(rowFile(item, attachmentFileKey, walkPath), appId);
            } catch (err) {
                const e = err as { status?: number; message?: string };
                throw new Error(friendlyError(e.status, e.message, t));
            }
        }
        : undefined;
    return (
        <>
            {html != null ? <EmailHtmlBody html={html} inlineImages={inlineImages} remoteImages="ask" /> : children}

            {/* The card zeroes its own padding so the mail can bleed
                to the edge; the chips still need their gutter. */}
            <div className={html != null ? 'px-3 pb-2' : ''}>
                <Chips items={chipItems} labelKey={attachmentLabelKey} testId="attachments" fileKey={attachmentFileKey} onOpen={onOpen} />
                <Chips items={citations} labelKey={citationLabelKey} testId="citations" />
            </div>
        </>
    );
}

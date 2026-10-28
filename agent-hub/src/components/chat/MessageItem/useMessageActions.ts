import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { buildPdfExportHtml } from './messageItemHelpers';
import type { ChatMessage } from './messageTypes';
import { API_BASE } from '@/utils/helpers';
import { mutate } from '@/api/mutate';

type Translate = (key: string, fallback?: string) => string;

/** The agent fields the feedback payload reads. */
export interface FeedbackAgent { name?: string; model?: string | null; config?: { allowCopy?: boolean } | null }

export interface FeedbackContext {
    msg: ChatMessage;
    idx: number;
    selectedAgent?: FeedbackAgent | null;
    conversationId?: string | null;
    agentId?: string | null;
    chatSource: string;
    allMessages: ChatMessage[];
}

/**
 * Send a rating (and optionally the whole conversation) to /api/feedback.
 * The agent's configured `model` is either a concrete model id or a `tier:*`
 * string; the backend resolves the concrete model from the most recent
 * usage_log row for this conversation when needed.
 */
function feedbackPayload(c: FeedbackContext, rating: string | null, comment: string): Record<string, unknown> {
    const agentModel = c.selectedAgent?.model || null;
    const isTier = typeof agentModel === 'string' && agentModel.startsWith('tier:');
    const modelTier = isTier ? (agentModel as string).slice(5) : null;
    const concreteModel = (typeof agentModel === 'string' && !isTier) ? agentModel : (c.msg.model || null);
    return {
        conversationId: c.conversationId || null,
        messageId: c.msg.id || `msg-${c.idx}`,
        agentId: c.agentId || null,
        agentName: c.selectedAgent?.name || c.msg.respondingAgentName || null,
        model: concreteModel,
        modelTier,
        rating,
        comment: comment || null,
        source: c.chatSource,
    };
}

async function submitFeedback(c: FeedbackContext, rating: string | null, comment = '', withConversation = false) {
    try {
        const API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/feedback';
        const payload = feedbackPayload(c, rating, comment);
        if (withConversation && c.allMessages?.length > 0) {
            payload.conversationSnapshot = c.allMessages.map(m => ({
                id: m.id || null,
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
                // Per-turn model, so the org admin can see when a model was
                // switched mid-conversation; the server enriches what is missing.
                model: m.model || null,
            }));
        }
        await mutate(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (e) {
        console.error('[Feedback] Failed to submit:', e);
    }
}

/**
 * Close a menu on a mousedown outside its element (and, when given, outside
 * the button that opens it too).
 */
function useOutsideClose(
    open: boolean, setOpen: (open: boolean) => void,
    menu: RefObject<HTMLElement | null>, button?: RefObject<HTMLElement | null>,
) {
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const inside = [menu, button].some(r => r && (!r.current || r.current.contains(e.target as Node)));
            if (!inside) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open, setOpen, menu, button]);
}

/**
 * The rating thumbs and the feedback form behind them. Split out of
 * MessageItem without a change in behaviour.
 */
export function useMessageFeedback(c: FeedbackContext) {
    const [feedbackRating, setFeedbackRating] = useState<string | null>(null);
    const [showFeedbackForm, setShowFeedbackForm] = useState(false);
    const [feedbackComment, setFeedbackComment] = useState('');
    const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
    const [includeConversation, setIncludeConversation] = useState(false);

    const handleThumbClick = (rating: string) => {
        if (feedbackSubmitted && feedbackRating === rating) return;
        setFeedbackRating(rating);
        setShowFeedbackForm(true);
        setFeedbackSubmitted(false);
        submitFeedback(c, rating);
    };
    const handleFeedbackSubmit = () => {
        submitFeedback(c, feedbackRating, feedbackComment.trim(), includeConversation);
        setShowFeedbackForm(false);
        setFeedbackSubmitted(true);
        setIncludeConversation(false);
    };
    const handleFeedbackSkip = () => {
        setShowFeedbackForm(false);
        setFeedbackSubmitted(true);
    };
    return {
        feedbackRating, feedbackSubmitted, showFeedbackForm, feedbackComment, setFeedbackComment,
        includeConversation, setIncludeConversation, handleThumbClick, handleFeedbackSubmit, handleFeedbackSkip,
    };
}

const MENU_HEIGHT = 280;

/**
 * Copy, copy-as-Markdown, export-to-PDF and the retry-tier menu of an
 * assistant message. Split out of MessageItem without a change in behaviour.
 */
export function useMessageActions(msg: ChatMessage, onCopy: ((content: unknown) => void) | null | undefined, t: Translate) {
    const [copied, setCopied] = useState(false);
    const [copiedMd, setCopiedMd] = useState(false);
    const [showRetryMenu, setShowRetryMenu] = useState(false);
    const [retryMenuPos, setRetryMenuPos] = useState({ top: 0, left: 0 });
    const [showCopyMenu, setShowCopyMenu] = useState(false);
    const retryMenuRef = useRef<HTMLDivElement>(null);
    const retryBtnRef = useRef<HTMLButtonElement>(null);
    const copyMenuRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    // Click-outside handlers for the retry tier menu and the copy/export menu.
    useOutsideClose(showRetryMenu, setShowRetryMenu, retryMenuRef, retryBtnRef);
    useOutsideClose(showCopyMenu, setShowCopyMenu, copyMenuRef);

    // Compute fixed position for the portal-based retry menu: upward when
    // there is room above the button, downward otherwise.
    const handleToggleRetryMenu = () => {
        if (!showRetryMenu && retryBtnRef.current) {
            const rect = retryBtnRef.current.getBoundingClientRect();
            if (rect.top >= MENU_HEIGHT) setRetryMenuPos({ top: rect.top - MENU_HEIGHT, left: rect.left });
            else setRetryMenuPos({ top: rect.bottom + 8, left: rect.left });
        }
        setShowRetryMenu(prev => !prev);
    };

    const handleCopy = () => {
        onCopy?.(msg.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleCopyMarkdown = async () => {
        if (!msg.content) return;
        try {
            await navigator.clipboard.writeText(msg.content as string);
            setCopiedMd(true);
            setTimeout(() => setCopiedMd(false), 2000);
        } catch (e) {
            console.error('[MessageItem] MD copy failed:', e);
        }
    };

    // Print the already-rendered markdown HTML (through the content ref).
    const handleExportPdf = () => {
        const htmlContent = contentRef.current?.innerHTML;
        if (!htmlContent || htmlContent.trim().length === 0) return;
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) return;
        printWindow.document.write(buildPdfExportHtml(htmlContent, t('chat.msg.pdf_export_title', 'AI Response Export')));
        printWindow.document.close();
        // Wait for content to render then trigger print
        setTimeout(() => {
            printWindow.focus();
            printWindow.print();
        }, 400);
    };

    return {
        copied, copiedMd, handleCopy, handleCopyMarkdown, handleExportPdf, contentRef,
        copyMenuRef, showCopyMenu, setShowCopyMenu,
        retryMenuRef, retryBtnRef, handleToggleRetryMenu, showRetryMenu, setShowRetryMenu, retryMenuPos,
    };
}

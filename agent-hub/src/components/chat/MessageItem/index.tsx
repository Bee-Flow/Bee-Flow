import React, { useState } from 'react';
import ImageLightbox from './ImageLightbox';
import { AnswerFooter, AssistantAttachments, AssistantPreamble, GeneratedMediaBlock } from './MessageBody';
import type { PreambleProps } from './MessageBody';
import MessageActionsRow from './MessageActionsRow';
import type { RetryModelTiers } from './MessageActionsRow';
import MessageAttachments from './MessageAttachments';
import {
    AssistantAvatar, copyWithoutBackground, FeedbackForm, GuardrailWarning, UserMessageMeta, UserPrivacyRow,
} from './MessageChrome';
import MessageContentBody from './MessageContentBody';
import { CompactionDivider, RemovedUserMessage } from './MessageNotices';
import type { ChatMessage } from './messageTypes';
import type { SkillSummary } from '../../../hooks/useChatEngine/types';
import ToolOutput from './ToolOutput';
import { useMessageActions, useMessageFeedback } from './useMessageActions';
import type { FeedbackAgent, FeedbackContext } from './useMessageActions';
import { useMessageEdit, useSimpleMode } from './useMessageEdit';
import UserEditComposer from './UserEditComposer';
import useTranslation from '../../../hooks/useTranslation';
import CitationOverlay from '../../../pages/documents/notebook/CitationOverlay';
import { MessageErrorBoundary } from '../../shell/ErrorBoundary';

// C9 — the reading column. Messages and composer belong in ONE column; they
// stood at two widths one above the other (messages 900px, composer 768px),
// which reads on screen as a conversation that does not quite sit above its
// own input. 760px is the measure from the artboard.
//
// The composer half of this agreement lives in InputArea.jsx and carries the
// same measure (`max-w-[760px]`, was `max-w-3xl`/768px). Change one and the
// other goes with it: it is one column, written in two files. Both halves are
// pinned — here in MessageItem.layout.test.jsx, there in
// InputArea.footer.test.jsx.
const COLUMN_MAX_W = 'max-w-[760px]';

export interface MessageItemProps {
    idx: number;
    msg: ChatMessage;
    selectedAgent?: FeedbackAgent | null;
    onCopy?: ((content: unknown) => void) | null;
    allMessages?: ChatMessage[];
    conversationId?: string | null;
    agentId?: string | null;
    chatSource?: string;
    onRetry?: (idx: number, tierKey?: string) => void;
    onEditMessage?: ((idx: number, text: string) => void) | null;
    modelTiers?: RetryModelTiers;
    isLastAssistant?: boolean;
    sessionSkills?: SkillSummary[];
    liveActivatedSkillIds?: unknown[];
    liveCompletedSkillIds?: unknown;
    liveCompletions?: unknown;
    /**
     * The model's reasoning panel. On by default: it is part of the answer, not
     * a debug surface. Public embed widgets pass false — chain-of-thought does
     * not belong on a customer's own website.
     */
    showReasoning?: boolean;
    /**
     * The knowledge-base sources behind the answer. Same shape as
     * `showReasoning` and one step more serious: it renders internal document
     * titles, headings, page numbers and the retrieved passage. On a public
     * embed that is somebody's handbook on a stranger's screen, so EmbedChat
     * passes an explicit opt-in.
     */
    showSources?: boolean;
    /**
     * The JUSTIFICATION half of the chip row (A4): which skills ran and which
     * rule a second model recognised afterwards. Off by default and so NOT like
     * `showSources`: not a privacy switch but a choice about how much
     * justification stands open on screen, open only where someone asks for it
     * — the test chat in the builder. The SOURCE chips (C6) hang on
     * `showSources` instead.
     */
    showAnswerChips?: boolean;
    /**
     * What a citation chip opens. Without a handler this component opens its
     * own `CitationOverlay`, so a chip in the ordinary chat goes somewhere
     * without every caller wiring one up.
     */
    onCitationClick?: ((source: unknown) => void) | null;
    /**
     * (argsKey, 'approve'|'decline', call) — what happens to a held call (A4).
     * WITHOUT a handler ToolConfirmCard renders no buttons: a surface where a
     * yes leads nowhere should not show one.
     */
    onToolDecision?: unknown;
    /**
     * { [callId or argsKey]: 'approve'|'decline' } — what was already clicked
     * this session, so the card does not jump back while the next turn is on
     * its way. Keyed on callId, not argsKey: see toolConfirmStatus.js.
     */
    toolDecisions?: Record<string, string>;
}

/**
 * Whether this turn has anything privacy-related worth showing. The raw-
 * payload transparency used to be reachable only via `count > 0`, so a user
 * with "Show raw payload & token mapping" on but nothing detected saw no
 * confirmation that a scan had run at all (BFSF-291). Any of a tokenised
 * prompt, a raw response or a token map is enough on its own.
 */
function hasPrivacyInfoOf(msg: ChatMessage): boolean {
    const tok = msg.tokenisationInfo;
    const hasRawPayload = !!(tok?.tokenizedPrompt || tok?.rawResponse || tok?.tokenMap);
    return !!(
        (tok?.count || 0) > 0
        || hasRawPayload
        || ((tok?.attachments || []) as Array<{ timeout?: unknown; overflow?: unknown; reason?: unknown } | null>).some(a => a?.timeout || a?.overflow || a?.reason)
    );
}

/**
 * Fully deleted / PII-redacted user messages get a compact indicator. Covers
 * real-time deletion (isDeleted), history-load (content persisted as the
 * removal marker) and an active guardrail countdown.
 */
function isRemovedUserMessage(msg: ChatMessage, isUser: boolean): boolean {
    const removed = msg.isDeleted
        || (isUser && typeof msg.content === 'string' && msg.content === '[Message removed - policy violation]');
    return !!removed && isUser;
}

function bubbleClass(msg: ChatMessage, isUser: boolean, isTool: boolean): string {
    let shape;
    if (isUser) {
        // C10 — the bubble paints with a token, not a hex. `--user-bubble-bg/-fg`
        // is in all eight themes (index.css). NOT --bg-tertiary, however the
        // artboard draws it: EmbedChat rewrites exactly these two properties to
        // pass an embedder's bubble colour through (EmbedChat.jsx).
        shape = 'p-4 max-w-[85%] bg-[var(--user-bubble-bg)] text-[var(--user-bubble-fg)] rounded-br-none';
    } else if (isTool) {
        shape = 'p-4 bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-xl w-full max-w-full';
    } else {
        // C9 — the answer has no bubble: no surface, and so no inner margin
        // pushing the text away from its own tile. The vertical space stays.
        shape = 'py-0.5 w-full text-[var(--text-primary)] rounded-bl-none';
    }
    return `relative rounded-2xl transition-all duration-200 overflow-hidden
                    ${shape}
                ${msg.isGuardrailViolation ? 'opacity-60 scale-95' : ''}
                ${msg.isDeleted ? 'opacity-50 italic' : ''}`;
}

const MessageItem = (props: MessageItemProps) => {
    const { idx, msg, allMessages = [], onEditMessage, showReasoning = true } = props;
    const { t } = useTranslation();
    const simpleMode = useSimpleMode();
    // Simple Mode is an explicit request for a stripped-back surface, so it
    // hides the reasoning panel alongside the "How I got this answer"
    // disclosure. Everything else shows it.
    const reasoningVisible = showReasoning && !simpleMode;
    const isUser = msg.role === 'user';
    const isTool = msg.role === 'tool';
    const [lightboxImage, setLightboxImage] = useState<unknown>(null);
    // C13: which source chip is open. Local, like the lightbox — a citation
    // belongs to one message. A caller that passes `onCitationClick` (the
    // notebooks do) wins: it already has a place for the passage to land.
    const [openCitation, setOpenCitation] = useState<unknown>(null);
    const actions = useMessageActions(msg, props.onCopy, t);
    const feedback = useMessageFeedback(feedbackContext(props));
    const edit = useMessageEdit(idx, onEditMessage);

    // ToolOutput is called as a function, so its useState is this
    // component's — it must run before any early return.
    const { renderToolOutput } = (ToolOutput as unknown as (p: { msg: ChatMessage }) => { renderToolOutput: () => React.ReactNode })({ msg });

    // BFSF-307: the retained compaction summary. Everything before it was
    // folded away and is gone from the database, so a normal bubble would be a
    // lie and hiding it would leave a conversation that starts abruptly. A
    // divider marks where history stops being real.
    if (msg.compactionArtifact) return <CompactionDivider t={t} />;
    if (isRemovedUserMessage(msg, isUser)) return <RemovedUserMessage t={t} />;

    const isAssistant = !isUser && !isTool;
    const msgKey = msg.id || idx;
    return (
        <div className={`flex items-start gap-3 group animate-fade-in w-full ${COLUMN_MAX_W} mx-auto`} data-msg-id={`msg-${msgKey}`} data-testid={`message-${msgKey}`}>
            {isAssistant && <AssistantAvatar avatar={msg.respondingAgentAvatar} />}

            {/* This message's own column. `min-w-0` is not cosmetic: a flex
                child otherwise takes its intrinsic width, and one long line of
                code or URL pushes the whole conversation sideways. */}
            <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} min-w-0 flex-1`}>
                <MessageHeader msg={msg} isAssistant={isAssistant} />

                {!(isUser && edit.isEditing) && (
                    <MessageBubble
                        p={props}
                        isUser={isUser}
                        isTool={isTool}
                        reasoningVisible={reasoningVisible}
                        simpleMode={simpleMode}
                        renderToolOutput={renderToolOutput}
                        setLightboxImage={setLightboxImage}
                        onCitationClick={props.onCitationClick || setOpenCitation}
                        actions={actions}
                        feedback={feedback}
                    />
                )}

                {isUser && <UserTail msg={msg} allMessages={allMessages} idx={idx} edit={edit} canEdit={!!onEditMessage} />}

                {/* Image Lightbox */}
                <ImageLightbox lightboxImage={lightboxImage} setLightboxImage={setLightboxImage} />

                {/* C13 — the passage behind a source chip. The same overlay the
                    notebooks and the Knowledge Studio open, because it is the
                    same chip and the same citation schema (`core/kb/citation.js`).
                    It only renders once something IS clicked. */}
                <CitationOverlay source={openCitation} onClose={() => setOpenCitation(null)} />
            </div>
        </div>
    );
};

/** What the feedback hook reads, with MessageItem's defaults. */
function feedbackContext(p: MessageItemProps): FeedbackContext {
    const { msg, idx, allMessages = [], chatSource = 'agent' } = p;
    return { msg, idx, selectedAgent: p.selectedAgent, conversationId: p.conversationId, agentId: p.agentId, chatSource, allMessages };
}

/** Above the bubble: the responding agent's name (multi-agent) and a guardrail warning. */
function MessageHeader({ msg, isAssistant }: { msg: ChatMessage; isAssistant: boolean }) {
    const { t } = useTranslation();
    return (
        <>
            {/* Sender Info (multi-agent) — just the name; the face is in the tile. */}
            {isAssistant && msg.respondingAgentName && (
                <div className="flex items-center gap-1.5 ml-1 mb-1 text-xs text-[var(--text-secondary)] opacity-80">
                    <span className="font-medium">{msg.respondingAgentName}</span>
                </div>
            )}

            {msg.isGuardrailViolation && <GuardrailWarning msg={msg} t={t} />}
        </>
    );
}

/** Under a user message: the privacy line and its actions, or the inline editor. */
function UserTail({ msg, allMessages, idx, edit, canEdit }: {
    msg: ChatMessage;
    allMessages: ChatMessage[];
    idx: number;
    edit: ReturnType<typeof useMessageEdit>;
    canEdit: boolean;
}) {
    const { t } = useTranslation();
    if (edit.isEditing) {
        // Inline edit mode for user messages — replaces the bubble in place
        return (
            <UserEditComposer
                msg={msg}
                editContent={edit.editContent}
                setEditContent={edit.setEditContent}
                editTextareaRef={edit.editTextareaRef}
                handleEditKeyDown={edit.handleEditKeyDown}
                setIsEditing={edit.setIsEditing}
                submitEdit={edit.submitEdit}
            />
        );
    }
    return (
        <>
            <UserPrivacyRow msg={msg} allMessages={allMessages} idx={idx} t={t} />
            {/* User message actions + timestamp */}
            {!msg.isStreaming && (
                <UserMessageMeta msg={msg} canEdit={canEdit} onEdit={() => edit.startEdit(msg.content)} t={t} />
            )}
        </>
    );
}

function bubbleTestId(isUser: boolean, isTool: boolean): string {
    if (isUser) return 'user-bubble';
    return isTool ? 'tool-body' : 'assistant-body';
}

/** What the preamble above an answer reads, with MessageItem's defaults. */
function preambleProps(p: MessageItemProps, reasoningVisible: boolean, t: PreambleProps['t']): PreambleProps {
    const {
        msg, allMessages = [], chatSource = 'agent', sessionSkills = [],
        liveActivatedSkillIds = [], liveCompletedSkillIds = null, liveCompletions = null,
        onToolDecision = null, toolDecisions = {},
    } = p;
    return {
        msg, allMessages, chatSource, sessionSkills, liveActivatedSkillIds, liveCompletedSkillIds, liveCompletions,
        reasoningVisible, onToolDecision, toolDecisions, t,
    };
}

interface BubbleProps {
    p: MessageItemProps;
    isUser: boolean;
    isTool: boolean;
    reasoningVisible: boolean;
    simpleMode: boolean;
    renderToolOutput: () => React.ReactNode;
    setLightboxImage: (img: unknown) => void;
    onCitationClick: (source: unknown) => void;
    actions: ReturnType<typeof useMessageActions>;
    feedback: ReturnType<typeof useMessageFeedback>;
}

/** The bubble (user), card (tool) or column (assistant) holding the message itself. */
function MessageBubble({ p, isUser, isTool, reasoningVisible, simpleMode, renderToolOutput, setLightboxImage, onCitationClick, actions, feedback }: BubbleProps) {
    const { t } = useTranslation();
    const { msg, idx, allMessages = [], sessionSkills = [], showSources = true, showAnswerChips = false } = p;
    const { contentRef, ...rowActions } = actions;
    const isAssistant = !isUser && !isTool;
    return (
        <div data-testid={bubbleTestId(isUser, isTool)} onCopy={copyWithoutBackground} className={bubbleClass(msg, isUser, isTool)}>
            {isAssistant && <AssistantPreamble {...preambleProps(p, reasoningVisible, t)} />}

            {/* Content */}
            <div
                ref={contentRef}
                className={`prose prose-sm dark:prose-invert max-w-none break-words ${!isUser ? '' : 'bubble-user-prose'}`}
            >
                {!isUser && <AssistantAttachments msg={msg} allMessages={allMessages} />}
                {isTool ? renderToolOutput() : (
                    <MessageContentBody msg={msg} reasoningVisible={reasoningVisible} sessionSkills={sessionSkills} />
                )}
                {!isUser && <GeneratedMediaBlock msg={msg} setLightboxImage={setLightboxImage} />}
            </div>

            {isAssistant && !msg.isStreaming && (
                <AnswerFooter
                    msg={msg}
                    idx={idx}
                    allMessages={allMessages}
                    sessionSkills={sessionSkills}
                    onCitationClick={onCitationClick}
                    showSources={showSources}
                    showAnswerChips={showAnswerChips}
                    simpleMode={simpleMode}
                    hasPrivacyInfo={hasPrivacyInfoOf(msg)}
                    t={t}
                />
            )}

            <BubbleTail p={p} isUser={isUser} setLightboxImage={setLightboxImage} rowActions={rowActions} feedback={feedback} />
        </div>
    );
}

/** The bottom of the bubble: attachments, the action row and the feedback form. */
function BubbleTail({ p, isUser, setLightboxImage, rowActions, feedback }: {
    p: MessageItemProps;
    isUser: boolean;
    setLightboxImage: (img: unknown) => void;
    rowActions: Omit<ReturnType<typeof useMessageActions>, 'contentRef'>;
    feedback: ReturnType<typeof useMessageFeedback>;
}) {
    const { t } = useTranslation();
    const { msg, idx, modelTiers = {} } = p;
    return (
        <>
            {/* Attachments */}
            {msg.attachments && msg.attachments.length > 0 && (
                <MessageAttachments msg={msg} isUser={isUser} setLightboxImage={setLightboxImage} />
            )}

            {/* Action Buttons + Timestamp row */}
            {!isUser && !msg.isStreaming && (
                <MessageActionsRow
                    msg={msg}
                    idx={idx}
                    allowCopy={!p.selectedAgent?.config || p.selectedAgent.config.allowCopy !== false}
                    {...rowActions}
                    feedbackRating={feedback.feedbackRating}
                    feedbackSubmitted={feedback.feedbackSubmitted}
                    handleThumbClick={feedback.handleThumbClick}
                    onRetry={p.onRetry}
                    modelTiers={modelTiers}
                />
            )}

            {feedback.showFeedbackForm && !isUser && <FeedbackForm t={t} {...feedback} />}
        </>
    );
}

// Each message is wrapped in its own ErrorBoundary so a render failure in one
// message (bad markdown, malformed tool result, etc.) can't take down the whole
// conversation. The boundary is inside React.memo so the identity wrapping is
// preserved.
const MemoMessageItem = React.memo(MessageItem);

function MessageItemWithBoundary(props: MessageItemProps) {
    return (
        <MessageErrorBoundary msg={props.msg}>
            <MemoMessageItem {...props} />
        </MessageErrorBoundary>
    );
}

export default MessageItemWithBoundary;

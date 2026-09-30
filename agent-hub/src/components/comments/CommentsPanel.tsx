// The comments of one notebook, page or designed document in a project: a
// margin or drawer panel next to the item.
//
// Open and resolved threads in two lists, open ones in reading order. "Add
// comment" takes the passage selected in the item at that moment (the host's
// `getSelectionAnchor`), or comments on the whole item when nothing is
// selected. Open threads' passages are highlighted in the item
// (`highlightAnchors`), the thread being read more strongly; a click on a
// passage scrolls the item to it (`scrollToAnchor`). A passage that is no
// longer in the text — the host's `getDocumentText` says so, or a scroll
// finds nothing — is shown as changed or removed instead of pointing nowhere.
//
// Editors comment, reply, resolve and choose when the AI answers; viewers
// read. Everything else people do arrives through the project's live feed
// inside the workspace, or by polling elsewhere (useCommentsLive). Loading,
// empty and failed are three different screens, and nothing here pops over
// the item or interrupts typing in it.

import { MessageSquarePlus, MessagesSquare, RefreshCw, X } from 'lucide-react';
import React, { useState } from 'react';
import type { CommentAiResult, CommentAnchor, CommentTargetType, CommentThread as Thread } from '../../api/queries/comments';
import { useTranslation } from '../../hooks/useTranslation';
import SegmentedControl from '../shared/SegmentedControl';
import { GhostButton, LoadingRow, Notice, PrimaryButton, SecondaryButton } from '../projects/workspace/workspaceUi';
import { clampAnchor, isUsableAnchor } from './commentAnchors';
import { commentErrorText } from './commentErrors';
import CommentThread from './CommentThread';
import NewCommentForm from './NewCommentForm';
import { useCommentsPanel, type CommentsPanelModel, type CommentsPanelSource } from './useCommentsPanel';
import { aiRunningIn } from './useCommentsLive';

/** The newest comment of a thread, by seq: the one the reader just posted. */
const lastSeq = (thread: Thread): number | null => (thread.comments.length ? Math.max(...thread.comments.map(c => c.seq)) : null);

export interface CommentsPanelProps extends CommentsPanelSource {
    getSelectionAnchor?: () => CommentAnchor | null;
    onClose?: () => void;
    className?: string;
}

type Filter = 'open' | 'resolved';

function EmptyState({ filter, canComment, targetType }: { filter: Filter; canComment: boolean; targetType: CommentTargetType }) {
    const { t } = useTranslation();
    let hint: string | null = null;
    if (filter === 'open' && !canComment) hint = t('comments.empty_open_viewer', 'When editors comment on this item, their threads appear here.');
    else if (filter === 'open' && targetType === 'task') {
        hint = t('comments.empty_open_task', 'Discuss this task with the team. Mention someone with @, or @ai to ask the AI.');
    } else if (filter === 'open' && targetType === 'notebook') {
        hint = t('comments.empty_open_notebook', 'Select a passage in the notebook and choose Add comment to discuss it. Mention @ai to ask the AI.');
    } else if (filter === 'open') {
        hint = t('comments.empty_open_document', 'Select a passage in the document and choose Add comment to discuss it. Mention @ai to ask the AI.');
    }
    return (
        <div className="flex flex-col items-center text-center gap-2 px-4 py-10" data-testid={`comments-empty-${filter}`}>
            <MessagesSquare className="w-6 h-6 text-[var(--text-tertiary)]" aria-hidden="true" />
            <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
                {filter === 'open' ? t('comments.empty_open_title', 'No open comments') : t('comments.empty_resolved_title', 'No resolved threads')}
            </p>
            {hint && <p className="m-0 text-[12px] text-[var(--text-tertiary)] max-w-[260px]">{hint}</p>}
        </div>
    );
}

function Toolbar({ model, filter, onFilter, drafting, onAdd, anchors }: {
    model: CommentsPanelModel; filter: Filter; onFilter: (f: Filter) => void; drafting: boolean; onAdd: () => void;
    /** The item has text to select a passage in; without it every comment is on the item as a whole. */
    anchors: boolean;
}) {
    const { t } = useTranslation();
    const loaded = !!model.query.data;
    return (
        <div className="flex flex-col gap-2 px-3 pb-2">
            <SegmentedControl
                size="sm"
                ariaLabel={t('comments.filter_label', 'Which threads to show')}
                value={filter}
                onChange={(next) => onFilter(next === 'resolved' ? 'resolved' : 'open')}
                options={[
                    { value: 'open', label: t('comments.filter_open', 'Open'), badge: { count: loaded ? model.openThreads.length : null } },
                    { value: 'resolved', label: t('comments.filter_resolved', 'Resolved'), badge: { count: loaded ? model.resolvedThreads.length : null } },
                ]}
            />
            {model.canComment && !drafting && (
                <div className="flex flex-col gap-1">
                    {/* mousedown would move the focus and drop the selection in the item before the click reads it */}
                    <PrimaryButton onMouseDown={e => e.preventDefault()} onClick={onAdd} data-testid="comments-add">
                        <MessageSquarePlus className="w-3.5 h-3.5" aria-hidden="true" />{t('comments.add', 'Add comment')}
                    </PrimaryButton>
                    {anchors && <span className="text-[11px] text-[var(--text-tertiary)]">{t('comments.add_hint', 'Select text first to comment on a passage.')}</span>}
                </div>
            )}
            {!model.canComment && loaded && (
                <p className="m-0 text-[12px] text-[var(--text-tertiary)]" data-testid="comments-read-only">
                    {t('comments.read_only', 'You can read the comments. Only the project’s editors can add them.')}
                </p>
            )}
        </div>
    );
}

function ThreadList({ model, filter, drafting, currentUserId, targetType }: {
    model: CommentsPanelModel; filter: Filter; drafting: boolean; currentUserId: string | null; targetType: CommentTargetType;
}) {
    const { t } = useTranslation();
    const { query } = model;
    if (query.isPending) return <LoadingRow label={t('comments.loading', 'Loading comments…')} />;
    if (!query.data) {
        return (
            <Notice tone="error" role="alert" testId="comments-error"
                action={<SecondaryButton onClick={() => void query.refetch()}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />{t('comments.retry', 'Try again')}</SecondaryButton>}>
                {commentErrorText(t, query.error, t('comments.error_load', 'The comments could not be loaded.'))}
            </Notice>
        );
    }
    const shown = filter === 'open' ? model.openThreads : model.resolvedThreads;
    if (shown.length === 0) return drafting ? null : <EmptyState filter={filter} canComment={model.canComment} targetType={targetType} />;
    return (
        <>
            {shown.map(thread => (
                <CommentThread
                    key={thread.id}
                    thread={thread}
                    target={model.target}
                    state={model.states.get(thread.id) || 'unknown'}
                    active={model.activeId === thread.id}
                    canComment={model.canComment}
                    isOwner={model.role === 'owner'}
                    currentUserId={currentUserId}
                    nameOf={model.people.nameOf}
                    candidates={model.people.candidates}
                    mentionTokens={model.people.tokens}
                    aiRunning={aiRunningIn(thread, model.live.aiRunning)}
                    aiNote={model.live.aiNotes.get(thread.id) ?? null}
                    onAiResult={(ai: CommentAiResult, askedAi: boolean, afterSeq: number | null) => model.live.reportAi(thread.id, ai, { askedAi, afterSeq })}
                    aiPolicy={model.query.data?.aiPolicy ?? null}
                    onActivate={() => model.setActiveId(thread.id)}
                    onJump={() => model.jump(thread)}
                />
            ))}
        </>
    );
}

export default function CommentsPanel(props: CommentsPanelProps) {
    const { t } = useTranslation();
    const model = useCommentsPanel(props);
    const [filter, setFilter] = useState<Filter>('open');
    const [draft, setDraft] = useState<{ anchor: CommentAnchor | null } | null>(null);

    const startComment = () => {
        let anchor: CommentAnchor | null = null;
        try { anchor = props.getSelectionAnchor ? props.getSelectionAnchor() : null; } catch { anchor = null; }
        setDraft({ anchor: isUsableAnchor(anchor) ? clampAnchor(anchor) : null });
        setFilter('open');
    };

    return (
        <aside className={`flex flex-col min-h-0 h-full bg-[var(--bg-secondary)] ${props.className || ''}`.trim()}
            aria-label={t('comments.panel_label', 'Comments')} data-testid="comments-panel">
            <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <h2 className="m-0 text-[14px] font-semibold text-[var(--text-primary)] flex-1">{t('comments.title', 'Comments')}</h2>
                {props.onClose && (
                    <GhostButton onClick={props.onClose} aria-label={t('comments.close', 'Close comments')} title={t('comments.close', 'Close comments')}>
                        <X className="w-4 h-4" aria-hidden="true" />
                    </GhostButton>
                )}
            </header>
            <Toolbar model={model} filter={filter} onFilter={setFilter} drafting={!!draft} onAdd={startComment} anchors={!!props.getSelectionAnchor} />
            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 flex flex-col gap-2">
                {draft && model.canComment && (
                    <NewCommentForm
                        target={model.target}
                        anchor={draft.anchor}
                        candidates={model.people.candidates}
                        aiPolicy={model.query.data?.aiPolicy ?? null}
                        onCreated={(thread, ai, askedAi) => {
                            setDraft(null);
                            model.setActiveId(thread.id);
                            model.live.reportAi(thread.id, ai, { askedAi, afterSeq: lastSeq(thread) });
                        }}
                        onCancel={() => setDraft(null)}
                    />
                )}
                <ThreadList model={model} filter={filter} drafting={!!draft} currentUserId={props.currentUser?.id || null} targetType={props.targetType} />
            </div>
        </aside>
    );
}

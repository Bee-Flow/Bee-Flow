// The calm lines under the toolbar: an error, a recovered draft, a conflict
// waiting for a choice, somebody else in the same section, changes combined
// with yours, text kept when a page went live, or that this reader only
// reads. Never a pop-up.

import { AlertTriangle, GitMerge, Info, Users } from 'lucide-react';
import React from 'react';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import type { Draft } from '../useDocumentAutosave';
import { LINK_BUTTON, NOTICE } from './ui';

export interface EditorNoticesProps {
    error: string | null;
    onDismissError: () => void;
    draft: Draft | null;
    onRestoreDraft: () => void;
    onCompareDraft: () => void;
    onDiscardDraft: () => void;
    conflict: boolean;
    onOpenConflict: () => void;
    sharing: string | null;
    merged: boolean;
    onShowMerged: () => void;
    onDismissMerged: () => void;
    readOnly: boolean;
    /** A page went live while a save was out: its text is kept in the history. */
    keptLive?: { onOpen: () => void; onDismiss: () => void } | null;
}

function Line({ tone, icon, children, testId }: { tone: 'error' | 'warning' | 'info'; icon: React.ReactNode; children: React.ReactNode; testId: string }) {
    const bg = { error: 'bg-[var(--error)]/10', warning: 'bg-[var(--warning)]/10', info: 'bg-[var(--bg-tertiary)]' }[tone];
    return <div className={`${NOTICE} ${bg}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}>{icon}{children}</div>;
}

function DraftLine({ draft, onRestore, onCompare, onDiscard }: { draft: Draft; onRestore: () => void; onCompare: () => void; onDiscard: () => void }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    return (
        <Line tone="warning" icon={<Info size={14} aria-hidden="true" />} testId="document-recovery">
            <span className="flex-1">{draft.at ? t('documents.recovery.found_at', 'Changes that were not saved were kept from {time}.', { time: rel(draft.at) }) : t('documents.recovery.found', 'Changes that were not saved were kept.')}</span>
            <button type="button" className={LINK_BUTTON} onClick={onRestore}>{t('documents.recovery.restore', 'Put them back')}</button>
            <button type="button" className={LINK_BUTTON} onClick={onCompare}>{t('documents.recovery.compare', 'Compare')}</button>
            <button type="button" className={LINK_BUTTON} onClick={onDiscard}>{t('documents.recovery.discard', 'Discard')}</button>
        </Line>
    );
}

export default function EditorNotices(props: EditorNoticesProps) {
    const { t } = useTranslation();
    return (
        <>
            {props.readOnly && (
                <Line tone="info" icon={<Info size={14} aria-hidden="true" />} testId="document-read-only">
                    <span>{t('documents.read_only', 'You can read this document. Only its owner and the project\'s editors can change it.')}</span>
                </Line>
            )}
            {props.error && (
                <Line tone="error" icon={<AlertTriangle size={14} aria-hidden="true" />} testId="document-error">
                    <span className="flex-1">{props.error}</span>
                    <button type="button" className={LINK_BUTTON} onClick={props.onDismissError}>{t('documents.dismiss', 'Dismiss')}</button>
                </Line>
            )}
            {props.conflict && (
                <Line tone="warning" icon={<GitMerge size={14} aria-hidden="true" />} testId="document-conflict">
                    <span className="flex-1">{t('documents.conflict.notice', 'Someone else changed the same part while you were typing. Nothing is lost: compare the two and choose.')}</span>
                    <button type="button" className={LINK_BUTTON} onClick={props.onOpenConflict}>{t('documents.conflict.open', 'Compare and choose')}</button>
                </Line>
            )}
            {props.keptLive && (
                <Line tone="warning" icon={<Info size={14} aria-hidden="true" />} testId="document-kept-live">
                    <span className="flex-1">{t('documents.page.live_kept', 'This page went live while your text was being saved. What you typed is kept in its version history.')}</span>
                    <button type="button" className={LINK_BUTTON} onClick={props.keptLive.onOpen}>{t('documents.page.live_kept_open', 'Open the history')}</button>
                    <button type="button" className={LINK_BUTTON} onClick={props.keptLive.onDismiss}>{t('documents.dismiss', 'Dismiss')}</button>
                </Line>
            )}
            {props.draft && !props.conflict && <DraftLine draft={props.draft} onRestore={props.onRestoreDraft} onCompare={props.onCompareDraft} onDiscard={props.onDiscardDraft} />}
            {props.sharing && (
                <Line tone="info" icon={<Users size={14} aria-hidden="true" />} testId="document-soft-lock">
                    <span>{props.sharing}</span>
                </Line>
            )}
            {props.merged && (
                <Line tone="info" icon={<GitMerge size={14} aria-hidden="true" />} testId="document-merged">
                    <span className="flex-1">{t('documents.merged', 'Changes someone else saved meanwhile were combined with yours.')}</span>
                    <button type="button" className={LINK_BUTTON} onClick={props.onShowMerged}>{t('documents.merged_show', 'Show them')}</button>
                    <button type="button" className={LINK_BUTTON} onClick={props.onDismissMerged}>{t('documents.dismiss', 'Dismiss')}</button>
                </Line>
            )}
        </>
    );
}

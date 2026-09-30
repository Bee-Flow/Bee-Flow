/**
 * What a transcript lets its messages do — rate, retry, edit, open a
 * citation's passage — handed down by context rather than through every cell's
 * props.
 *
 * Context, not props, because of the streaming cell: the FlatList's
 * `renderItem` has to stay the same function for the whole turn, or every
 * finished answer (each a markdown tree) re-renders at the flush rate. The
 * handlers here are the chat's stable `useLatest` identities, so the value
 * changes when a turn starts or ends and not in between.
 *
 * A surface that gives no handler gets no button: a notebook's answers have
 * no retry, and a transcript the server does not keep has nothing to rate.
 */

import { createContext, useContext } from 'react';

import type { FeedbackTarget } from '../model/feedback';
import type { TierMap } from '../model/tiers';
import type { ChatMessage, PendingToolCall } from '../model/types';

export type ToolDecision = 'approve' | 'decline';

export interface TranscriptActions {
    /** Where ratings are filed. Absent: no thumbs. */
    feedback?: Omit<FeedbackTarget, 'messageId'>;
    /** The conversation, oldest first — what "Include conversation" sends with a rating. */
    conversation?: () => readonly ChatMessage[];
    /** Ask the question behind `answer` again, on `tier` when given. Absent while a turn streams. */
    onRetry?: (answer: ChatMessage, tier?: string | null) => void;
    /** Replace a question with new words and answer it again. Absent while a turn streams. */
    onEdit?: (question: ChatMessage, text: string) => void;
    /** Approve or decline an action the agent was held from. Absent: the card is a notice. */
    onToolDecision?: (call: PendingToolCall, decision: ToolDecision) => void;
    /** This session's decisions, by callId (else argsKey). */
    toolDecisions?: Readonly<Record<string, string>>;
    /** The tiers "Retry with model" offers. */
    tiers?: TierMap;
    /**
     * Whether citations may be shown. Fail-closed, as on the web: a chip
     * carries a document title, a page and a heading.
     */
    showSources?: boolean;
    /**
     * The builder's half of the chip row: the rules a second model judged the
     * answer to follow. Off unless a surface asks, as on the web.
     */
    showProcess?: boolean;
}

const NONE: TranscriptActions = {};

export const TranscriptActionsContext = createContext<TranscriptActions>(NONE);

export function useTranscriptActions(): TranscriptActions {
    return useContext(TranscriptActionsContext);
}

/**
 * The builder chat: the transcript, sending a turn, and what a finished turn
 * changes.
 *
 * A turn is not only an answer. The server builds its prompt from the three
 * file bodies the CLIENT sends (webpageChat.js: "the frontend is the source
 * of truth for the three slot contents while a chat turn is in flight"), so a
 * send first reads the bodies fresh from the server: the server writes its
 * edits over whatever is stored, so a cached copy from before an edit on the
 * web would quietly undo that edit. The builder's edits come back as whole
 * new bodies (`webpage_doc_update`); they go into the cached copy the Code
 * tab reads, and the parts of the page they touch are refreshed.
 *
 * The transcript is stored whole after every settled turn (PUT /:id/chat),
 * as the web does, so the two clients continue the same conversation. The
 * PUT replaces what is stored, so the cached page detail gets the same rows:
 * the next visit mounts the transcript from that cache, and an older list
 * there would be saved back over the turns in between.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';

import { encodeAttachments, toWire, type Attachment } from '@/features/chat';
import { emptyWebpageTurn, useTurnStream, WEBPAGE_FRAMES, type WebpageTurn } from '@/shared/stream';

import { webpageFilesQuery } from './queries';
import { clearChat, saveChat } from '../api/buildEndpoints';
import { webpageKeys } from '../api/keys';
import type { WebpageFiles } from '../model/buildTypes';
import {
    historyOf,
    markExecuted,
    newEntry,
    readStoredChat,
    setPlanStatus,
    settleEntry,
    toStored,
    type ChatEntry,
    type ChatMode,
} from '../model/chat';
import type { WebpageDetail } from '../model/types';

export const WEBPAGE_STREAM_PATH = '/ai/chat/webpage/stream';

/** What the web sends as the approval turn (WebpageEditorPage handlePlanApprove). */
const APPROVAL_TEXT = 'Approved — please build the plan.';

export interface WebpageChatOptions {
    pageId: string;
    /** The stored rows from GET /:id; read once, then this hook owns the transcript. */
    stored: readonly Record<string, unknown>[];
    modelTier: string;
    mode: ChatMode;
}

/** Put the builder's edits where the screens read them, and refresh what they touched. */
export function applyTurn(queryClient: QueryClient, pageId: string, turn: WebpageTurn): void {
    const slots = Object.keys(turn.slots);
    if (slots.length) {
        queryClient.setQueryData<WebpageFiles>(webpageKeys.files(pageId), (old) =>
            old ? { ...old, ...turn.slots } : old,
        );
    }
    if (slots.length || turn.extraPaths.length || turn.settingsChanged) {
        // The preview's document, and the sizes, the project file list, the
        // framework and the new version row.
        void queryClient.invalidateQueries({ queryKey: webpageKeys.document(pageId) });
        void queryClient.invalidateQueries({ queryKey: webpageKeys.detail(pageId) });
        void queryClient.invalidateQueries({ queryKey: webpageKeys.all });
    } else if (turn.sourcesAdded) {
        void queryClient.invalidateQueries({ queryKey: webpageKeys.sources(pageId) });
    }
}

function cacheChat(queryClient: QueryClient, pageId: string, rows: Record<string, unknown>[]): void {
    queryClient.setQueryData<WebpageDetail | null>(webpageKeys.detail(pageId), (old) =>
        old ? { ...old, chatMessages: rows } : old,
    );
}

/** Store the whole transcript, and give the cached page detail the same rows. */
export function persistChat(queryClient: QueryClient, pageId: string, entries: readonly ChatEntry[]): void {
    const rows = entries.map(toStored);
    cacheChat(queryClient, pageId, rows);
    // Best effort, like the web's debounced save: the next settled turn stores
    // the whole transcript again, so one failed save loses nothing for good.
    saveChat(pageId, rows).catch(() => undefined);
}

/** The three bodies as the server holds them now, never an older cached copy. */
export function liveFiles(queryClient: QueryClient, pageId: string): Promise<WebpageFiles> {
    return queryClient.fetchQuery({ ...webpageFilesQuery(pageId), staleTime: 0 });
}

interface TurnInput {
    text: string;
    attachments: Attachment[];
    planId?: string;
}

/**
 * The transcript as state, plus a ref that is always the newest list: a
 * turn's end arrives in a callback that closed over an older render.
 */
function useTranscript(stored: readonly Record<string, unknown>[]) {
    const [entries, setEntries] = useState<ChatEntry[]>(() => readStoredChat(stored));
    const latest = useRef(entries);
    useEffect(() => {
        latest.current = entries;
    });
    const commit = (next: ChatEntry[]) => {
        latest.current = next;
        setEntries(next);
    };
    const fail = (placeholderId: string, error: string) => {
        commit(
            latest.current.map((e) =>
                e.message.id === placeholderId ? { ...e, message: { ...e.message, streaming: false, error } } : e,
            ),
        );
    };
    return { entries, latest, commit, fail };
}

export function useWebpageChat({ pageId, stored, modelTier, mode }: WebpageChatOptions) {
    const queryClient = useQueryClient();
    const { entries, latest, commit, fail } = useTranscript(stored);
    const building = useRef(false);

    const stream = useTurnStream<WebpageTurn>({
        empty: emptyWebpageTurn,
        adapter: WEBPAGE_FRAMES,
        onDone: (turn) => {
            let next = latest.current.map((e) => settleEntry(e, turn));
            if (building.current) next = markExecuted(next);
            building.current = false;
            commit(next);
            persistChat(queryClient, pageId, next);
            applyTurn(queryClient, pageId, turn);
        },
    });

    const run = async ({ text, attachments, planId }: TurnInput) => {
        const history = historyOf(latest.current);
        const question = newEntry({
            id: Crypto.randomUUID(),
            role: 'user',
            content: text,
            attachments,
            createdAt: new Date().toISOString(),
        });
        const placeholder = newEntry({ id: Crypto.randomUUID(), role: 'assistant', content: '', streaming: true });
        commit([...latest.current, question, placeholder]);
        let files: WebpageFiles;
        let wire;
        try {
            files = await liveFiles(queryClient, pageId);
            wire = toWire(await encodeAttachments(attachments));
        } catch (err) {
            fail(placeholder.message.id, (err as Error).message);
            return;
        }
        building.current = Boolean(planId);
        await stream.run(WEBPAGE_STREAM_PATH, {
            webpageId: pageId,
            message: text,
            history,
            modelTier,
            chatMode: mode,
            attachments: wire,
            htmlContent: files.html,
            cssContent: files.css,
            jsContent: files.js,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(planId ? { planExecution: { planId, action: 'execute' } } : {}),
        });
    };

    const decide = (planId: string, approve: boolean) => {
        const next = setPlanStatus(latest.current, planId, approve ? 'approved' : 'rejected');
        commit(next);
        if (approve) void run({ text: APPROVAL_TEXT, attachments: [], planId });
        else persistChat(queryClient, pageId, next);
    };

    const startOver = async () => {
        stream.stop();
        commit([]);
        stream.reset();
        cacheChat(queryClient, pageId, []);
        await clearChat(pageId);
    };

    return {
        entries,
        store: stream.store,
        streaming: stream.streaming,
        send: (text: string, attachments: Attachment[] = []) => void run({ text, attachments }),
        stop: stream.stop,
        approvePlan: (planId: string) => decide(planId, true),
        rejectPlan: (planId: string) => decide(planId, false),
        startOver,
    };
}

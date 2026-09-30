/**
 * What the Chat tab's composer handed a new chat — its words (the `draft`
 * route param) and its files (staged in model/newChat) — sent once, on mount.
 *
 * Guarded by a ref: expo-router keeps the param around, so a re-render — or a
 * back-and-forward — would otherwise send it again. The files are taken only
 * by a NEW chat, in the first render, and taking them clears the stage, so an
 * existing chat never picks them up and a second mount finds none.
 */

import { useEffect, useRef, useState } from 'react';

import { takeNewChatFiles } from '../model/newChat';
import type { Attachment } from '../model/types';

export function useDraftOnce(
    draft: string | undefined,
    isNew: boolean,
    send: (text: string, attachments: Attachment[]) => void,
): void {
    const [files] = useState(() => (isNew ? takeNewChatFiles() : []));
    const sent = useRef(false);
    useEffect(() => {
        if (sent.current || !isNew || (!draft && !files.length)) return;
        sent.current = true;
        send(draft ?? '', files);
    }, [draft, isNew, files, send]);
}

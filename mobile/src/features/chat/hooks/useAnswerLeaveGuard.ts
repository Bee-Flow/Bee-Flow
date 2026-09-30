/**
 * Leaving while an answer is being written asks first: the screen's stream
 * closes with it, which stops the answer, and some providers then save
 * nothing of the turn.
 *
 * The confirm half of shared/patterns' useConfirmLeave, with one exemption
 * its `dirty` flag cannot carry: a conversation deleted from its details
 * screen. That screen pops itself and this one (model/deletedChat.ts) in the
 * same callback that deleted it, before anything renders, so a flag lowered on
 * the next render comes too late. The exemption is read when the removal
 * comes. There is nothing left to stop for then: the pop goes through, and
 * unmounting closes the stream.
 */

import { useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

import { useLatest } from './useLatest';
import { wasDeleted } from '../model/deletedChat';

export function useAnswerLeaveGuard(streaming: boolean, conversationId: string | null): void {
    const t = useTranslation();
    const confirm = useConfirm();
    const navigation = useNavigation();
    const leaving = useRef(false);
    const asking = useRef(false);

    const ask = useLatest((action: Parameters<typeof navigation.dispatch>[0]) => {
        if (asking.current) return;
        asking.current = true;
        void confirm({
            title: t('mobile.chat.leave_streaming_title', 'Stop this answer?'),
            message: t('mobile.chat.leave_streaming_body', 'The answer is still being written. Leaving stops it, and it may not be saved.'),
            confirmLabel: t('mobile.chat.leave_streaming_confirm', 'Stop and leave'),
        }).then((ok) => {
            asking.current = false;
            if (!ok) return;
            leaving.current = true;
            navigation.dispatch(action);
        });
    });

    useEffect(() => {
        if (!streaming) return undefined;
        return navigation.addListener('beforeRemove', (event) => {
            if (leaving.current || wasDeleted(conversationId)) return;
            event.preventDefault();
            ask(event.data.action);
        });
    }, [navigation, streaming, conversationId, ask]);
}

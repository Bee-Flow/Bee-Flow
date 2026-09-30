/**
 * Closing the last screen of a routine whose save is failing asks first.
 *
 * Nothing is thrown away when that screen closes: the registry keeps an
 * unsaved draft and keeps trying while the app is open. But the edits live
 * only on this phone until a save lands, so the person hears that before
 * going, not after. Going back from the step editor to the build screen is
 * never held: the build screen still shows the failure.
 */

import { useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

import { useDraftState } from './useFlowDraft';
import { draftHolders } from '../state/registry';
import type { DraftStore } from '../state/types';

export function useUnsavedLeave(key: string, store: DraftStore): void {
    const navigation = useNavigation();
    const confirm = useConfirm();
    const t = useTranslation();
    // Not `status === 'error'`: the next edit flips the status back to
    // 'pending' while the failed save still stands, and leaving then went
    // unasked. A failure stands until a save lands.
    const failing = useDraftState(store, (s) => s.dirty && s.saveError !== null);
    const leaving = useRef(false);
    useEffect(() => {
        if (!failing) return undefined;
        return navigation.addListener('beforeRemove', (event) => {
            if (leaving.current || draftHolders(key) > 1) return;
            event.preventDefault();
            void confirm({
                title: t('mobile.flow.leave_unsaved.title', 'Not saved yet'),
                message: t(
                    'mobile.flow.leave_unsaved.message',
                    'Your latest changes have not reached the server yet. They stay on this phone, encrypted, and are sent as soon as the server can be reached.',
                ),
                confirmLabel: t('mobile.flow.leave_unsaved.leave', 'Leave anyway'),
            }).then((ok) => {
                if (!ok) return;
                leaving.current = true;
                navigation.dispatch(event.data.action);
            });
        });
    }, [navigation, failing, confirm, t, key]);
}

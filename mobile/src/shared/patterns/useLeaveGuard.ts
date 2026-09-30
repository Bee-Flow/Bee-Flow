/**
 * Leaving with unsaved changes asks first — the web's beforeunload guard for
 * a phone: the screen's removal (Back, a swipe, a replace) is held while the
 * draft is dirty, and let through once the person chooses to leave.
 *
 * `useLeaveGuard` hands the question to a screen that draws its own sheet
 * (the Form page shares one with its tab switch); `useConfirmLeave` asks it
 * through the app's confirm sheet, for a screen with a Save bar and nothing
 * else to say.
 */

import { useNavigation } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { useTranslation } from '@/core/i18n';

import { useConfirm } from './confirm';

export function useLeaveGuard(dirty: boolean) {
    const navigation = useNavigation();
    const [held, setHeld] = useState<Parameters<typeof navigation.dispatch>[0] | null>(null);
    const leaving = useRef(false);
    useEffect(() => {
        if (!dirty) return undefined;
        return navigation.addListener('beforeRemove', (event) => {
            if (leaving.current) return;
            event.preventDefault();
            setHeld(event.data.action);
        });
    }, [navigation, dirty]);
    return {
        asking: held !== null,
        stay: () => setHeld(null),
        leave: () => {
            const action = held;
            setHeld(null);
            leaving.current = true;
            if (action) navigation.dispatch(action);
        },
    };
}

/** What the question says, for a screen whose reason to ask is not an unsaved draft. */
export interface LeaveWords {
    title: string;
    message: string;
    confirmLabel: string;
}

/**
 * Back with a dirty draft asks "Leave and lose them?"; staying keeps the
 * draft. `words` replaces that question where something else is at stake
 * (an answer still being written).
 */
export function useConfirmLeave(dirty: boolean, words?: LeaveWords): void {
    const t = useTranslation();
    const confirm = useConfirm();
    const guard = useLeaveGuard(dirty);
    const asked = useRef(false);
    const title = words?.title ?? t('org.unsaved_changes', 'Unsaved changes');
    const message = words?.message ?? t('mobile.patterns.unsaved_leave_body', 'Your changes here are not saved yet. Leave and lose them?');
    const confirmLabel = words?.confirmLabel ?? t('forms.page.unsaved_leave', 'Leave');
    const { asking, leave, stay } = guard;
    useEffect(() => {
        if (!asking || asked.current) return;
        asked.current = true;
        void confirm({ title, message, confirmLabel }).then((ok) => {
            asked.current = false;
            if (ok) leave();
            else stay();
        });
    }, [asking, confirm, title, message, confirmLabel, leave, stay]);
}

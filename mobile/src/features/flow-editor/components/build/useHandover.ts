/**
 * A new automation's hand-over to its own build route. The draft store creates
 * the row on the first edit (or the first test run) and useFlowDraft calls
 * `onCreated` once with the id; the new-automation screen then REPLACES itself
 * with /automations/<id>/build — the store is registered under the id too,
 * so its undo history comes along. Only while this screen is on top: with
 * the step editor pushed over it, a replace would swap out the editor, so the
 * hand-over waits until the screen is focused again.
 *
 * `hold` waits too: while the AI builder streams into an automation its first
 * turn created (or its sheet is open), replacing the screen would end the
 * turn, so the hand-over happens once the turn is over and the sheet closed.
 */

import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { buildPath } from '../outline/stepRoute';

export function useHandover(isNew: boolean, hold = false): (automationId: string) => void {
    const router = useRouter();
    const navigation = useNavigation();
    const pending = useRef<string | null>(null);
    const held = useRef(hold);
    const handover = useCallback(() => {
        const id = pending.current;
        if (!id || held.current) return;
        pending.current = null;
        router.replace(buildPath(id));
    }, [router]);
    useFocusEffect(handover);
    useEffect(() => {
        held.current = hold;
        if (!hold && navigation.isFocused()) handover();
    }, [hold, navigation, handover]);
    return useCallback(
        (id: string) => {
            if (!isNew) return;
            pending.current = id;
            if (navigation.isFocused()) handover();
        },
        [isNew, navigation, handover],
    );
}

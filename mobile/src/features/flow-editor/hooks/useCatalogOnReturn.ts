/**
 * The catalog again when the author comes back to a step. It is not re-read
 * while an automation is edited (useCatalog) because it is slow to build, but a
 * datatable editor with no tables says "make one in Studio → Datatables … it
 * appears in this list as soon as it exists". Leaving the step editor for a
 * screen pushed over it (Datatables, Knowledge, Agents) and coming back reads
 * it anew; opening a step does not. Going the other way — out of the editor to
 * the Studio tab and back in — remounts the automation's screen, whose
 * `freshOnMount` read covers it.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useNavigation } from 'expo-router';
import { useEffect } from 'react';

import { flowKeys } from '../api/keys';

export function useCatalogOnReturn(): void {
    const navigation = useNavigation();
    const queryClient = useQueryClient();
    useEffect(() => {
        let left = false;
        const offBlur = navigation.addListener('blur', () => {
            left = true;
        });
        const offFocus = navigation.addListener('focus', () => {
            if (!left) return;
            left = false;
            void queryClient.invalidateQueries({ queryKey: flowKeys.catalog, exact: true });
        });
        return () => {
            offBlur();
            offFocus();
        };
    }, [navigation, queryClient]);
}

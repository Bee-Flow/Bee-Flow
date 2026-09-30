/** Writing the theme choice to the account. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { DayNight } from '@/core/theme/tokens';

import { saveUserBranding } from '../api/endpoints';
import { brandingKeys } from '../api/keys';

/**
 * `preset` is the same vocabulary on both sides — the server's brandingStore
 * accepts the eight palette names (plus 'custom'); the phone only ever sends
 * `light` or `dark`, the two it offers. 'system' has no server equivalent, so the
 * caller does not push it.
 */
export function useSaveThemePreset() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (preset: DayNight) => saveUserBranding({ preset }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: brandingKeys.effective });
        },
    });
}

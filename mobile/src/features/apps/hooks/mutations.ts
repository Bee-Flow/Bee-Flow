/** Pressing an app's button. A run changes no cached list, so nothing is invalidated. */

import { useMutation } from '@tanstack/react-query';

import { runAppAction } from '../api/endpoints';
import type { AppActionResult, AppFormValues } from '../model/types';

/** Which action of which app; `draft` when the runtime on screen is the owner's draft. */
export interface AppActionTarget {
    appId: string;
    actionId: string;
    draft?: boolean;
}

export function useRunAppAction(
    { appId, actionId, draft = false }: AppActionTarget,
    collect: () => AppFormValues,
    onResult: (result: AppActionResult | null) => void,
) {
    return useMutation({
        mutationFn: () => runAppAction(appId, actionId, collect(), draft),
        onSuccess: onResult,
    });
}

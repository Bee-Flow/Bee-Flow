import { useCallback, useEffect, useState } from 'react';
import { applyPresenterShots, readPresenter, writePresenter } from './presenterMode';

/**
 * Presenter mode (flow/presenterMode.js) for the automation canvas.
 *
 * Bigger text for a projector: the cards re-derive their LOD from
 * PresenterContext (flow/useZoomLod.js), the stylesheet keys on
 * `data-presenter` on the wrapper, edges.jsx thickens the lines, and the
 * build's push-in frames tighter (applyPresenterShots). A per-user
 * preference, read once on mount. Toggled from the zoom stack, Shift+P,
 * or P with nothing selected (plain P on a selected card is "freeze the
 * output").
 */
export function usePresenterToggle(): [boolean, () => void] {
    const [presenter, setPresenter] = useState<boolean>(readPresenter);
    const togglePresenter = useCallback(() => {
        const next = !presenter;
        writePresenter(next);
        setPresenter(next);
    }, [presenter]);
    useEffect(() => {
        applyPresenterShots(presenter);
        return () => applyPresenterShots(false);
    }, [presenter]);
    return [presenter, togglePresenter];
}

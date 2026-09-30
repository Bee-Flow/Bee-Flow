/**
 * A text box that writes only when it is left (a name, an output's name, a
 * header key) must also write when the FORM is left while the box still has
 * focus: paging to the next step or pressing Back unmounts the editor, and
 * React Native's blur arrives after the component is gone, so its onBlur
 * never runs. The web's node editor flushes its draft on unmount for the same
 * reason. `pending` says there is typed text the value does not hold yet.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

export function useCommitOnUnmount(pending: boolean, commit: () => void): void {
    const latest = useRef({ pending, commit });
    useLayoutEffect(() => {
        latest.current = { pending, commit };
    });
    useEffect(
        () => () => {
            if (latest.current.pending) latest.current.commit();
        },
        [],
    );
}

import { useCallback, useRef, useState, useLayoutEffect } from 'react';
import type { ManagedBannerInfo, ManagedPart } from '../../shared/managedPart';
import { declaresManaged, managedOf, managedRefusalOf } from '../../shared/managedPart';

/**
 * Whether this builder is read-only because a Solution stage manages the
 * automation, and the refusal that can make it so mid-session. Split out of
 * BuilderShell without a change in behaviour.
 */
export default function useManagedPart({ serverAutomation, isStep }: { serverAutomation: unknown; isStep: boolean }) {
    // ── Managed by a Solution stage (design 9) ────────────────────────────
    // What the server said on the GET (`managed`), kept across the answers of
    // a save or an activate that do not repeat it, and whatever a refused
    // write or run said (409 managed_part[_not_deployed]) for a tab that was
    // opened before the stage took the automation over. A managed automation is
    // read-only for real: the canvas gets `readOnly`, the draft never changes,
    // nothing is saved and the AI builder cannot be entered. On/Off and Run
    // stay (the live state and the stage decide those).
    const [managedSeen, setManagedSeen] = useState<ManagedPart | null>(() => (declaresManaged(serverAutomation) ? managedOf(serverAutomation) : null));
    const [managedRefusal, setManagedRefusal] = useState<ManagedBannerInfo | null>(null);
    // Adopted during render whenever the server's answer changes.
    const [seenAnswer, setSeenAnswer] = useState<unknown>(serverAutomation);
    if (seenAnswer !== serverAutomation) {
        setSeenAnswer(serverAutomation);
        if (declaresManaged(serverAutomation)) setManagedSeen(managedOf(serverAutomation));
    }
    const managedPart = isStep ? null : (managedSeen ?? managedRefusal?.managed ?? null);
    const managedNotDeployed = !isStep && managedRefusal?.reason === 'not_deployed';
    const readOnly = !isStep && (!!managedPart || managedRefusal != null);
    const readOnlyRef = useRef(false);
    useLayoutEffect(() => {
        readOnlyRef.current = readOnly;
    });
    /** True when `e` was the stage's refusal; the banner then speaks for it. */
    const noteManagedRefusal = useCallback((e: unknown) => {
        const info = managedRefusalOf(e);
        if (info) setManagedRefusal(info);
        return !!info;
    }, []);

    return { managedPart, managedNotDeployed, readOnly, readOnlyRef, noteManagedRefusal };
}

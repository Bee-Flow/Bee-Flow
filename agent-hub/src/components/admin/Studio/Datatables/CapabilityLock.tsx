import { Lock } from 'lucide-react';
import React from 'react';
import { useEntitlements } from '../../../licensing/EntitlementsContext';

/**
 * The Enterprise lock for a control whose licence line runs THROUGH it rather
 * than around it: setting a retention window is paid while shortening one is
 * free, adding a table as a knowledge source is paid while the other kinds are
 * free. A whole-section `<Gate>` cannot say that, so the control asks this
 * and locks only the part that is paid.
 *
 * Display only. The server has the last word (requireCapability answers 403
 * `feature_locked`), and `licenceRefusal` turns that answer into the same
 * reason, so a refusal the screen did not see coming still reads as the lock
 * rather than as an error code.
 */

/** 'ceiling' (not on the plan), 'not_granted' (on it, not switched on), or null. */
export type LockReason = string | null;

type EntitlementsView = {
    lockReason?: (id: string) => string | null;
    loading?: boolean;
    error?: unknown;
};

/**
 * Why this capability is locked for the viewer, or null when it is not.
 * Only a real answer locks: while the entitlements load, or when they failed
 * to load, the controls stay usable and the server decides.
 */
export function useCapabilityLock(capability: string): LockReason {
    const { lockReason, loading, error } = useEntitlements() as unknown as EntitlementsView;
    if (loading || error || typeof lockReason !== 'function') return null;
    return lockReason(capability);
}

type ApiError = { status?: number; code?: string | null; body?: { error?: string } | null } | null | undefined;

/**
 * A server refusal as a lock reason, or null when it was not about the
 * licence. The API clients here put the body's `error` word in `.message` and
 * keep the body on `.body`; `feature_locked` has no `code`, which is why a
 * check on `code` alone never saw it.
 */
export function licenceRefusal(e: unknown): LockReason {
    const err = e as ApiError;
    if (!err) return null;
    const word = err.body?.error;
    if (word === 'feature_disabled') return 'not_granted';
    if (word === 'feature_locked' || err.status === 402 || err.code === 'capability_required') return 'ceiling';
    return null;
}

/** The lock line: the lock glyph and one sentence, in the caption colour. */
export function LockNote({ children, testId }: { children: React.ReactNode; testId?: string }) {
    return (
        <p className="flex items-start gap-1.5 text-[11px] leading-4 text-[var(--text-tertiary)]" data-testid={testId}>
            <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{children}</span>
        </p>
    );
}

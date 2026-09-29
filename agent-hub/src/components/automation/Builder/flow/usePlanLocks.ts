import { useMemo } from 'react';
import { useEntitlements } from '../../../licensing/EntitlementsContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import { planLocksFrom, planLockReason, type PlanLocks } from './planLockModel';

type LockReasonFn = (id: string) => string | null;

/** The current viewer's plan locks (flow/planLockModel.ts), stable between renders. */
export function usePlanLocks(): PlanLocks {
    const ent = useEntitlements() as unknown as { lockReason?: LockReasonFn; loading?: boolean; error?: unknown } | null;
    const { t } = useTranslation();
    const lockReason = ent?.lockReason;
    const loading = ent?.loading;
    const error = ent?.error;
    return useMemo(() => planLocksFrom({ lockReason, loading, error }, t), [lockReason, loading, error, t]);
}

/** The lock on one step kind for the current viewer, or null. */
export function usePlanLockReason(kind: unknown): string | null {
    const locks = usePlanLocks();
    return planLockReason(kind, { planLocks: locks });
}

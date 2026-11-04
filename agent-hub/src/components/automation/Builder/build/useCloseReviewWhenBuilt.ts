import useAdjustOnChange from '@/hooks/useAdjustOnChange';

/** A plan that turned `built` has nothing left to review: its panel closes by itself. */
export default function useCloseReviewWhenBuilt(plan: { id?: string | null; status?: string | null } | null | undefined, setReviewOpen: (open: boolean) => void): void {
    useAdjustOnChange([plan?.id, plan?.status], () => { if (plan?.status === 'built') setReviewOpen(false); });
}

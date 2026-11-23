/**
 * Cowork's plain prompt runs under the Privacy Shield (server/routes/coworkShieldSettings.js). Those runs call the
 * model directly, without an agent, so the shield applies to them only when the organisation switches it on; a new
 * organisation starts with it on.
 *
 * Saved at once, on its own: it is not part of the page's save bar, and it says so.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ToggleCard from './ToggleCard';
import { apiJson } from '@/api/typedRequest';
import type { TranslateFn } from '../tabs/checks/checksTypes';

interface ShieldFlag { enabled: boolean; configured: boolean }

const keyOf = (orgId: string) => ['cowork-shield', orgId] as const;

export default function CoworkShieldToggle({ orgId, readOnly = false, t }: { orgId: string; readOnly?: boolean; t: TranslateFn }) {
    const client = useQueryClient();
    const flag = useQuery<ShieldFlag, Error>({
        queryKey: keyOf(orgId),
        enabled: !!orgId,
        queryFn: () => apiJson<'GET /api/cowork/shield/{orgId}', ShieldFlag>('GET /api/cowork/shield/{orgId}', { params: { orgId } }),
        retry: false,
    });
    const save = useMutation<ShieldFlag, Error, boolean>({
        mutationFn: (enabled) => apiJson<'PUT /api/cowork/shield/{orgId}', ShieldFlag>('PUT /api/cowork/shield/{orgId}', { params: { orgId }, body: { enabled } }),
        onSuccess: (next) => { client.setQueryData(keyOf(orgId), next); },
    });
    if (!orgId || flag.isError || !flag.data) return null;
    return (
        <div className="rounded-[10px] border [border-color:var(--border-subtle)]" data-testid="cowork-shield-toggle">
            <ToggleCard
                title={t('cowork_shield.title', 'Also protect Cowork prompt runs')}
                description={t('cowork_shield.desc', 'Cowork work without an agent calls the AI directly, on a schedule, with nobody watching. With this on, it is checked the same way as chat. Saved at once.')}
                note={save.error ? t('cowork_shield.failed', 'That did not save. Try again.') : undefined}
                checked={flag.data.enabled}
                onChange={(next) => save.mutate(next)}
                disabled={readOnly || save.isPending}
            />
        </div>
    );
}

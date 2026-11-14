import { Info, Lock } from 'lucide-react';
import { useMemo } from 'react';
import { getIntegrationIcon } from '@/config/integrationIcons';
import { useTranslation } from '@/hooks/useTranslation';
import { apiUrl } from '@/api/typedRequest';
import { useGroupAccessRead } from '@/api/queries/orgAdminReads';
import { ACCESS_KIND_SECTIONS } from './accessTypes';
import type { AccessCapability, AccessData } from './accessTypes';
import { CapabilityGroup, CapabilityRow } from './AccessParts';
import Spinner from '@/components/shared/Spinner';
import { ALERT_ERROR, ALERT_INFO } from '@/components/mcpLibrary/ui';

/**
 * CeilingReadOnly — the org-admin view of the ceiling. The ceiling (what the
 * subscription plan on cloud / license tier on self-hosted permits) is not
 * editable by an org-admin, so this just lists what's inside it, grouped by
 * kind. Distribution within the ceiling happens in the Grants section.
 *
 * Reuses the existing group-access payload ({ ceiling, capabilities, mode }).
 */
export default function CeilingReadOnly({ orgId = null }: { orgId?: string | null }) {
    const { t } = useTranslation();
    const readPath = orgId
        ? apiUrl('GET /auth/organizations/{orgId}/group-access', { params: { orgId } })
        : apiUrl('GET /auth/me/group-access');

    const { data, error, loading } = useGroupAccessRead<AccessData>(
        readPath,
        (status) => t('admin_org.access_matrix_failed_load_status', 'Failed to load ({status})', { status }),
        t('admin_org.access_matrix_failed_load', 'Failed to load'),
    );

    const byKind = useMemo(() => {
        const ceiling = new Set(data?.ceiling || []);
        const map: Record<string, AccessCapability[]> = { core: [], beta: [], integration: [] };
        for (const c of (data?.capabilities || [])) {
            if (!ceiling.has(c.id)) continue;
            (map[c.kind] || (map[c.kind] = [])).push(c);
        }
        for (const k of Object.keys(map)) map[k].sort((a: AccessCapability, b: AccessCapability) => a.name.localeCompare(b.name));
        return map;
    }, [data]);

    if (loading) return <div className="p-6"><Spinner size="sm" /></div>;
    if (error) return <p className={ALERT_ERROR}>{error}</p>;

    const ceilingWord = data?.mode === 'cloud' ? t('admin_org.ceiling_word_plan_long', 'subscription plan') : t('admin_org.ceiling_word_licence', 'licence');

    return (
        <section className="flex flex-col gap-5">
            <p className={ALERT_INFO}>
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                    {t('admin_org.ceiling_ro_intro', 'These are the capabilities your organisation has access to (set by your administrator, within your {ceiling}). To distribute them to members or groups, use', { ceiling: ceilingWord })} <strong>{t('admin_org.ceiling_grants', 'Grants')}</strong>.
                </span>
            </p>

            {ACCESS_KIND_SECTIONS.map(section => {
                const caps = byKind[section.kind] || [];
                const SectionIcon = section.icon;
                return (
                    <CapabilityGroup key={section.kind} section={section} count={caps.length}>
                        {caps.length === 0 ? (
                            <p className="m-0 flex items-center gap-1.5 px-4 py-2.5 text-xs text-[var(--text-tertiary)]">
                                <Lock className="h-3 w-3" aria-hidden="true" /> {t('admin_org.ceiling_ro_none', 'Your organisation has no access in this category.')}
                            </p>
                        ) : caps.map(cap => (
                            <CapabilityRow key={cap.id} cap={cap} icon={cap.kind === 'integration' ? getIntegrationIcon(cap.id) : <SectionIcon className="h-4 w-4" />} />
                        ))}
                    </CapabilityGroup>
                );
            })}
        </section>
    );
}

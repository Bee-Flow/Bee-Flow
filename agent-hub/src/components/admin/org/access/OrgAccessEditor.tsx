import { Lock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getIntegrationIcon } from '@/config/integrationIcons';
import { useTranslation } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { ACCESS_KIND_SECTIONS } from './accessTypes';
import type { AccessCapability, AccessData, AccessMessage } from './accessTypes';
import { AccessStatus, CapabilityGroup, CapabilityRow } from './AccessParts';
import { ApiError } from '@/api/mutate';
import { apiRequest, apiUrl } from '@/api/typedRequest';
import { useAccessRead } from '@/api/queries/accessEditorRead';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Spinner from '@/components/shared/Spinner';
import Toggle from '@/components/shared/Toggle';

/**
 * OrgAccessEditor — the super-admin "Organisation access" menu: which
 * capabilities (within the plan/license ceiling) this organisation MAY use.
 * It is NOT a grant — it's the upper bound the org-admin distributes within.
 * Anything not allowed here shows locked in the org-admin's Grants matrix.
 *
 * `unrestricted` = the org may use everything its ceiling allows (the default).
 * Switch it off to pick a subset. Super-admin only.
 */

const SAVE_DEBOUNCE_MS = 450;

interface OrgAccessEditorProps {
    orgId: string;
    onChanged?: () => void;
}

export default function OrgAccessEditor({ orgId, onChanged }: OrgAccessEditorProps) {
    const { t } = useTranslation();
    const [available, setAvailable] = useState<Set<string>>(() => new Set());
    const [unrestricted, setUnrestricted] = useState(true);
    const [message, setMessage] = useState<AccessMessage | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const path = apiUrl('GET /auth/organizations/{orgId}/org-availability', { params: { orgId } });

    const { data = null, isFetching: loading, refetch } = useAccessRead<AccessData>('orgAvailability', path, setMessage);
    const load = useCallback(() => { void refetch(); }, [refetch]);

    // Every answer seeds the switches; a toggle then edits them until the next answer.
    const [seeded, setSeeded] = useState<AccessData | null>(null);
    if (data && data !== seeded) {
        setSeeded(data);
        setUnrestricted(!!data.unrestricted);
        setAvailable(new Set(data.unrestricted ? (data.ceiling || []) : (data.available || [])));
    }

    useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(null), 3000); return () => clearTimeout(timer); }, [message]);
    useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

    const ceiling = useMemo(() => (data?.ceiling || []), [data]);
    const capsByKind = useMemo(() => {
        const map: Record<string, AccessCapability[]> = { core: [], beta: [], integration: [] };
        for (const c of (data?.capabilities || [])) {
            if (!ceiling.includes(c.id)) continue; // only show what the plan/license allows
            (map[c.kind] || (map[c.kind] = [])).push(c);
        }
        for (const k of Object.keys(map)) map[k].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
        return map;
    }, [data, ceiling]);

    const save = (payload: { unrestricted: true } | { available: string[] }) => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
            try {
                try {
                    await apiRequest('PUT /auth/organizations/{orgId}/org-availability', { params: { orgId }, body: payload });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error(t('admin_org.access_matrix_save_failed', 'Save failed'));
                }
                setMessage({ type: 'ok', text: t('admin_org.access_matrix_saved', 'Saved') });
                onChanged?.();
            } catch (e) { setMessage({ type: 'error', text: messageOf(e, t('admin_org.access_matrix_save_failed', 'Save failed')) }); load(); }
        }, SAVE_DEBOUNCE_MS);
    };

    const setUnrestrictedMode = (val: boolean) => {
        setUnrestricted(val);
        if (val) {
            setAvailable(new Set(ceiling));
            save({ unrestricted: true });
        } else {
            // Switch to a subset starting from everything currently allowed (no-op
            // until the super-admin removes some), so nothing is lost on toggle.
            const next = new Set(ceiling);
            setAvailable(next);
            save({ available: [...next] });
        }
    };

    const toggle = (capId: string) => {
        if (unrestricted) return;
        setAvailable(prev => {
            const n = new Set(prev);
            n.has(capId) ? n.delete(capId) : n.add(capId);
            save({ available: [...n] });
            return n;
        });
    };

    if (loading) return <div className="p-4"><Spinner size="sm" /></div>;
    if (!data) return null;

    const cloud = data.mode === 'cloud';
    const allowAllLabel = t('admin_org.ceiling_allow_all', 'Allow everything the {ceiling} permits', { ceiling: cloud ? t('admin_org.ceiling_word_plan', 'plan') : t('admin_org.ceiling_word_licence', 'licence') });
    return (
        <SettingsGroup
            title={t('admin_org.ceiling_org_access_title', 'Organisation access')}
            description={t('admin_org.ceiling_org_access_intro', "Which capabilities this organisation may use, within your {ceiling}. Org-admins can only distribute what's allowed here: everything else is locked for them.", { ceiling: cloud ? t('admin_org.ceiling_word_plan_long', 'subscription plan') : t('admin_org.ceiling_word_licence', 'licence') })}
            actions={<AccessStatus message={message} />}
        >
            <SettingsList>
                <SettingRow
                    label={allowAllLabel}
                    hint={t('admin_org.ceiling_allow_all_hint', 'Turn off to restrict this organisation to a subset.')}
                >
                    <div className="flex @[40rem]/srow:justify-end">
                        <Toggle size="sm" checked={unrestricted} onChange={setUnrestrictedMode} ariaLabel={allowAllLabel} />
                    </div>
                </SettingRow>
            </SettingsList>

            {ACCESS_KIND_SECTIONS.map(section => {
                const caps = capsByKind[section.kind] || [];
                if (caps.length === 0) return null;
                const SectionIcon = section.icon;
                return (
                    <CapabilityGroup key={section.kind} section={section} dimmed={unrestricted}>
                        {caps.map(cap => (
                            <CapabilityRow
                                key={cap.id}
                                cap={cap}
                                icon={cap.kind === 'integration' ? getIntegrationIcon(cap.id) : <SectionIcon className="h-4 w-4" />}
                                onActivate={unrestricted ? undefined : () => toggle(cap.id)}
                                trailing={unrestricted
                                    ? <Lock className="h-4 w-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                                    : <Toggle size="sm" checked={available.has(cap.id)} ariaLabel={cap.name} onChange={() => toggle(cap.id)} />}
                            />
                        ))}
                    </CapabilityGroup>
                );
            })}
        </SettingsGroup>
    );
}

import { Users, Lock } from 'lucide-react';
import Toggle from '@/components/shared/Toggle';
import { SECTION_IDS } from '../useLookForm';
import type { LookForm, LookSectionProps } from '../useLookForm';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * AccessSection — per-user override toggle. The Look is ONE theme for the
 * whole server (brandingStore.getOrgDefault takes no organisation), so the
 * copy says so: a platform admin on a server with several organisations must
 * not think they are changing one of them. When off, everyone sees this theme
 * exactly as set and the Settings → Appearance theme picker hides itself.
 */
export default function AccessSection({ form, setForm, saving }: LookSectionProps) {
    const { t } = useTranslation();
    const allow = !!form.allowUserOverride;
    return (
        <section
            id={SECTION_IDS.access}
            aria-labelledby={`${SECTION_IDS.access}-heading`}
        >
            <h3
                id={`${SECTION_IDS.access}-heading`}
                className="text-base font-semibold mb-1 text-[var(--text-primary)]"
            >
                {t('appearance.access_member_access', 'Member access')}
            </h3>
            <p className="text-xs mb-4 text-[var(--text-muted)]">
                {t('appearance.access_control_whether_individual_members_can', 'This theme applies to everyone on this server. Choose whether people may pick their own theme on their own device.')}
            </p>
            <div
                className="rounded-xl border p-4 flex items-center gap-3 border-[var(--border-subtle)] bg-[var(--bg-card)]"
            >
                <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${allow ? 'bg-[var(--item-active-bg)] text-[var(--text-primary)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}
                >
                    {allow ? <Users className="w-4 h-4" aria-hidden="true" /> : <Lock className="w-4 h-4" aria-hidden="true" />}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                        {t('appearance.access_allow_members_to_pick_their_own_theme', 'Allow members to pick their own theme')}
                    </p>
                    <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">
                        {allow
                            ? t('platform_panels.access_on', 'People see a theme switcher in the sidebar and a section in their settings.')
                            : t('platform_panels.access_off', 'Everyone sees the theme for this server, whatever they picked on their own device.')}
                    </p>
                </div>
                <Toggle
                    checked={allow}
                    onChange={(next: boolean) => setForm((f: LookForm | null) => ({ ...(f as LookForm), allowUserOverride: next }))}
                    disabled={saving}
                    ariaLabel={t('appearance.access_allow_members_to_pick_their_own_theme', 'Allow members to pick their own theme')}
                />
            </div>
        </section>
    );
}

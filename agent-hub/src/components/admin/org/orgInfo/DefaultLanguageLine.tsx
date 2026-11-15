import { ArrowRight } from 'lucide-react';
import { useOrgDefaultLanguage } from '@/api/queries/orgAdminReads';
import { QUIET_BTN } from '@/components/shared/adminUi';
import type { TranslateFn } from '@/hooks/useTranslation';
import { navigate } from '@/router/history';

/** The Languages row of the admin dashboard, where the default is set. */
const LANGUAGES_PATH = '/app/admin/languages';

interface DefaultLanguageLineProps {
    t: TranslateFn;
    /** A platform administrator: may change it, under Languages. */
    isPlatformAdmin: boolean;
}

/**
 * The default language for new users, read only. It is ONE value for the
 * whole server (`org_default_locale`), so its control lives in the
 * whole-server Languages row; Organisation info only says what it is, and
 * points a platform administrator to where it changes. Nothing to say on a
 * server with one language, so the divider above it is its own: no stray
 * line closes the page then.
 */
export default function DefaultLanguageLine({ t, isPlatformAdmin }: DefaultLanguageLineProps) {
    const { data: loaded, loading } = useOrgDefaultLanguage();
    const locales = loaded?.locales ?? [];
    if (loading || locales.length <= 1) return null;
    const code = loaded?.defaultLocale ?? 'en';
    const name = locales.find(l => l.code === code)?.name || code;
    return (
        <div className="space-y-2 border-t border-[var(--border-subtle)] pt-8" data-testid="org-default-language">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin_org_rows.default_language_title')}</h3>
            <p className="text-sm text-[var(--text-primary)]">{name}</p>
            <p className="text-xs text-[var(--text-muted)]">
                {isPlatformAdmin
                    ? t('admin_org_rows.default_language_server_wide')
                    : t('org.default_language_platform_only', 'This applies to the whole server. Only a platform administrator can change it.')}
            </p>
            {isPlatformAdmin && (
                <button type="button" className={QUIET_BTN} onClick={() => navigate(LANGUAGES_PATH)}>
                    {t('admin_org_rows.default_language_change')}
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

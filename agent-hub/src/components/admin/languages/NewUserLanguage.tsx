import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOrgDefaultLanguage } from '@/api/queries/orgAdminReads';
import { apiRequest } from '@/api/typedRequest';
import { useTranslation } from '@/hooks/useTranslation';
import SaveStatus from '@/components/shared/SaveStatus';

/** The read the Organisation info page shares (useOrgDefaultLanguage). */
const DEFAULT_LANGUAGE_KEY = ['orgAdmin', 'defaultLanguage'] as const;

interface LocaleOption {
    code: string;
    name: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * The language a new account starts in. ONE value for the whole server
 * (`org_default_locale`, PUT /api/languages/org/default, platform admins only),
 * so it lives on the whole-server Languages page and not on an organisation's
 * page. A pick saves at once, and SaveStatus says whether it was stored; a
 * refused pick puts the select back on what the server holds.
 *
 * `locales` are the installed languages as the Languages page lists them, so a
 * language added or removed there is offered here at once.
 */
export default function NewUserLanguage({ locales }: { locales: readonly LocaleOption[] }) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { data: loaded, loading } = useOrgDefaultLanguage();
    const [picked, setPicked] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const selectId = useId();
    const current = picked ?? loaded?.defaultLocale ?? 'en';

    const save = async (code: string) => {
        const previous = current;
        setPicked(code);
        setSaveState('saving');
        try {
            await apiRequest('PUT /api/languages/org/default', { body: { defaultLocale: code } });
            queryClient.setQueryData(DEFAULT_LANGUAGE_KEY, (prev: { defaultLocale?: string; locales?: LocaleOption[] } | null | undefined) => ({ ...(prev ?? {}), defaultLocale: code }));
            setSavedAt(new Date());
            setSaveState('saved');
        } catch {
            setPicked(previous);
            setSaveState('error');
        }
    };

    if (loading || locales.length <= 1) return null;

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 border-b border-[var(--border-subtle)]" data-testid="new-user-language">
            <label htmlFor={selectId} className="text-[13px] font-medium text-[var(--text-primary)]">
                {t('platform_panels.new_user_language', 'New users start in')}
            </label>
            <select
                id={selectId}
                aria-describedby={`${selectId}-hint`}
                value={current}
                onChange={e => { void save(e.target.value); }}
                disabled={saveState === 'saving'}
                className="min-w-[180px] px-2.5 py-1.5 rounded-lg border text-[13px] outline-none bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] disabled:opacity-60"
            >
                {locales.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
            <SaveStatus saveState={saveState} lastSavedAt={savedAt} />
            <p id={`${selectId}-hint`} className="basis-full m-0 text-[11.5px] text-[var(--text-tertiary)]">
                {t('platform_panels.new_user_language_hint', 'The language a new account starts in, for everyone on this server. People can change their own language afterwards.')}
            </p>
        </div>
    );
}

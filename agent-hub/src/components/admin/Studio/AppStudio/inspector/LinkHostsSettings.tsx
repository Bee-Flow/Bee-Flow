import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { SectionTitle } from './AiBrowsingSettings';
import { parseLinkHosts } from '../state/linkHostOps';

interface LinkHostsSettingsProps {
    /** `definition.allowedLinkHosts`. */
    value: unknown;
    onCommit: (hosts: string[]) => void;
    disabled?: boolean;
}

/**
 * The web hosts an "open a web page" step may open when it builds its address with a formula. The owner's
 * list: the app builder cannot write it, because a list the builder could grow would be no list at all.
 */
export function LinkHostsSettings({ value, onCommit, disabled }: LinkHostsSettingsProps) {
    const { t } = useTranslation();
    const hosts: string[] = Array.isArray(value) ? value.filter((h): h is string => typeof h === 'string') : [];
    const hostsText = hosts.join('\n');
    const [draft, setDraft] = React.useState(hostsText);
    const [refused, setRefused] = React.useState<string[]>([]);
    // Re-sync when the definition changes underneath (undo, another surface).
    useAdjustOnChange([hostsText], () => setDraft(hostsText));

    const commit = () => {
        const parsed = parseLinkHosts(draft);
        setRefused(parsed.refused);
        onCommit(parsed.hosts);
    };

    return (
        <div data-link-hosts-settings="true">
            <SectionTitle>{t('studio_apps_dynamic_text.hosts_title', 'Links from formulas')}</SectionTitle>
            <FormField
                label={t('studio_apps_dynamic_text.hosts_label', 'Hosts a link may open')}
                hint={t('studio_apps_dynamic_text.hosts_hint', 'One host per line, for example example.com. An “open a web page” step that builds its address with a formula only opens https addresses on these hosts. Only you can change this list, the app builder cannot.')}
            >
                <textarea
                    className="w-full rounded-lg text-sm p-2 outline-none focus:ring-2 bg-[var(--bg-primary)] border border-[var(--border-default)] text-[var(--text-primary)] focus:ring-[var(--accent-primary)]"
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    placeholder={'example.com'}
                    disabled={disabled}
                    spellCheck={false}
                    aria-label={t('studio_apps_dynamic_text.hosts_label', 'Hosts a link may open')}
                />
            </FormField>
            {refused.length ? (
                <p className="mt-1 text-[11px] text-[var(--error)]" role="status">
                    {t('studio_apps_dynamic_text.hosts_refused', 'Left out: {hosts}. Write only the host name, for example example.com.', { hosts: refused.join(', ') })}
                </p>
            ) : null}
        </div>
    );
}

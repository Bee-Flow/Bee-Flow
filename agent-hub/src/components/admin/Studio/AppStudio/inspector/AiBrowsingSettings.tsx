import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import type { SectionTitleProps, AiBrowsingSettingsProps } from './ThemePanel.types';

export function SectionTitle({ children }: SectionTitleProps) {
    return (
        <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{children}</span>
            <div className="flex-1 h-px bg-[var(--border-subtle)]" />
        </div>
    );
}

export function AiBrowsingSettings({ value, onCommit, disabled }: AiBrowsingSettingsProps) {
    const { t } = useTranslation();
    const enabled = value?.enabled === true;
    const domains: string[] = Array.isArray(value?.allowedDomains) ? value.allowedDomains : [];
    const [draft, setDraft] = React.useState(domains.join('\n'));
    // Re-sync when the definition changes underneath (undo, another surface).
    React.useEffect(() => { setDraft(domains.join('\n')); }, [domains.join('\n')]);

    const commitDomains = () => {
        const list = draft
            .split(/[\n,]/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);
        onCommit({ allowedDomains: list });
    };

    return (
        <div>
            <SectionTitle>{t('studio_apps_insp.theme.ai_browsing', 'AI browsing')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <Toggle
                    label={t('studio_apps_insp.theme.ai_browsing_toggle', 'Let this app browse the web')}
                    checked={enabled}
                    onChange={(v) => onCommit({ enabled: v })}
                    disabled={disabled}
                    size="sm"
                />
                <p className="text-xs text-[var(--text-muted)]">
                    {t('studio_apps_insp.theme.ai_browsing_explainer', 'An AI browsing step opens a real browser as you, and viewers watch it work. Only you can switch this on — the app builder cannot. Your organisation can revoke it at any time by turning off the Browse Web integration.')}
                </p>
                {enabled ? (
                    <FormField
                        label={t('studio_apps_insp.theme.sites_label', 'Sites it may open')}
                        hint={t('studio_apps_insp.theme.sites_hint', 'One per line. Subdomains are included. Leave empty to allow any public site — rarely what you want.')}
                    >
                        <textarea
                            className="w-full rounded-lg text-sm p-2 outline-none focus:ring-2"
                            style={{
                                background: 'var(--bg-primary)',
                                border: '1px solid var(--border-default)',
                                color: 'var(--text-primary)',
                                '--tw-ring-color': 'var(--accent-primary)',
                            } as React.CSSProperties}
                            rows={4}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commitDomains}
                            placeholder={'nhs.uk\nwho.int'}
                            disabled={disabled}
                            aria-label={t('studio_apps_insp.theme.sites_label', 'Sites it may open')}
                        />
                    </FormField>
                ) : null}
            </div>
        </div>
    );
}

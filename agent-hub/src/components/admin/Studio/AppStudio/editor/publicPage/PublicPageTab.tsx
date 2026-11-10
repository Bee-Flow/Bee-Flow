import type { ReactNode } from 'react';
import Toggle from '@/components/shared/Toggle';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppDefinition } from '../../inspector/appDefinition';
import { PRIVATE } from '../publishAccessSummary';
import { openPublicAccess, readPublicAccess, withPublicAccess } from './publicPageModel';
import type { PublicAccess } from './publicPageModel';
import PublicPageReach from './PublicPageReach';
import { EntryAndTitle, LookOverride, ScreenPicker } from './PublicPageSettings';
import PublicPageUrls from './PublicPageUrls';

/**
 * The publish modal's "Public page" tab: a bounded part of the app that
 * anyone with a link may open without an account (server
 * appStudio/publicAccess.js). The settings are the definition's
 * `publicAccess` block and go through the editor's own commit and autosave
 * like every other edit; the URLs are the public-pages routes.
 *
 * Visitors are served the PUBLISHED copy, so a change here goes live with the
 * next Apply, which the tab says. A Solution stage that manages the app keeps
 * the settings read-only (its draft is not this editor's to change) but
 * leaves the URLs to the owner, as the server does.
 */

export interface PublicPageTabProps {
    appId: string;
    definition: AppDefinition | null;
    /** The editor's commit; absent (or `readOnly`) keeps the settings read-only. */
    onCommit?: (next: AppDefinition) => void;
    readOnly?: boolean;
    /** The audience chosen on the other tab, for the Private warning. */
    audience: string;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{title}</h3>
            {children}
        </section>
    );
}

function Intro({ t, on, disabled, onToggle }: { t: TranslateFn; on: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
    return (
        <Toggle
            checked={on}
            onChange={onToggle}
            disabled={disabled}
            label={t('studio_apps_public.toggle.label', 'Open a public page')}
            description={on
                ? t('studio_apps_public.toggle.on', 'Turning it off closes the page to visitors once you publish again. Existing links stay listed until you revoke them.')
                : t('studio_apps_public.toggle.off', 'Let anyone with a link open a few screens of this app without an account, for example an intake form. The rest of the app stays private.')}
        />
    );
}

export default function PublicPageTab({ appId, definition, onCommit, readOnly = false, audience }: PublicPageTabProps) {
    const { t } = useTranslation();
    const pa = readPublicAccess(definition);
    const screens = definition?.screens || [];
    const disabled = readOnly || !onCommit || !definition;
    const commit = (next: PublicAccess | null) => {
        if (!definition || !onCommit) return;
        const updated = withPublicAccess(definition, next);
        if (updated !== definition) onCommit(updated);
    };
    const settings = pa ? { t, pa, screens, disabled, onChange: commit } : null;
    return (
        <div className="space-y-4" data-testid="public-page-tab">
            <Intro t={t} on={!!pa} disabled={disabled || screens.length === 0} onToggle={(on) => commit(on ? openPublicAccess(definition) : null)} />
            {readOnly ? <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_public.managed', 'A Solution stage manages this app, so its screens and look change only with a deploy. The links below are still yours to manage.')}</p> : null}
            {audience === PRIVATE && pa ? (
                <p className="text-xs [color:#b45309]">{t('studio_apps_public.private_warning', 'The audience is set to Private. Applying that unpublishes the app, and the public page closes with it.')}</p>
            ) : null}
            {settings && definition ? (
                <>
                    <Section title={t('studio_apps_public.section.screens', 'Screens')}>
                        <ScreenPicker {...settings} />
                        <EntryAndTitle {...settings} />
                    </Section>
                    <Section title={t('studio_apps_public.section.look', 'Look')}>
                        <LookOverride {...settings} appId={appId} definition={definition} />
                    </Section>
                    <Section title={t('studio_apps_public.section.reach', 'What a visitor can reach')}>
                        <PublicPageReach t={t} appId={appId} definition={definition} pa={settings.pa} />
                    </Section>
                    {disabled ? null : <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_public.goes_live', 'Changes here are saved with the draft. Visitors see them after you press Apply.')}</p>}
                </>
            ) : null}
            <Section title={t('studio_apps_public.section.urls', 'Links')}>
                <PublicPageUrls t={t} appId={appId} hasDraftBlock={!!pa} />
            </Section>
        </div>
    );
}

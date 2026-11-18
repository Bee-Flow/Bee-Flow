import type React from 'react';
import useTranslation from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import { SectionTitle } from './AiBrowsingSettings';
import { aiCapabilityUsage } from './aiCapabilityUsage';
import { aiCapabilitiesApi, useAiCapabilities } from '../editor/aiCapabilitiesApi';
import type { AiCapabilities, AiCapabilitiesApi } from '../editor/aiCapabilitiesApi';
import type { AppDefinition } from './appDefinition';

/**
 * "What the AI can do", in App settings: what the AI steps of this app can reach, what they
 * cannot, and the owner's web-search switch (aiWebSearch, which the builder cannot write).
 *
 * The app's own switches and what its steps use come from the definition; whether the workspace
 * allows the integration and whether the server has a search service or a browser comes from
 * GET /api/studio-apps/:id/ai-capabilities, the same checks the steps make when they run.
 */

type Tone = 'ok' | 'off' | 'neutral';
type Status = { tone: Tone; text: string };

export interface AiCapabilitiesPanelProps {
    definition: AppDefinition;
    appId: string | null;
    onWebSearchChange: (enabled: boolean) => void;
    disabled: boolean;
    api?: AiCapabilitiesApi;
}

const TONE_CLASS: Record<Tone, string> = {
    ok: 'text-[var(--success-ink)] bg-[color-mix(in_srgb,var(--success)_14%,transparent)]',
    off: 'text-[var(--warning-ink)] bg-[color-mix(in_srgb,var(--warning)_14%,transparent)]',
    neutral: 'text-[var(--text-muted)] bg-[var(--bg-tertiary)]',
};

function StatusChip({ status }: { status: Status }) {
    return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[status.tone]}`}>{status.text}</span>;
}

function Row({ label, detail, status, children }: { label: string; detail: string; status: Status; children?: React.ReactNode }) {
    return (
        <li className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-subtle)] p-2.5">
            <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
                <StatusChip status={status} />
            </div>
            <p className="text-xs text-[var(--text-muted)]">{detail}</p>
            {children}
        </li>
    );
}

type T = ReturnType<typeof useTranslation>['t'];

/** The run-time status of a gated capability: the app switch first, then the workspace, then the server. */
function gatedStatus(t: T, appOn: boolean, caps: { allowed: boolean; present: boolean } | null, state: 'pending' | 'error' | 'ready', missing: string): Status {
    if (!appOn) return { tone: 'off', text: t('studio_ai_caps.status.off_app', 'Off for this app') };
    if (state === 'pending') return { tone: 'neutral', text: t('studio_ai_caps.status.checking', 'Checking…') };
    if (state === 'error' || !caps) return { tone: 'neutral', text: t('studio_ai_caps.status.unknown', 'Could not check') };
    if (!caps.allowed) return { tone: 'off', text: t('studio_ai_caps.status.off_workspace', 'Off in your workspace') };
    if (!caps.present) return { tone: 'off', text: missing };
    return { tone: 'ok', text: t('studio_ai_caps.status.available', 'Available') };
}

function queryState(q: { isPending: boolean; isError: boolean; data?: AiCapabilities }): 'pending' | 'error' | 'ready' {
    if (q.isError) return 'error';
    return q.data ? 'ready' : 'pending';
}

type Checked = { caps: AiCapabilities | null; state: 'pending' | 'error' | 'ready' };
type BodyProps = Omit<AiCapabilitiesPanelProps, 'appId' | 'api'> & Checked;

/** In the editor: asks the server for the run-time facts of this app. */
function CheckedPanel({ appId, api, ...rest }: Omit<AiCapabilitiesPanelProps, 'appId'> & { appId: string; api: AiCapabilitiesApi }) {
    const query = useAiCapabilities(api, appId);
    return <PanelBody {...rest} caps={query.data ?? null} state={queryState(query)} />;
}

export function AiCapabilitiesPanel({ appId, api = aiCapabilitiesApi, ...rest }: AiCapabilitiesPanelProps) {
    // Outside the editor shell there is no app to ask about: the app switches and usage still show.
    if (!appId) return <PanelBody {...rest} caps={null} state="error" />;
    return <CheckedPanel {...rest} appId={appId} api={api} />;
}

function PanelBody({ definition, onWebSearchChange, disabled, caps, state }: BodyProps) {
    const { t } = useTranslation();
    const usage = aiCapabilityUsage(definition);
    const webOn = definition?.aiWebSearch?.enabled === true;
    const browseOn = (definition?.aiBrowsing as { enabled?: unknown } | undefined)?.enabled === true;

    const webStatus = gatedStatus(t, webOn, caps && { allowed: caps.webSearch.integrationAllowed, present: caps.webSearch.providerAvailable }, state,
        t('studio_ai_caps.status.no_provider', 'No search service on this server'));
    const browseStatus = gatedStatus(t, browseOn, caps && { allowed: caps.browsing.integrationAllowed, present: caps.browsing.backendAvailable }, state,
        t('studio_ai_caps.status.no_browser', 'No browser on this server'));
    const always: Status = { tone: 'ok', text: t('studio_ai_caps.status.always', 'Always') };
    const perStep: Status = { tone: 'neutral', text: t('studio_ai_caps.status.per_step', 'Per step') };

    return (
        <div>
            <SectionTitle>{t('studio_ai_caps.title', 'What the AI can do')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <p className="text-xs text-[var(--text-muted)]">
                    {t('studio_ai_caps.intro', 'The AI steps in this app run as you, the owner. They only reach what is listed here, and only when a step asks for it.')}
                </p>
                <span className="text-xs font-semibold text-[var(--text-secondary)]">{t('studio_ai_caps.can_heading', 'It can use')}</span>
                <ul className="flex flex-col gap-2" aria-label={t('studio_ai_caps.can_heading', 'It can use')}>
                    <Row label={t('studio_ai_caps.app_data.label', "This app's tables and files")}
                        detail={t('studio_ai_caps.app_data.detail', 'The records, uploads and documents a step points it at.')} status={always} />
                    <Row label={t('studio_ai_caps.knowledge.label', 'Knowledge bases')}
                        detail={t('studio_ai_caps.knowledge.detail', 'Only the knowledge bases chosen in a step. Chosen now: {count}.', { count: usage.knowledgeBases })} status={perStep} />
                    <Row label={t('studio_ai_caps.web_search.label', 'Web search')}
                        detail={t('studio_ai_caps.web_search.detail', 'Searches the web and reads public pages, in AI steps that ask for it. Steps that ask now: {count}. The search words go to the search service, so they can contain data from this app.', { count: usage.webSearchSteps })}
                        status={webStatus}>
                        <Toggle
                            label={t('studio_ai_caps.web_search.toggle', 'Let the AI steps of this app search the web')}
                            checked={webOn}
                            onChange={(v) => onWebSearchChange(v)}
                            disabled={disabled}
                            size="sm"
                        />
                        <p className="text-xs text-[var(--text-muted)]">
                            {t('studio_ai_caps.web_search.builder_note', 'Only you can switch this on: the AI that builds the app has no way to. Your organisation can turn it off at any time with the Web Search integration.')}
                        </p>
                    </Row>
                    <Row label={t('studio_ai_caps.browsing.label', 'Web browsing')}
                        detail={t('studio_ai_caps.browsing.detail', 'Opens a real browser as you while a viewer watches. Browsing steps now: {count}. Set it up under AI browsing below.', { count: usage.browseSteps })}
                        status={browseStatus} />
                    <Row label={t('studio_ai_caps.automations.label', 'Automations')}
                        detail={t('studio_ai_caps.automations.detail', 'Automations this app starts: {count}. They use their own connections, such as mail, Nextcloud or a calendar.', { count: usage.automations })}
                        status={perStep} />
                </ul>
                <span className="text-xs font-semibold text-[var(--text-secondary)]">{t('studio_ai_caps.cannot_heading', 'It cannot')}</span>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-[var(--text-muted)]" aria-label={t('studio_ai_caps.cannot_heading', 'It cannot')}>
                    <li>{t('studio_ai_caps.cannot.connections', 'Use your other connections (mail, Nextcloud, calendars, CRM) directly. Only through an automation step you add.')}</li>
                    <li>{t('studio_ai_caps.cannot.act_alone', 'Send e-mail or change records on its own. Only the steps you place in an action do that.')}</li>
                    <li>{t('studio_ai_caps.cannot.settings', 'Change the app or these settings. The AI that builds the app has no way to switch on web search or browsing either.')}</li>
                    <li>{t('studio_ai_caps.cannot.unattended_browse', 'Browse in background jobs or mailbox hooks. Browsing only runs while someone watches.')}</li>
                </ul>
            </div>
        </div>
    );
}

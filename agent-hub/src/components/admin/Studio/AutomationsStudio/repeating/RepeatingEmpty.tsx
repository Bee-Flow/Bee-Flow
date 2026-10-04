import { Clock, Lightbulb, Plug } from 'lucide-react';
import type { ReactNode } from 'react';
import { settingsPathForTab } from '../../../../../authedApp/settingsRoutes';
import { useTranslation } from '../../../../../hooks/useTranslation';

export type EmptyKind = 'no_connected' | 'no_sources' | 'not_enough_history' | 'nothing';

/** The empty state a finished scan's `reason` asks for. */
export function emptyKindFor(reason: string | null): EmptyKind {
    if (reason === 'no_sources' || reason === 'no_integrations') return 'no_sources';
    if (reason === 'not_enough_history') return 'not_enough_history';
    return 'nothing';
}

const LINK = 'self-start mt-2 text-[12px] font-medium text-[var(--accent-primary)] hover:underline disabled:opacity-50 disabled:no-underline';

/** A quiet dashed note: icon, title, a sentence or two, and the next step. */
function Note({ icon, title, body, next, testId }: { icon: ReactNode; title: string; body: string[]; next?: ReactNode; testId: string }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--bg-card)]" data-testid={testId}>
            <span className="mt-0.5 shrink-0 text-[var(--text-tertiary)]">{icon}</span>
            <div className="min-w-0 flex-1 flex flex-col">
                <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
                {body.map(p => <p key={p} className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">{p}</p>)}
                {next}
            </div>
        </div>
    );
}

/**
 * Why there is nothing to show, and what to do next: connect an app, switch
 * a source on, come back when there is more history, or ask for ideas.
 */
export default function RepeatingEmpty({ kind, looked = '', onSuggestIdeas, ideasBusy = false }: {
    kind: EmptyKind;
    /** The sources the scan read, by name. */
    looked?: string;
    /** Offered only when the scan found nothing (or too little history). */
    onSuggestIdeas?: () => void;
    ideasBusy?: boolean;
}) {
    const { t } = useTranslation();
    const ideas = onSuggestIdeas && (
        <button type="button" className={LINK} onClick={onSuggestIdeas} disabled={ideasBusy}>
            {t('automations.repeating.ideasLink', 'Suggest ideas instead')}
        </button>
    );
    const connect = (
        <a href={settingsPathForTab('integrations')} className={LINK}>
            {t('automations.repeating.connectApps', 'Connect an app')}
        </a>
    );
    switch (kind) {
        case 'no_connected':
            return <Note testId="repeating-no-apps" icon={<Plug size={16} aria-hidden="true" />} next={connect}
                title={t('automations.repeating.noAppsTitle', 'Nothing to scan yet')}
                body={[t('automations.repeating.noAppsBody', 'Connect an app first. Bee can only look at apps you have connected.')]} />;
        case 'no_sources':
            return <Note testId="repeating-empty" icon={<Plug size={16} aria-hidden="true" />} next={connect}
                title={t('automations.repeating.noSourcesTitle', 'No sources to read')}
                body={[t('automations.repeating.noSourcesBody', 'Switch on at least one source above, or connect an app first.')]} />;
        case 'not_enough_history':
            return <Note testId="repeating-empty" icon={<Clock size={16} aria-hidden="true" />} next={ideas}
                title={t('automations.repeating.historyTitle', 'Not enough history yet')}
                body={[t('automations.repeating.historyBody', 'Bee needs a few weeks of your own activity to tell what repeats. Scan again in a week or two.')]} />;
        default:
            return <Note testId="repeating-empty" icon={<Lightbulb size={16} aria-hidden="true" />} next={ideas}
                title={t('automations.repeating.emptyTitle', 'No repeating work spotted')}
                body={[
                    looked
                        ? t('automations.repeating.emptyWhy', 'Bee read {apps} but found nothing that repeats often enough to automate.', { apps: looked })
                        : t('automations.repeating.emptyWhyGeneric', 'Bee found nothing that repeats often enough to automate.'),
                    t('automations.repeating.emptyTry', 'Try more apps, name a focus such as invoices or support tickets, or scan again in a week or two.'),
                ]} />;
    }
}

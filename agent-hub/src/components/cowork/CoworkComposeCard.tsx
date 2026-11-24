/**
 * The one confirmation before a new cowork exists (./useCoworkComposer.ts with `confirm`): what the composer worked
 * out of the brief, as one plain card. The same sentence the item's Overview will show (./coworkOverviewModel.ts), the
 * apps it will use, what holds, and two buttons: Start creates it; Change puts it back into the composer's chips, the
 * detailed editing, to adjust and send again.
 *
 * The defaults stay the server's: a plan it is later given asks before sending, and its budget is set under Edit.
 */
import { CheckCircle2, LayoutGrid } from 'lucide-react';
import { overviewSentence } from './coworkOverviewModel';
import type { OverviewFacts } from './coworkOverviewModel';
import useCoworkApps from './useCoworkApps';
import type { CoworkDraft, UseCoworkComposerReturn } from './useCoworkComposer';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The draft read as an item, for the same sentence as its Overview. */
function draftFacts({ payload }: CoworkDraft, agentName: string | null): OverviewFacts {
    const event = 'triggerKind' in payload && payload.triggerKind === 'app_event';
    return {
        item: {
            title: payload.title,
            prompt: payload.prompt,
            isActive: true,
            repeatInterval: payload.repeatInterval,
            daysOfWeek: 'daysOfWeek' in payload ? payload.daysOfWeek ?? null : null,
            timeOfDay: 'timeOfDay' in payload ? payload.timeOfDay ?? null : null,
            nextRunAt: 'nextRunAt' in payload ? payload.nextRunAt : null,
            lastStatus: null,
            enabledApps: payload.enabledApps ?? null,
            triggerKind: event ? 'app_event' : 'schedule',
            trigger: event ? payload.trigger : null,
        },
        plan: null,
        sends: null,
        level: null,
        agentName,
        startsNow: 'startNow' in payload && !!payload.startNow,
    };
}

/** "It uses Outlook and Planner.", or what it can say when it cannot name them. */
function AppsLine({ enabledApps, t }: { enabledApps: string[] | null; t: TranslateFn }) {
    const { availableApps, isAppEnabled, appsKnown } = useCoworkApps({ value: enabledApps });
    const names = availableApps.filter((a) => !a.isStep && isAppEnabled(a.id)).map((a) => a.label);
    let text: string;
    if (Array.isArray(enabledApps) && enabledApps.length === 0) text = t('cowork_overview.compose.no_apps', 'It uses no apps.');
    else if (names.length > 0) text = t('cowork_overview.compose.apps', 'It may use {apps}.', { apps: names.join(', ') });
    else text = appsKnown ? t('cowork_overview.compose.no_apps', 'It uses no apps.') : t('cowork_overview.compose.workspace_apps', 'It may use the apps of your workspace.');
    return (
        <p className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)]" data-testid="cowork-compose-apps">
            <LayoutGrid aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />
            {text}
        </p>
    );
}

export default function CoworkComposeCard({ cowork }: { cowork: UseCoworkComposerReturn }) {
    const { t } = useTranslation();
    const draft = cowork.draft;
    if (!draft) return null;
    const agentName = draft.payload.agentId ? cowork.agents.find((a) => a.id === draft.payload.agentId)?.name ?? null : null;
    return (
        <section
            className="mt-3 rounded-xl border px-4 py-3.5 flex flex-col gap-2.5 [background:var(--bg-card)] [border-color:var(--border-default)] [box-shadow:var(--shadow-sm)]"
            data-testid="cowork-compose-card"
            aria-label={t('cowork_overview.compose.heading', 'Start this cowork?')}
        >
            <h3 className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                <CheckCircle2 aria-hidden="true" className="w-4 h-4 text-[var(--text-tertiary)]" />
                {draft.payload.title || t('cowork_overview.compose.heading', 'Start this cowork?')}
            </h3>
            <p className="text-[13px] leading-[20px] text-[var(--text-primary)]" data-testid="cowork-compose-sentence">
                {overviewSentence(draftFacts(draft, agentName), t)}
            </p>
            <AppsLine enabledApps={draft.payload.enabledApps ?? null} t={t} />
            <div className="flex flex-wrap gap-2 pt-0.5">
                <button
                    type="button"
                    data-testid="cowork-compose-start"
                    disabled={cowork.submitting}
                    onClick={() => { void cowork.start(); }}
                    className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold disabled:opacity-50 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)] hover:bg-[var(--button-primary-hover)]"
                >
                    {cowork.submitting ? t('cowork.composer.starting', 'Starting…') : t('cowork_overview.compose.start', 'Start')}
                </button>
                <button
                    type="button"
                    data-testid="cowork-compose-change"
                    disabled={cowork.submitting}
                    onClick={cowork.change}
                    className="px-3.5 py-1.5 rounded-lg border text-[12.5px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                >
                    {t('cowork_overview.compose.change', 'Change')}
                </button>
            </div>
        </section>
    );
}

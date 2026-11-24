// The words of Cowork's home (./CoworkHome.tsx, ./CoworkRow.tsx): how an item works, and one moment of the day.
import type { TranslateFn } from '../../hooks/useTranslation';
import type { HowItWorks, TodayEntry } from '../../api/coworkHome';

function levelWords(how: HowItWorks, t: TranslateFn): string {
    if (how.level === 'asks_everything') return t('cowork.how.asks_everything', 'asks about everything');
    if (how.level === 'asks_before_sending') return t('cowork.how.asks_before_sending', 'asks before sending');
    if (how.level === 'on_its_own') return t('cowork.how.on_its_own', 'on its own');
    return t('cowork.how.cannot_run', 'cannot run as chosen');
}

/** "4 fixed steps, 2 AI, asks before sending" for a plan; "Runs a prompt" or "Done by an agent" for the rest. */
export function howLine(how: HowItWorks | null | undefined, t: TranslateFn): string | null {
    if (!how) return null;
    if (how.kind === 'agent') return t('cowork.how.agent', 'Done by an agent');
    if (how.kind === 'prompt') return t('cowork.how.prompt', 'Runs a prompt');
    const parts = [t('cowork.how.fixed', '{count} fixed steps', { count: how.fixed })];
    if (how.ai > 0) parts.push(t('cowork.how.ai', '{count} AI', { count: how.ai }));
    parts.push(levelWords(how, t));
    return parts.join(', ');
}

/** What one moment of the day says: how a run went, or that it is still to come. */
export function todayWords(entry: TodayEntry, t: TranslateFn): string {
    if (entry.kind === 'next') return t('cowork.today.next', 'Still to come');
    if (entry.status === 'success') return t('cowork.today.done', 'Done');
    if (entry.status === 'running') return t('cowork.today.running', 'Running now');
    if (entry.status === 'waiting' || entry.status === 'needs_review') return t('cowork.today.waiting', 'Waits for you');
    // It finished without doing its work (server core/cowork/runOutcome.mts): a problem, in its own words.
    if (entry.status === 'incomplete') return t('cowork_resolver.status.incomplete', 'Did not do its work');
    return t('cowork.today.failed', 'Did not finish');
}

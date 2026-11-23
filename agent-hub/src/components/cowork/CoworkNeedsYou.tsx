/**
 * "Waiting for you": everything in Cowork that waits for its owner, at the top of the Cowork home (./CoworkPage.tsx).
 * A decision of a plan run is made under Approvals; anything else opens its item, where the review card, the plan
 * card or the sign-in hint is. While nothing waits, only the switch of the daily e-mail of this list shows.
 */
import { BellRing } from 'lucide-react';
import Toggle from '../shared/Toggle';
import { useCoworkDailyMail, useCoworkNeedsYou } from '../../api/coworkNeedsYou';
import { approvalsLink, needWords } from './coworkNeedsModel';
import { useTranslation } from '../../hooks/useTranslation';
import type { CoworkNeed } from '../../api/coworkNeedsYou';
import type { TranslateFn } from '../../hooks/useTranslation';

export interface CoworkNeedsYouProps {
    /** Select an item on the page. */
    onOpen: (itemId: string) => void;
    reloadKey?: number;
}

const BUTTON = 'flex-shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg border text-[12px] font-medium border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]';

function NeedRow({ need, onOpen, t }: { need: CoworkNeed; onOpen: (itemId: string) => void; t: TranslateFn }) {
    const words = needWords(need, t);
    return (
        <li className="flex items-start gap-3 py-2" data-testid="cowork-need" data-kind={need.kind}>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[12.5px] font-medium text-[var(--text-primary)] truncate">{need.title || t('cowork_needs.untitled', 'Untitled work')}</span>
                <span className="text-[12px] text-[var(--text-secondary)]">{words.line}</span>
                {words.detail && <span className="text-[12px] text-[var(--text-tertiary)] line-clamp-2">{words.detail}</span>}
            </div>
            {words.action === 'approvals'
                ? <a className={BUTTON} href={approvalsLink()}>{words.button}</a>
                : <button type="button" className={BUTTON} onClick={() => onOpen(need.itemId)}>{words.button}</button>}
        </li>
    );
}

/** "E-mail me this list every morning": the owner's own switch; absent when the instance cannot send mail. */
function DailyMailSwitch({ t }: { t: TranslateFn }) {
    const { query, save } = useCoworkDailyMail();
    if (!query.data?.available) return null;
    const label = t('cowork_needs.daily_mail', 'E-mail me this list every morning');
    return (
        <div className="flex items-center justify-between gap-3 pt-2 text-[12px] text-[var(--text-secondary)]" data-testid="cowork-daily-mail">
            <span>{label}</span>
            <span className="inline-flex items-center gap-2">
                {save.isError && <span role="alert" className="text-[var(--error-ink)]">{t('cowork_needs.daily_mail_failed', 'That did not save. Try again.')}</span>}
                <Toggle checked={query.data.enabled} disabled={save.isPending} onChange={(next) => save.mutate(next)} ariaLabel={label} />
            </span>
        </div>
    );
}

export default function CoworkNeedsYou({ onOpen, reloadKey = 0 }: CoworkNeedsYouProps) {
    const { t } = useTranslation();
    const needs = useCoworkNeedsYou(reloadKey).data ?? [];
    if (needs.length === 0) return <div className="mb-4 px-[18px]"><DailyMailSwitch t={t} /></div>;
    return (
        <section className="mb-4 rounded-[10px] border px-[18px] py-3 [border-color:var(--border-default)] bg-[var(--bg-secondary)]" data-testid="cowork-needs-you" aria-labelledby="cowork-needs-you-heading">
            <h2 id="cowork-needs-you-heading" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
                <BellRing aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_needs.heading', 'Waiting for you')}
                <span className="tabular-nums text-[var(--text-tertiary)] font-normal">{needs.length}</span>
            </h2>
            <ul className="divide-y divide-[var(--border-subtle)]">
                {needs.map((need) => <NeedRow key={`${need.kind}-${need.itemId}-${need.runId ?? ''}`} need={need} onOpen={onOpen} t={t} />)}
            </ul>
            <DailyMailSwitch t={t} />
        </section>
    );
}

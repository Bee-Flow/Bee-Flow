/**
 * The Teamwork helper: setting up a desk (coworks of different people that hand work to each other, with someone who
 * answers their questions) from plain words, one calm screen at a time:
 *
 *   1. "What should happen, in your words?" — one text box;
 *   2. the helper's proposal as plain sentences, each part changeable with a dropdown (./CoworkTeamworkProposal.tsx);
 *   3. what was done, and what waits for whom.
 *
 * The proposal comes from server/usecases/coworkDeskHelper.mts and makes nothing; "Set it up" goes through the desk's
 * own rules (server/usecases/coworkDeskHelperApply.mts): a colleague agrees before their cowork joins, the owner of a
 * cowork allows its result to go on, at most three hand-offs between people in a row. Every setting stays reachable
 * under "All settings" (./CoworkDeskPanel.tsx). Shown in an item's People settings and on the Cowork home.
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useApplyDeskDraft, useDraftDesk, type DeskProposal, type HelperResult } from '@/api/coworkDeskHelper';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import CoworkTeamworkProposal, { FIELD } from './CoworkTeamworkProposal';
import { bodyOf, editableOf, notReady, notReadyText, noteText, type EditDraft } from './coworkTeamworkModel';

const PRIMARY = 'px-3 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]';
const BUTTON = 'px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50';
const LINK = 'text-[12px] text-[var(--text-secondary)] underline underline-offset-2';

function Failure({ error, t }: { error: Error | null; t: TranslateFn }) {
    if (!error) return null;
    return <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(error) || t('cowork_teamwork.failed', 'That did not work. Try again.')}</p>;
}

function Words({ itemId, text, setText, onProposal }: { itemId?: string; text: string; setText: (s: string) => void; onProposal: (p: DeskProposal) => void }) {
    const { t } = useTranslation();
    const draft = useDraftDesk();
    const ask = () => draft.mutate({ text: text.trim(), ...(itemId ? { itemId } : {}) }, { onSuccess: onProposal });
    return (
        <div className="flex flex-col gap-2">
            <label htmlFor="cowork-teamwork-words" className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {t('cowork_teamwork.words_label', 'What should happen, in your words?')}
            </label>
            <textarea
                id="cowork-teamwork-words" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
                className={`${FIELD} w-full py-1.5 leading-relaxed`}
                placeholder={t('cowork_teamwork.words_placeholder', 'When my supplier mails are done, Ben checks the invoices. Questions go to purchasing: Ben, or Lena when he is away.')}
            />
            <div>
                <button type="button" className={PRIMARY} disabled={!text.trim() || draft.isPending} onClick={ask}>
                    {draft.isPending ? t('cowork_teamwork.thinking', 'Working it out…') : t('cowork_teamwork.set_it_up', 'Set it up')}
                </button>
            </div>
            <Failure error={draft.error} t={t} />
        </div>
    );
}

function Proposal({ itemId, proposal, onBack, onDone }: { itemId?: string; proposal: DeskProposal; onBack: () => void; onDone: (r: HelperResult) => void }) {
    const { t } = useTranslation();
    const apply = useApplyDeskDraft();
    const [draft, setDraft] = useState<EditDraft>(() => editableOf(proposal));
    const waits = notReady(draft, proposal.choices.coworks, !proposal.deskId);
    return (
        <div className="flex flex-col gap-3">
            <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{t('cowork_teamwork.proposal_heading', 'This is what I would set up:')}</p>
            <CoworkTeamworkProposal proposal={proposal} draft={draft} onChange={setDraft} />
            {waits && <p className="text-[12px] text-[var(--text-secondary)]" data-testid="cowork-teamwork-not-ready">{notReadyText(waits, t)}</p>}
            <div className="flex flex-wrap gap-2">
                <button type="button" className={PRIMARY} disabled={!!waits || apply.isPending} onClick={() => apply.mutate({ ...(itemId ? { itemId } : {}), draft: bodyOf(draft) }, { onSuccess: onDone })}>
                    {t('cowork_teamwork.set_it_up', 'Set it up')}
                </button>
                <button type="button" className={BUTTON} disabled={apply.isPending} onClick={onBack}>{t('cowork_teamwork.back', 'Change my words')}</button>
            </div>
            <Failure error={apply.error} t={t} />
        </div>
    );
}

function Result({ result }: { result: HelperResult }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-teamwork-result">
            <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{t('cowork_teamwork.done_heading', 'Done.')}</p>
            <ul className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
                {result.done.map((n, i) => <li key={`d${i}`}>{noteText(n, t)}</li>)}
            </ul>
            {result.waiting.length > 0 && (
                <>
                    <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{t('cowork_teamwork.waiting_heading', 'Still to come:')}</p>
                    <ul className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]" data-testid="cowork-teamwork-waiting">
                        {result.waiting.map((n, i) => <li key={`w${i}`}>{noteText(n, t)}</li>)}
                    </ul>
                </>
            )}
        </div>
    );
}

type Screen = { at: 'words' } | { at: 'proposal'; proposal: DeskProposal } | { at: 'result'; result: HelperResult };

/** The helper. `itemId`: the cowork it is opened from. `onAllSettings`: the full desk settings, where there are any. */
export default function CoworkTeamworkHelper({ itemId, onClose, onAllSettings }: { itemId?: string; onClose: () => void; onAllSettings?: () => void }) {
    const { t } = useTranslation();
    const [screen, setScreen] = useState<Screen>({ at: 'words' });
    // Kept here, so "Change my words" goes back to what was written.
    const [text, setText] = useState('');
    return (
        <section className="flex flex-col gap-3 rounded-xl border p-3 [border-color:var(--border-default)] bg-[var(--bg-secondary)]" aria-labelledby="cowork-teamwork-heading" data-testid="cowork-teamwork-helper">
            <h4 id="cowork-teamwork-heading" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
                <Sparkles aria-hidden="true" className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                {t('cowork_teamwork.heading', 'Teamwork helper')}
            </h4>
            {screen.at === 'words' && <Words itemId={itemId} text={text} setText={setText} onProposal={(proposal) => setScreen({ at: 'proposal', proposal })} />}
            {screen.at === 'proposal' && (
                <Proposal itemId={itemId} proposal={screen.proposal} onBack={() => setScreen({ at: 'words' })} onDone={(result) => setScreen({ at: 'result', result })} />
            )}
            {screen.at === 'result' && <Result result={screen.result} />}
            <div className="flex flex-wrap gap-3">
                <button type="button" className={LINK} onClick={onClose}>{screen.at === 'result' ? t('cowork_teamwork.close', 'Close') : t('cowork_teamwork.cancel', 'Not now')}</button>
                {onAllSettings && <button type="button" className={LINK} onClick={onAllSettings}>{t('cowork_teamwork.all_settings', 'All settings')}</button>}
            </div>
        </section>
    );
}

/**
 * "How it starts", under an item's Settings tab (./CoworkSettings.tsx), read once that tab is shown: on its schedule, after another cowork, when another system
 * calls its address, when rows of a table change, or when a new file arrives in a folder. A new mail is chosen in the
 * edit form. A webhook's address and token are shown once, right after they are made. Choosing a start takes the
 * plan's approval away: the plan is checked again for what the new start brings.
 */
import { useState } from 'react';
import { useCoworkStart, useOwnCoworks, useReadableTables, type HookAddress, type StartChoice, type StartKind } from '../../api/coworkStart';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import type { CoworkItem } from '../../api/cowork.types';
import type { TranslateFn } from '../../hooks/useTranslation';

const FIELD = 'rounded-lg border px-2 py-1.5 text-[12.5px] bg-[var(--bg-primary)] [border-color:var(--border-default)]';
const BUTTON = 'px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50';
const CHOICES: Array<[Exclude<StartKind, 'app_event'>, string, string]> = [
    ['schedule', 'cowork.start.schedule', 'On its schedule'],
    ['after_cowork', 'cowork.start.after_cowork', 'After another cowork ends well'],
    ['webhook', 'cowork.start.webhook', 'When another system calls its address'],
    ['row', 'cowork.start.row', 'When rows of a table change'],
    ['file', 'cowork.start.file', 'When a new file arrives in a folder'],
];

function Address({ address, t }: { address: HookAddress; t: TranslateFn }) {
    return (
        <div className="flex flex-col gap-1 rounded-lg border px-3 py-2 [border-color:var(--warning-ink)]" data-testid="cowork-start-address">
            <span className="text-[12px] font-medium text-[var(--text-primary)]">{t('cowork.start.address_once', 'Copy these now: the token is shown only once.')}</span>
            <code className="text-[11.5px] break-all">POST {address.url}</code>
            <code className="text-[11.5px] break-all">Authorization: Bearer {address.token}</code>
        </div>
    );
}

/** The choice the form holds, or null while it is not complete. */
function choiceOf(kind: StartKind, value: string): StartChoice | null {
    if (kind === 'after_cowork') return value ? { kind, scheduleId: value } : null;
    if (kind === 'row') return value ? { kind, datatableId: value } : null;
    if (kind === 'file') return value.startsWith('/') ? { kind, inFolder: value } : null;
    return kind === 'webhook' || kind === 'schedule' ? { kind } : null;
}

/** What the chosen start needs: which cowork, which table, which folder. */
function StartTarget({ kind, value, onChange, itemId, t }: { kind: StartKind; value: string; onChange: (v: string) => void; itemId: string; t: TranslateFn }) {
    const others = useOwnCoworks(kind === 'after_cowork').data ?? [];
    const tables = useReadableTables(kind === 'row').data ?? [];
    const choose = t('cowork.start.choose', 'Choose…');
    if (kind === 'after_cowork') {
        return (
            <select aria-label={t('cowork.start.after_which', 'After which cowork')} className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">{choose}</option>
                {others.filter((o) => o.id !== itemId).map((o) => <option key={o.id} value={o.id}>{o.title || t('cowork_needs.untitled', 'Untitled work')}</option>)}
            </select>
        );
    }
    if (kind === 'row') {
        return (
            <select aria-label={t('cowork.start.which_table', 'Which table')} className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">{choose}</option>
                {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name || tb.id}</option>)}
            </select>
        );
    }
    if (kind === 'file') {
        return <input aria-label={t('cowork.start.folder', 'Folder in Nextcloud, such as /Invoices')} placeholder="/Invoices" className={FIELD} value={value} onChange={(e) => onChange(e.target.value)} />;
    }
    return null;
}

/** A new webhook token, asked once more: the old one stops working at once, and the plan is approved again. */
function NewToken({ saved, chosen, busy, onConfirm, t }: { saved: StartKind; chosen: StartKind; busy: boolean; onConfirm: () => void; t: TranslateFn }) {
    const [asking, setAsking] = useState(false);
    if (saved !== 'webhook' || chosen !== 'webhook') return null;
    if (!asking) {
        return <button type="button" className="text-[12px] font-medium text-[var(--accent)] self-start" onClick={() => setAsking(true)}>{t('cowork.start.rotate', 'Make a new token')}</button>;
    }
    return (
        <div role="alertdialog" aria-label={t('cowork.start.rotate', 'Make a new token')} className="flex flex-col gap-2 rounded-lg border px-3 py-2 [border-color:var(--border-default)]">
            <p className="text-[12px] text-[var(--text-primary)]">{t('cowork.start.rotate_confirm', 'The current token stops working at once, so whatever calls this cowork needs the new one. Its plan is approved again.')}</p>
            <div className="flex gap-2">
                <button type="button" className={BUTTON} disabled={busy} onClick={() => { setAsking(false); onConfirm(); }}>{t('cowork.start.rotate_go', 'Make a new token')}</button>
                <button type="button" className="px-3 py-1.5 rounded-lg text-[12px] font-medium" onClick={() => setAsking(false)}>{t('cowork.start.keep', 'Keep the current one')}</button>
            </div>
        </div>
    );
}

export default function CoworkStartPanel({ item }: { item: CoworkItem }) {
    const { t } = useTranslation();
    const { query, choose } = useCoworkStart(item.id, true);
    const [kind, setKind] = useState<StartKind | null>(null);
    const [value, setValue] = useState('');
    const current = kind ?? query.data?.kind ?? 'schedule';
    const ready = choiceOf(current, value);
    // Nothing chosen yet is nothing to save: saving the same webhook again would make a new token.
    const unchanged = kind === null && value === '';
    const failed = choose.error ? errorMessage(choose.error) || t('cowork_plan.failed', 'That did not work. Try again.') : null;
    return (
        <div data-testid="cowork-start">
            {query.data && (
                <div className="flex flex-col gap-2">
                    {query.data.kind === 'app_event' && <p className="text-[12px] text-[var(--text-secondary)]">{t('cowork.start.mail', 'It starts on a new mail; change that in the edit form.')}</p>}
                    <label htmlFor={`cowork-start-${item.id}`} className="text-[12px] font-medium text-[var(--text-primary)]">{t('cowork.start.label', 'Starts')}</label>
                    <select id={`cowork-start-${item.id}`} className={FIELD} value={current} onChange={(e) => { setKind(e.target.value as StartKind); setValue(''); }}>
                        {CHOICES.map(([k, key, en]) => <option key={k} value={k}>{t(key, en)}</option>)}
                    </select>
                    <StartTarget kind={current} value={value} onChange={setValue} itemId={item.id} t={t} />
                    <p className="text-[12px] text-[var(--text-tertiary)]">
                        {t('cowork.start.hint', 'What an event brings is treated as text from outside: it can fill content, never a recipient. A plan is approved again after a change here.')}
                    </p>
                    <div>
                        <button type="button" className={BUTTON} disabled={!ready || unchanged || choose.isPending} onClick={() => { if (ready) choose.mutate(ready); }}>
                            {t('cowork.start.save', 'Save how it starts')}
                        </button>
                    </div>
                    <NewToken saved={query.data.kind} chosen={current} busy={choose.isPending} onConfirm={() => choose.mutate({ kind: 'webhook' })} t={t} />
                    {choose.data?.address && <Address address={choose.data.address} t={t} />}
                    {failed && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{failed}</p>}
                </div>
            )}
        </div>
    );
}

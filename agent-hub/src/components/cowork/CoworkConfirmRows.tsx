/**
 * The two rows of the confirmation card (./CoworkConfirmCard.tsx) the owner fills with chips before a task exists:
 *
 *   Uses      the apps the task may use: the ones the sentence names are there already, nothing else is. Each can be
 *             taken off, and any app of the workspace can be added. With none left it says so: the AI only writes.
 *   Sends to  "Me" and the addresses found in the sentence, each removable, and a field to add an address. When someone
 *             other than the owner gets it: "Show me each message first", on unless they switch it off.
 *
 * Both only say what was chosen (`onChoose`); what the card shows is ./coworkConfirmModel.ts `confirmView`.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { isAddress, withRecipient, withoutRecipient, type ConfirmChoices, type ConfirmView } from './coworkConfirmModel';
import { Expand, TINT } from './coworkMotion';
import { ALERT, BUTTON_SECONDARY, FIELD, LINK_INLINE, META, TAG_PLAIN } from './coworkUi';
import { FOCUS_RING } from '../shared/buttonClasses';
import type { TranslateFn } from '@/hooks/useTranslation';

/** A chip: the shared tag, a little taller, with room for its remove button. */
const CHIP = `${TAG_PLAIN} min-h-9 py-0 pl-3 pr-0 max-w-full text-[13px] leading-5 text-[var(--text-primary)]`;
const CHIP_REMOVE = `grid place-items-center flex-shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11! rounded-full text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] ${TINT} ${FOCUS_RING}`;
const SAID = 'm-0 text-[14px] leading-5 font-medium text-[var(--text-primary)]';

function Chip({ label, removeLabel, onRemove, children }: { label: string; removeLabel: string; onRemove: () => void; children?: ReactNode }) {
    return (
        <li className={CHIP}>
            <span className="truncate">{children ?? label}</span>
            <button type="button" className={CHIP_REMOVE} aria-label={removeLabel} onClick={onRemove}>
                <X className="w-4 h-4" aria-hidden="true" />
            </button>
        </li>
    );
}

export interface ConfirmRowProps {
    view: ConfirmView;
    onChoose: (change: Partial<ConfirmChoices>) => void;
    t: TranslateFn;
}

/** What the Uses row says when it holds no chip: Cowork picks the apps (nobody chose), or the AI only writes (none left). */
function usesWords(apps: string[] | null, t: TranslateFn): string | null {
    if (apps === null) return t('cowork_home.confirm.picks_apps', 'Cowork picks the apps it needs while it sets up the steps. You see them before anything runs.');
    return apps.length === 0 ? t('cowork_home.confirm.no_apps', 'No apps. The AI only writes.') : null;
}

/** Uses: the apps as chips, and "Add an app" from the workspace's catalogue. */
export function UsesRow({ view, onChoose, t, catalogue }: ConfirmRowProps & { catalogue: ReadonlyArray<{ id: string; label: string }> }) {
    const chosen = view.apps ?? [];
    const labelOf = (id: string): string => catalogue.find((a) => a.id === id)?.label ?? id;
    const left = catalogue.filter((a) => !chosen.includes(a.id));
    const words = usesWords(view.apps, t);
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-confirm-uses">
            {words && <p className={view.apps === null ? `m-0 ${META}` : SAID}>{words}</p>}
            <div className="flex flex-wrap items-center gap-2">
                {chosen.length > 0 && (
                    <ul className="contents">
                        {chosen.map((id) => (
                            <Chip key={id} label={labelOf(id)} removeLabel={t('cowork_home.confirm.remove', 'Remove {name}', { name: labelOf(id) })} onRemove={() => onChoose({ apps: chosen.filter((a) => a !== id) })} />
                        ))}
                    </ul>
                )}
                {left.length > 0 && (
                    <>
                        <label htmlFor="cowork-confirm-add-app" className="sr-only">{t('cowork_home.confirm.add_app', 'Add an app')}</label>
                        <select id="cowork-confirm-add-app" className={FIELD} value="" onChange={(e) => { if (e.target.value) onChoose({ apps: [...chosen, e.target.value] }); }}>
                            <option value="">{t('cowork_home.confirm.add_app', 'Add an app')}</option>
                            {left.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                    </>
                )}
            </div>
        </div>
    );
}

/** "Add an address": a field and a button; an entry that is no address says so instead of being added. */
function AddAddress({ onAdd, t }: { onAdd: (address: string) => void; t: TranslateFn }) {
    const [value, setValue] = useState('');
    const [wrong, setWrong] = useState(false);
    const add = (e: FormEvent) => {
        e.preventDefault();
        if (!isAddress(value)) { setWrong(value.trim() !== ''); return; }
        onAdd(value.trim());
        setValue('');
        setWrong(false);
    };
    return (
        <form className="flex flex-col gap-1" onSubmit={add} noValidate>
            <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="cowork-confirm-add-address" className="sr-only">{t('cowork_home.confirm.add_address', 'Add an address')}</label>
                <input
                    id="cowork-confirm-add-address" type="email" autoComplete="off" value={value} aria-invalid={wrong}
                    placeholder={t('cowork_home.confirm.address_placeholder', 'name@example.com')}
                    onChange={(e) => { setValue(e.target.value); setWrong(false); }}
                    className={`${FIELD} w-[220px]`}
                />
                <button type="submit" className={BUTTON_SECONDARY} disabled={!value.trim()}>{t('cowork_home.confirm.add', 'Add')}</button>
            </div>
            {wrong && <p role="alert" className={ALERT}>{t('cowork_home.confirm.not_an_address', 'That is not an e-mail address.')}</p>}
        </form>
    );
}

/** "Show me each message first": on whenever someone else gets it, unless the owner switches it off. */
function ShowFirst({ view, onChoose, t }: ConfirmRowProps) {
    return (
        <div className="flex flex-col gap-1">
            <label className="inline-flex items-center gap-2 min-h-9 text-[14px] leading-5 font-medium text-[var(--text-primary)]">
                <input type="checkbox" role="switch" className="w-4 h-4 accent-[var(--text-primary)]" checked={view.showFirst} onChange={(e) => onChoose({ showFirst: e.target.checked })} />
                {t('cowork_home.confirm.show_first', 'Show me each message first')}
            </label>
            <p className={`m-0 ${META}`}>
                {view.showFirst
                    ? t('cowork_home.confirm.show_first_on', 'Nothing goes to someone else before you have seen it, under Needs you.')
                    : t('cowork_home.confirm.show_first_off', 'Cowork still shows you each message at first. After 10 runs you let through, you can choose “Don’t ask” in the task.')}
            </p>
        </div>
    );
}

/** Sends to: "Me" and the addresses as chips, "Add an address", and "Show me each message first". */
export function SendsToRow({ view, onChoose, t }: ConfirmRowProps) {
    const to = view.recipients;
    const nobody = !to.me && to.others.length === 0;
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-confirm-sends">
            {nobody && <p className={SAID}>{t('cowork_home.confirm.sends_nobody', 'Nobody. The result stays in the task.')}</p>}
            <ul className="flex flex-wrap items-center gap-2">
                {to.me && <Chip label={t('cowork_home.confirm.me', 'Me')} removeLabel={t('cowork_home.confirm.remove', 'Remove {name}', { name: t('cowork_home.confirm.me', 'Me') })} onRemove={() => onChoose({ recipients: { ...to, me: false } })} />}
                {to.others.map((address) => (
                    <Chip key={address} label={address} removeLabel={t('cowork_home.confirm.remove', 'Remove {name}', { name: address })} onRemove={() => onChoose({ recipients: withoutRecipient(to, address) })} />
                ))}
                {!to.me && (
                    <li><button type="button" className={LINK_INLINE} onClick={() => onChoose({ recipients: { ...to, me: true } })}>{t('cowork_home.confirm.add_me', 'Add me')}</button></li>
                )}
            </ul>
            <AddAddress onAdd={(address) => onChoose({ recipients: withRecipient(to, address) })} t={t} />
            <Expand open={view.sendsToOthers}><ShowFirst view={view} onChoose={onChoose} t={t} /></Expand>
        </div>
    );
}

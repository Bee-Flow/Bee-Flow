import { Building2, Check, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Card, Chip } from './WebpageDataCards';
import type { AudienceModel, AddressCardProps } from './WebpageAudiencePanel.types';
import { logger } from '../../utils/logger';

/**
 * Which sentence goes beneath the address, about the OTHER external links.
 *
 * "Public off" says something only about the ADDRESS. The server withdraws, on `{on:false}`, exclusively the CANONICAL share; a loose /share/<token> of the same page keeps serving the frozen snapshot afterwards, with the rendered table rows included. If this screen is silent about that, the owner reads "Off" and "Not serving" about a page that is anonymously reachable — precisely the direction that the fourth row must rule out.
 *
 * Four states:
 *   'while_on'  public ON with more than one link: one of them IS the address, the rest stands beside it;
 *   'while_off' public OFF and at least one is still open: none of them is the address, and they keep serving;
 *   'unknown'   public OFF but the share list was unreadable. Then nothing is claimed — 0 from a failed read is not "empty", and precisely here that would make the warning disappear;
 *   'none'      there is nothing to report.
 *
 * With an UNKNOWN public state (`public.known === false`) this sentence stays silent: the row above then already says that the state could not be read, and "Public is off, but…" would add a claim to it that nobody can make good.
 */
export function otherLinksNotice(model: AudienceModel | null | undefined) {
    const known = model?.public?.known !== false;
    const on = !!model?.public?.on;
    const count = Number(model?.shareCount) || 0;
    if (on) return count > 1 ? 'while_on' : 'none';
    if (!known) return 'none';
    if (model?.shareCountKnown === false) return 'unknown';
    return count > 0 ? 'while_off' : 'none';
}

export function AddressCard({ t, model, options, setOptions, onSaveOptions, busy }: AddressCardProps) {
    const [copied, setCopied] = useState(false);
    const [open, setOpen] = useState(false);
    const address = model?.address;
    const isPublic = !!model?.public?.on;
    // What must be said about the OTHER external links — the line stands apart and
    // pure, because it depends on three fields and is the only thing that keeps
    // "Not serving" from being read as "nobody can get at it any more".
    const notice = otherLinksNotice(model);

    const copy = async () => {
        const value = address?.url || address?.path || '';
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (err) { logger.debug('een browser zonder klembord: de tekst staat er gewoon', err); }
    };

    return (
        <Card>
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{t('webpages.address.title', 'Address')}</span>
                {isPublic
                    ? <Chip label={t('webpages.address.live', 'Live')} tone="public" />
                    : <Chip label={t('webpages.address.not_serving', 'Not serving')} tone="muted" dashed />}
            </div>

            {address ? (
                <div className="flex items-center gap-2 flex-wrap">
                    <code
                        data-testid="address-value"
                        className="text-[11px] px-1.5 py-0.5 rounded border border-[var(--border-subtle)] text-[var(--text-primary)]"
                    >
                        {address.url || address.path}
                    </code>
                    <button type="button" onClick={copy} className="text-xs underline inline-flex items-center gap-1">
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? t('webpages.address.copied', 'Copied') : t('common.copy', 'Copy')}
                    </button>
                </div>
            ) : (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.none_yet', 'This page gets its address the first time you make it public.')}
                </p>
            )}

            {address && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.made_of',
                        'The readable part comes from the page name as it was the first time you made this page public, and the rest is random so the address cannot be guessed. Renaming the page does not move it.')}
                </p>
            )}

            {address && !isPublic && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.kept_while_off',
                        'The address stays reserved while Public is off — it shows nothing until you turn Public back on, and then it is the same link again.')}
                </p>
            )}

            <button
                type="button"
                data-testid="address-options-toggle"
                onClick={() => setOpen(o => !o)}
                className="self-start text-xs underline"
                aria-expanded={open}
            >
                {t('webpages.all_options', 'All options')}
            </button>

            {open && (
                <div className="flex flex-col gap-2 pt-1 border-t border-[var(--border-subtle)]">
                    <fieldset className="flex flex-col gap-1">
                        <legend className="text-[11px] font-medium">
                            {t('webpages.address.who_may_open', 'Who may open the address')}
                        </legend>
                        {[
                            ['unlisted', t('webpages.address.mode_unlisted', 'Anyone with the address')],
                            ['password', t('webpages.address.mode_password', 'Anyone with the address and the password')],
                            ['email', t('webpages.address.mode_email', 'Only these email addresses')],
                        ].map(([value, label]) => (
                            <label key={value} className="inline-flex items-center gap-2 text-[11px] cursor-pointer">
                                <input
                                    type="radio"
                                    name="bf-access-mode"
                                    value={value}
                                    checked={options.accessMode === value}
                                    onChange={() => setOptions(o => ({ ...o, accessMode: value }))}
                                />
                                {label}
                            </label>
                        ))}
                    </fieldset>

                    {options.accessMode === 'password' && (
                        <label className="flex flex-col gap-1 text-[11px]">
                            {t('webpages.address.password', 'Password (at least 6 characters)')}
                            <input
                                type="password"
                                value={options.password}
                                onChange={(e) => setOptions(o => ({ ...o, password: e.target.value }))}
                                className="rounded border px-2 py-1 [border-color:var(--border-subtle)] [background:var(--bg-primary)]"
                            />
                        </label>
                    )}

                    {options.accessMode === 'email' && (
                        <label className="flex flex-col gap-1 text-[11px]">
                            {t('webpages.address.emails', 'Email addresses, one per line')}
                            <textarea
                                rows={3}
                                value={options.emails}
                                onChange={(e) => setOptions(o => ({ ...o, emails: e.target.value }))}
                                className="rounded border px-2 py-1 [border-color:var(--border-subtle)] [background:var(--bg-primary)]"
                            />
                        </label>
                    )}

                    <label className="flex flex-col gap-1 text-[11px]">
                        {t('webpages.address.expires', 'Stops working on')}
                        <input
                            type="date"
                            value={options.expiresAt}
                            onChange={(e) => setOptions(o => ({ ...o, expiresAt: e.target.value }))}
                            className="rounded border px-2 py-1 self-start [border-color:var(--border-subtle)] [background:var(--bg-primary)]"
                        />
                    </label>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                        {t('webpages.address.replace_warning',
                            'Changing the password or the email list replaces the underlying link, so links people already have stop working. The address itself stays the same.')}
                    </p>

                    {isPublic && (
                        <button
                            type="button"
                            data-testid="address-options-save"
                            disabled={busy}
                            onClick={onSaveOptions}
                            className="self-start text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                        >
                            {busy && <Loader2 size={12} className="animate-spin" />}
                            {t('webpages.address.save_options', 'Apply')}
                        </button>
                    )}
                </div>
            )}

            {/* While Public is ON: only with more than one, because then one of those links
                is the address and the rest stands beside it. The sentence is therefore
                always plural and needs no singular form. */}
            {notice === 'while_on' && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.other_links',
                        'There are {n} external links on this page in total. Only this one is the address; the others are separate share links.')
                        .replace('{n}', String(model.shareCount))}
                </p>
            )}

            {/* If Public is OFF, that threshold no longer applies: none of the remaining links
                is the address any more, and they all keep serving. One link is then
                precisely the case that MUST be reported. */}
            {notice === 'while_off' && (
                <p
                    data-testid="other-links-while-off"
                    className="text-[11px] text-[var(--warning)]"
                >
                    {model.shareCount === 1
                        ? t('webpages.address.serving_while_off',
                            'Public is off, but one external link still serves a snapshot of this page. It is not the address, so turning Public off did not stop it.')
                        : t('webpages.address.serving_while_off_plural',
                            'Public is off, but {n} external links still serve a snapshot of this page. They are not the address, so turning Public off did not stop them.')
                            .replace('{n}', String(model.shareCount))}
                </p>
            )}

            {notice === 'unknown' && (
                <p
                    data-testid="other-links-unknown"
                    className="text-[11px] text-[var(--warning)]"
                >
                    {t('webpages.address.other_links_unknown',
                        'Whether other external links still serve this page could not be checked, so nothing is claimed here.')}
                </p>
            )}

            {model?.solution && (
                <p className="text-[11px] pt-1 border-t text-[var(--text-secondary)] border-[var(--border-subtle)]">
                    <Building2 size={11} className="inline mr-1" aria-hidden="true" />
                    {t('webpages.address.part_of_solution', 'Part of solution {name}').replace('{name}', model.solution.name)}
                </p>
            )}
        </Card>
    );
}

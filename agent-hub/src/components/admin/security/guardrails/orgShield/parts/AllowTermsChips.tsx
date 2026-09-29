import { Eye, TriangleAlert, X } from 'lucide-react';
import React, { useId } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';
import AddRow from './AddRow';

/**
 * "Never hidden": the never-redact list, the mirror image of the org's own
 * kinds of data.
 *
 * ── Why this is the most dangerous control on the page ────────────────────
 * Everything else here makes the shield redact MORE. This one makes it redact
 * LESS, permanently. So the copy is not decoration: an admin has to be able
 * to predict exactly what a term will and will not exempt, or they will
 * allowlist "Shell" and quietly unredact a client called "Shell Advies BV".
 *
 * Matching is exact on the NORMALISED form (case, punctuation and whitespace
 * stripped) and never a substring; the card says so in those words. The
 * admin's own entries apply in every category, the shipped list only to
 * company names (server/core/dlp/allowTerms.js), and the card says that too.
 *
 * The card is neutral, as designed, so a one-line warning keeps the risk in
 * view. Not licence-gated: the server accepts these on every plan.
 */

/**
 * Size of the shipped list, `PUBLIC_ORGANISATIONS` in
 * server/core/dlp/publicOrgs.js. The API does not serve it, so it is kept
 * here like the other places that name it; change them together.
 */
const PUBLIC_ORGS_COUNT = 221;

/**
 * Mirror of `normaliseAllowValue` in server/core/dlp/allowTerms.js.
 *
 * Duplicated rather than imported because that module is CommonJS and
 * server-only. `orgShield.allowterms` tests the server side; the client test
 * uses the same fixtures so the two cannot drift unnoticed.
 */
export function normaliseAllowValue(value: unknown): string {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

interface AllowTermsChipsProps {
    terms: string[];
    onChange: (terms: string[]) => void;
    publicOrgs: boolean;
    onChangePublicOrgs: (on: boolean) => void;
    readOnly: boolean;
    t: TranslateFn;
}

/** One line of the card: a label (and a sub-line) left, a figure right. */
function Row({ label, sub, figure, children }: { label: string; sub?: string; figure: React.ReactNode; children?: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 py-[9px] border-t border-[var(--border-subtle)]">
            <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)]">{label}</div>
                {sub && <div className="text-[11px] text-[var(--text-tertiary)]">{sub}</div>}
            </div>
            <div className="flex items-center gap-3 shrink-0">
                <span className="text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">{figure}</span>
                {children}
            </div>
        </div>
    );
}

function Chips({ terms, readOnly, onRemove, t }: { terms: string[]; readOnly: boolean; onRemove: (i: number) => void; t: TranslateFn }) {
    return (
        <ul className="flex flex-wrap gap-1.5 list-none p-0 m-0 pb-1">
            {terms.map((term, i) => (
                <li key={`${term}-${i}`}>
                    <span className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)]">
                        {term}
                        {!readOnly && (
                            <button
                                type="button"
                                onClick={() => onRemove(i)}
                                aria-label={t('admin.shield_allow_remove', 'Remove {term}', { term })}
                                className="p-0.5 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                            >
                                <X className="w-3 h-3" aria-hidden="true" />
                            </button>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function AllowTermsChips({ terms: rawTerms, onChange, publicOrgs: rawPublic, onChangePublicOrgs, readOnly, t }: AllowTermsChipsProps) {
    const titleId = useId();
    const terms = rawTerms || [];
    const publicOrgs = rawPublic !== false;
    const add = (raw: string) => {
        const key = normaliseAllowValue(raw);
        if (!key) return t('admin.shield_allow_err_empty', 'Enter a name or word.');
        if (raw.length > 120) return t('admin.shield_allow_err_long', 'Keep it under 120 characters.');
        // Without this, adding "Coca-Cola" when "coca cola" is already listed
        // is a silent no-op the admin has no way to see.
        if (terms.some(existing => normaliseAllowValue(existing) === key)) {
            return t('admin.shield_allow_err_duplicate', 'That one is already on the list (upper and lower case, spaces and punctuation do not matter).');
        }
        onChange([...terms, raw]);
        return null;
    };
    const publicTitle = t('admin.shield_allow_public_title', 'Always allow well-known companies');

    return (
        <section
            aria-labelledby={titleId}
            className="flex flex-col gap-2.5 px-4 py-3.5 rounded-xl border bg-[var(--bg-card)] border-[var(--border-default)] shadow-[var(--shadow-sm)]"
        >
            <h3 id={titleId} className="m-0 flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <Eye className="w-[15px] h-[15px] shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                {t('admin.shield_posture_allowlist', 'Never hidden')}
            </h3>
            <p className="m-0 text-xs leading-[18px] text-[var(--text-secondary)]">
                {t('shield_data.never_desc', 'Left visible to the AI on purpose. Your own exceptions apply in every category; the well-known list applies to company names. Matches are exact: “Shell” does not cover “Shell Advies BV”.')}
            </p>
            <div>
                <Row
                    label={t('shield_data.never_public_label', 'Well-known companies')}
                    sub={t('shield_data.never_public_sub', 'Google, Microsoft, Shell … maintained by Bee Flow')}
                    figure={publicOrgs ? PUBLIC_ORGS_COUNT : <span className="font-normal text-[var(--text-tertiary)]">{t('shield_data.never_public_off', 'Off')}</span>}
                >
                    <Toggle
                        id="org-shield-allow-public"
                        size="sm"
                        checked={publicOrgs}
                        onChange={onChangePublicOrgs}
                        disabled={readOnly}
                        ariaLabel={publicTitle}
                    />
                </Row>
                <Row label={t('shield_data.never_own_label', 'Your own exceptions')} figure={terms.length} />
                {terms.length > 0 && (
                    <Chips terms={terms} readOnly={readOnly} onRemove={i => onChange(terms.filter((_, idx) => idx !== i))} t={t} />
                )}
            </div>
            {!readOnly && (
                <AddRow
                    onAdd={add}
                    placeholder={t('shield_data.never_add_placeholder', 'Add a name that should stay visible')}
                    addLabel={t('admin.shield_allow_add', 'Add')}
                />
            )}
            <p className="m-0 flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--warning-ink)]">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                {t('shield_data.never_warn', 'These reach the AI as written. Add only names that are not personal data.')}
            </p>
        </section>
    );
}

export default AllowTermsChips;

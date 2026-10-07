import { MoreHorizontal, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../../shared/AnchoredMenu';
import { ActionButton as ActionButtonJs } from '../audits/auditForms';

/**
 * RopaScc: a processor's transfer basis (GDPR Art. 46) in the processing
 * register, one cell in the table and the trailing slot of a phone card.
 *
 *   EU processor        "Not needed": quiet text, the Location already says EU
 *   attested            "Attested" in success ink, with a small overflow menu
 *                       whose "Withdraw attestation…" asks before it acts
 *   missing (non-EU)    the "Attest SCC" button
 *
 * The attested state used to be a green button that withdrew the attestation
 * on one click; a record an auditor samples is now taken back only after a
 * confirm inside the menu. Keyboard: the overflow opens with Enter, Space or
 * ArrowDown, the menu keys move between its items, Escape closes it and the
 * focus returns to the overflow button.
 */

// .jsx/.js exports: their `= null` defaults would type the props as null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;
const ActionButton = ActionButtonJs as unknown as ComponentType<{
    variant?: string; icon?: LucideIcon; size?: string; disabled?: boolean; onClick?: () => void;
    className?: string; children?: ReactNode; 'data-testid'?: string;
}>;

export interface SccProcessor {
    operator?: string | null;
    is_eu?: boolean;
}

export interface SccCellProps {
    processor: SccProcessor;
    /** The operator's SCC attestation is on record. */
    attested: boolean;
    busy?: boolean;
    /** Records (`true`) or withdraws (`false`) the attestation. */
    onToggle?: (operator: string | null | undefined, confirmed: boolean) => void;
    /** The phone card: 44px targets. */
    card?: boolean;
    /** Appended to every test id ("OpenAI", "card-OpenAI"). */
    testKey: string;
}

const MENU_ITEM = 'w-full flex items-center px-2.5 h-8 rounded-[6px] text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:bg-[var(--bg-secondary)]';
const CONFIRM_BTN = 'inline-flex items-center h-7 px-2.5 rounded-[8px] text-[11px] font-medium border focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

function WithdrawMenu({ name, busy, onWithdraw, card, testKey }: {
    name: string;
    busy: boolean;
    onWithdraw: () => void;
    card: boolean;
    testKey: string;
}) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const cancelRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const [confirming, setConfirming] = useState(false);
    // Stable: AnchoredMenu re-focuses its first item whenever onClose changes.
    const close = useCallback(() => { setOpen(false); setConfirming(false); }, []);
    // The confirm replaces the item that had the focus; Cancel takes it, so
    // Enter on a held key never withdraws by accident.
    useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('compliance.ropa_scc_more', 'Transfer basis options for {name}', { name })}
                onClick={() => (open ? close() : setOpen(true))}
                onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
                className={`grid place-items-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${card ? 'min-w-[44px] min-h-[44px]' : 'w-6 h-6'}`}
                data-testid={`ropa-scc-menu-${testKey}`}
            >
                <MoreHorizontal size={14} aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={close}
                anchorRef={anchorRef}
                align="right"
                minWidth={confirming ? 240 : 180}
                role="menu"
                aria-label={t('compliance.ropa_scc_more', 'Transfer basis options for {name}', { name })}
                className="p-1"
                data-testid={`ropa-scc-menu-panel-${testKey}`}
            >
                {confirming ? (
                    <div className="flex flex-col gap-2 p-1.5" data-testid={`ropa-scc-confirm-${testKey}`}>
                        <p className="m-0 text-[12px] leading-4 text-[var(--text-primary)]">
                            {t('compliance.ropa_scc_withdraw_confirm', 'Withdraw the SCC attestation for {name}?', { name })}
                        </p>
                        <div className="flex justify-end gap-1.5">
                            <button ref={cancelRef} type="button" role="menuitem" onClick={close}
                                className={`${CONFIRM_BTN} border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]`}
                                data-testid={`ropa-scc-withdraw-cancel-${testKey}`}>
                                {t('common.cancel', 'Cancel')}
                            </button>
                            <button type="button" role="menuitem" onClick={() => { close(); onWithdraw(); }}
                                className={`${CONFIRM_BTN} border-[var(--error)] bg-transparent text-[var(--error-ink)] hover:bg-[var(--bg-secondary)]`}
                                data-testid={`ropa-scc-withdraw-go-${testKey}`}>
                                {t('compliance.ropa_scc_withdraw_go', 'Withdraw')}
                            </button>
                        </div>
                    </div>
                ) : (
                    <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => setConfirming(true)}
                        data-testid={`ropa-scc-withdraw-${testKey}`}>
                        {t('compliance.ropa_scc_withdraw', 'Withdraw attestation…')}
                    </button>
                )}
            </AnchoredMenu>
        </>
    );
}

export default function SccCell({ processor, attested, busy = false, onToggle, card = false, testKey }: SccCellProps) {
    const { t } = useTranslation();
    const name = processor.operator || '—';

    if (processor.is_eu) {
        return (
            <span className="text-[11px] text-[var(--text-tertiary)] whitespace-nowrap flex-shrink-0" data-testid={`ropa-scc-none-${testKey}`}>
                {t('compliance.ropa_scc_not_needed_short', 'Not needed')}
            </span>
        );
    }
    if (attested) {
        return (
            <span className="inline-flex items-center gap-1 whitespace-nowrap flex-shrink-0">
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--success-ink)]" data-testid={`ropa-scc-${testKey}`}>
                    <ShieldCheck size={12} aria-hidden="true" />
                    {t('compliance.ropa_scc_attested', 'Attested')}
                </span>
                {onToggle ? (
                    <WithdrawMenu name={name} busy={busy} card={card} testKey={testKey}
                        onWithdraw={() => onToggle(processor.operator, false)} />
                ) : null}
            </span>
        );
    }
    return (
        <ActionButton
            size={card ? undefined : 'sm'}
            variant="warning"
            icon={ShieldAlert}
            disabled={busy || !onToggle}
            onClick={() => onToggle?.(processor.operator, true)}
            className={card ? 'flex-shrink-0 min-h-[44px]' : 'flex-shrink-0'}
            data-testid={`ropa-scc-${testKey}`}
        >
            {t('compliance.ropa_scc_confirm', 'Attest SCC')}
        </ActionButton>
    );
}

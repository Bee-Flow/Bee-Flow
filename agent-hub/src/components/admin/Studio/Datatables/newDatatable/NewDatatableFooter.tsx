import { Loader2 } from 'lucide-react';
import React from 'react';
import type { SyntheticEvent } from 'react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { BTN } from './constants';

interface NewDatatableFooterProps {
    nextcloud: boolean;
    spreadsheet: boolean;
    effectiveKey: string;
    mode: string;
    onClose: () => void;
    submit: (e: SyntheticEvent) => void | Promise<void>;
    busy: boolean;
    ready: boolean;
    t: TranslateFn;
}

export default function NewDatatableFooter({ nextcloud, spreadsheet, effectiveKey, mode, onClose, submit, busy, ready, t }: NewDatatableFooterProps) {
    return (
        <>
            {/* The technical name is STATED even when its editor is
                hidden: it is the identifier a Datatable step refers to,
                and a person who never sees it cannot look their table
                up later. */}
            <span className="mr-auto text-[11px] min-w-0 truncate text-[var(--text-tertiary)]">
                {nextcloud ? t('datatables.nc_footer', 'Names and technical names are chosen per table in the next step.')
                    : spreadsheet ? t('datatables.ss_footer', 'Names and technical names are chosen per sheet in the next step.') : (
                    <>
                        {t('datatables.technical_name', 'Technical name:')}{' '}
                        <code className="font-mono">{effectiveKey || '—'}</code>
                        {mode === 'simple' && (
                            <>{' · '}{t('datatables.technical_name_hint', 'editable under All options')}</>
                        )}
                    </>
                )}
            </span>
            <button type="button" onClick={onClose} className={`${BTN} border`}
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                {t('datatables.cancel', 'Cancel')}
            </button>
            {/* type=button + the same handler, not a form-associated
                submit: the footer lives outside the <form> (the Modal
                owns that slot), and cross-form association is one of
                the places jsdom and browsers disagree. Enter inside a
                field still submits, through the form's own onSubmit. */}
            <button
                type="button"
                onClick={submit}
                disabled={busy || !ready}
                className={`${BTN} font-medium disabled:opacity-50 inline-flex items-center gap-1.5`}
                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
            >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                {nextcloud ? t('datatables.nc_choose', 'Choose tables…') : spreadsheet ? t('datatables.ss_choose', 'Choose files…') : t('datatables.create', 'Create')}
            </button>
        </>
    );
}

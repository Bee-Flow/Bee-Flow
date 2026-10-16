import { ShieldAlert } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { BTN } from './constants';

interface CreatedResultModalProps {
    title: ReactNode;
    warning?: string;
    onOpen: () => void;
    t: TranslateFn;
}

export default function CreatedResultModal({ title, warning, onOpen, t }: CreatedResultModalProps) {
    return (
        <Modal
            open
            onClose={onOpen}
            title={title}
            size="md"
            className="sm:max-w-[520px]"
        >
            <div className="space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">
                    {t('datatables.created_managed', 'Automations can now point their “remember answers in a table” tick at it.')}
                </p>
                {/* VERBATIM. The server owns this sentence so it stays true
                    when the storage does; paraphrasing it here is how a
                    warning about plaintext survives a change that made it
                    wrong. */}
                {warning && (
                    <p className="text-xs px-3 py-2 rounded-lg flex items-start gap-2 bg-[var(--bg-primary)] text-[var(--text-primary)]">
                        <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                        <span>{warning}</span>
                    </p>
                )}
                <div className="flex justify-end">
                    <button type="button" onClick={onOpen}
                        className={`${BTN} font-medium`}
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.created_open', 'Open the table')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

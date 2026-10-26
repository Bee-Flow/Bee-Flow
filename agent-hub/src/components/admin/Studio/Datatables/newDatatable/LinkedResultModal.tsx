import { ShieldAlert } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import Modal from '@/components/shared/Modal';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import { BTN } from './constants';

interface LinkedResultModalProps {
    title: ReactNode;
    body: ReactNode;
    warnings: string[];
    onOpen: () => void;
    t: TranslateFn;
}

export default function LinkedResultModal({ title, body, warnings, onOpen, t }: LinkedResultModalProps) {
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
                    {body}
                </p>
                {/* VERBATIM, like the managed warning: the server owns these sentences. */}
                {warnings.map((w, i) => (
                    <p key={i} className="text-xs px-3 py-2 rounded-lg flex items-start gap-2 bg-[var(--bg-primary)] text-[var(--text-primary)]">
                        <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0 [color:var(--warning)]" aria-hidden="true" />
                        <span>{w}</span>
                    </p>
                ))}
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

// The keyboard shortcuts of the designed-document editor, as a sheet.

import React from 'react';
import Modal from '../../../components/shared/Modal';
import useTranslation from '../../../hooks/useTranslation';

const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

export default function DocumentShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const mod = APPLE ? '⌘' : 'Ctrl';
    const rows: Array<[string, string]> = [
        [`${mod} S`, t('documents.shortcuts.save', 'Save now')],
        [`${mod} F`, t('documents.shortcuts.find', 'Find in the document')],
        [`${mod} ⇧ H`, t('documents.shortcuts.history', 'Version history')],
        [`${mod} ${APPLE ? '⌥' : 'Alt'} M`, t('documents.shortcuts.comment', 'Comment on the selection')],
        [`${mod} /`, t('documents.shortcuts.help', 'This list')],
        ['Esc', t('documents.shortcuts.escape', 'Close find, or stop editing')],
    ];
    return (
        <Modal open={open} onClose={onClose} title={t('documents.shortcuts.title', 'Keyboard shortcuts')} size="sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]" data-testid="document-shortcuts">
                {rows.map(([keys, what]) => (
                    <React.Fragment key={keys}>
                        <dt><kbd className="px-1.5 py-0.5 rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] font-mono text-[11px]">{keys}</kbd></dt>
                        <dd className="m-0 text-[var(--text-secondary)]">{what}</dd>
                    </React.Fragment>
                ))}
            </dl>
        </Modal>
    );
}

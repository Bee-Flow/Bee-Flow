import { X } from 'lucide-react';
import React from 'react';
import AddPartsPanel, { type AddPartsPanelProps } from './AddPartsPanel';
import Modal from '../../../shared/Modal';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * "Add to this Solution" as a right-hand sheet. Modal owns the focus trap, Escape,
 * focus restore and the dim; on a phone the panel is the whole screen. The panel
 * inside is mounted only while the drawer is open, so every opening reads the
 * listings anew.
 */

export interface AddPartsDrawerProps extends Omit<AddPartsPanelProps, 'variant' | 'onClose'> {
    open: boolean;
    onClose: () => void;
}

export default function AddPartsDrawer({ open, onClose, ...panel }: AddPartsDrawerProps) {
    const { t } = useTranslation();
    return (
        <Modal
            open={open}
            onClose={onClose}
            placement="right"
            size="lg"
            title={t('solutions.add_panel_title', 'Add to this Solution')}
            headerActions={(
                <button type="button" onClick={onClose} aria-label={t('solutions.add_panel_close', 'Close')} data-testid="add-parts-close"
                        className="inline-flex items-center justify-center w-11 h-11 -m-2 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            )}
            className="!rounded-none sm:!rounded-l-xl"
            data-testid="add-parts-drawer"
        >
            <AddPartsPanel {...panel} variant="drawer" onClose={onClose} />
        </Modal>
    );
}

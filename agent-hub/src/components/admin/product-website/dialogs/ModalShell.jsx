import React from 'react';
import Modal from '../../../shared/Modal';

/**
 * ModalShell — the ONE dialog container for the CMS admin, drawn inside the
 * shared Modal.
 *
 * Modal owns the portal, the backdrop, Escape, `aria-modal` and the focus:
 * Tab stays inside, and closing puts the focus back on what opened it. A
 * child's `autoFocus` still lands where it did as long as it is the first
 * control in the dialog (every caller today); a dialog that focuses a later
 * control does it from its own effect, as AddBlockDialog does, which runs
 * after Modal's.
 *
 * What stays here is the CMS card: its surface, its width presets and its
 * internal scroll. A press inside the card stops at the card, as it always
 * did, so the editor's outside-press handlers behind it never see it.
 *
 * Grown out of PageList's local ModalOverlay (SaveTemplateDialog /
 * TemplatesManagerDialog) — same markup, plus width presets.
 *
 * Props:
 *   onClose    — called on Escape / backdrop press
 *   labelledBy — id of the dialog's heading element
 *   width      — 'sm' | 'md' | 'lg' (default 'md'): max-w-sm, max-w-md and
 *                max-w-2xl, which are exactly Modal's own sm/md/lg presets
 */

const WIDTHS = new Set(['sm', 'md', 'lg']);

export default function ModalShell({ children, onClose, labelledBy, width = 'md' }) {
    return (
        <Modal
            open
            onClose={() => onClose?.()}
            labelledBy={labelledBy}
            size={WIDTHS.has(width) ? width : 'md'}
            variant="bare"
            zIndex={1100}
        >
            {/* No my-8 any more: it gave the card room in the old scrolling,
                top-aligned overlay. Modal centres it, and a margin inside the
                panel would be a band beside the card that no longer closes. */}
            <div
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-xl max-h-[calc(100vh-4rem)] overflow-y-auto"
                onMouseDown={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </Modal>
    );
}

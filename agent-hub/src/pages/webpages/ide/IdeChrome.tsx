import { AlertCircle, FileImage, type LucideIcon } from 'lucide-react';
import type { KeyboardEventHandler, MouseEventHandler } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { formatBytes } from '../webpageCodeFiles';

/**
 * Accessible resize separator. A focusable divider with the correct ARIA role
 * and a visible hover/focus affordance (the bare 1px strips were invisible and
 * keyboard-inaccessible). `orientation` = 'vertical' for column resizers.
 */
export function ResizeHandle({ orientation, onMouseDown, onKeyDown, label }: {
    orientation: 'vertical' | 'horizontal';
    onMouseDown: MouseEventHandler<HTMLDivElement>;
    onKeyDown: KeyboardEventHandler<HTMLDivElement>;
    label: string;
}) {
    const vertical = orientation === 'vertical';
    return (
        <div
            role="separator"
            aria-orientation={orientation}
            aria-label={label}
            tabIndex={0}
            onMouseDown={onMouseDown}
            onKeyDown={onKeyDown}
            className={`shrink-0 group/handle ${vertical ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'} focus:outline-none`}
            style={{ background: 'var(--vsc-border)', transition: 'background 0.12s' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-primary)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--vsc-border)')}
            onFocus={(e) => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-primary)')}
            onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
        />
    );
}

/** Slim button used in the IDE top bar. */
export function IdeBarButton({ Icon, label, onClick, active, title }: {
    Icon: LucideIcon;
    label?: string;
    onClick?: () => void;
    active?: boolean;
    title?: string;
}) {
    // Only genuine toggles (active is a boolean) get aria-pressed — plain
    // action buttons (ZIP, History, Upload) leave it unset.
    const isToggle = typeof active === 'boolean';
    return (
        <button
            type="button"
            onClick={onClick}
            title={title || label}
            aria-label={title || label}
            aria-pressed={isToggle ? active : undefined}
            className="px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors"
            style={{ color: active ? 'var(--vsc-fg)' : 'var(--vsc-fg-muted)', background: active ? 'var(--vsc-hover-bg)' : 'transparent' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vsc-hover-bg)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = active ? 'var(--vsc-hover-bg)' : 'transparent')}
        >
            <Icon size={13} />
            {label && <span>{label}</span>}
        </button>
    );
}

/**
 * Binary-file placeholder shown in place of Monaco when a non-text extra is
 * opened. Images render inline from their data URL; everything else gets
 * a generic file card with the size + mime type.
 */
export function BinaryPreview({ path, mimeType, dataUrl, size }: {
    path: string;
    mimeType?: string;
    dataUrl?: string;
    size: number;
}) {
    const { t } = useTranslation();
    const isImage = mimeType?.startsWith('image/');
    // The same measure as the file strip — one formatting rule for bytes, so
    // the same file does not get a different number in two places.
    const shown = formatBytes(size);
    return (
        <div className="flex flex-col items-center justify-center h-full w-full p-6 bg-[var(--vsc-editor-bg)] text-[var(--vsc-fg-muted)]">
            {isImage && dataUrl ? (
                <img
                    src={dataUrl}
                    alt={path}
                    style={{ maxWidth: '100%', maxHeight: '70%', objectFit: 'contain', border: '1px solid var(--vsc-border)' }}
                />
            ) : (
                <FileImage size={48} style={{ opacity: 0.5 }} />
            )}
            <div className="text-[12px] mt-3 font-mono">{path}</div>
            <div className="text-[11px] mt-1">{mimeType || 'application/octet-stream'}{shown ? ` · ${shown}` : ''}</div>
            <div className="text-[11px] mt-3 max-w-md text-center" style={{ opacity: 0.7 }}>
                {t('webpages.ide.binary_not_editable', "Binary files aren't editable in the text editor. Ask the AI to replace this asset, or delete and re-upload.")}
            </div>
        </div>
    );
}

/** An extra file whose content has not arrived yet. */
export function MissingFile({ path }: { path: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-[12px] text-[var(--vsc-fg-muted)]">
            <AlertCircle size={32} style={{ opacity: 0.5 }} />
            <div className="mt-3 font-mono">{path}</div>
            <div className="mt-1">{t('webpages.ide.file_not_loaded', 'File content not loaded yet.')}</div>
        </div>
    );
}

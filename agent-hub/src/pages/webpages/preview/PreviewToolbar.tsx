import { ExternalLink, Monitor, RefreshCw, Shield, Smartphone, type LucideIcon } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';

export type PreviewDevice = 'desktop' | 'mobile';

/** One half of the monitor/phone toggle: a radio, not a button that guesses. */
function DeviceButton({ icon: Icon, value, active, label, onPick }: {
    icon: LucideIcon;
    value: PreviewDevice;
    active: boolean;
    label: string;
    onPick: (value: PreviewDevice) => void;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onPick(value)}
            title={label}
            aria-label={label}
            data-testid={`preview-device-${value}`}
            className="grid place-items-center w-6 h-6 rounded transition-colors"
            style={{
                color: active ? 'var(--vsc-fg)' : 'var(--vsc-fg-muted)',
                background: active ? 'var(--vsc-hover-bg)' : 'transparent',
            }}
        >
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
    );
}

/** A plain toolbar action (Reload / Open). */
function ToolbarAction({ Icon, label, title, onClick }: { Icon: LucideIcon; label: string; title: string; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="px-2 py-0.5 rounded text-[11px] flex items-center gap-1 transition-colors [color:var(--vsc-fg)]!"
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--vsc-hover-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            title={title}
        >
            <Icon className="w-3 h-3" /> {label}
        </button>
    );
}

interface PreviewToolbarProps {
    size: { w: number; h: number } | null;
    device: PreviewDevice;
    onDevice: (device: PreviewDevice) => void;
    onReload: () => void;
    onOpen: () => void;
}

/** The preview's toolbar: title, shield, measured size, device toggle, reload and open. */
export default function PreviewToolbar({ size, device, onDevice, onReload, onOpen }: PreviewToolbarProps) {
    const { t } = useTranslation();
    return (
        <div className="shrink-0 px-3 py-1.5 border-b flex items-center justify-between gap-2 border-[var(--vsc-border)]">
            <div className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-wider [color:var(--vsc-fg-muted)]! [letter-spacing:0.06em]">
                    {t('webpages.preview.title', 'Preview')}
                </span>
                {/* What the shield claims is exactly what the iframe does:
                    sandbox="allow-scripts allow-forms" with NO
                    allow-same-origin (see WebpagePreview). If that ever
                    changes, this wording has to change with it. */}
                <span
                    className="inline-flex items-center gap-1 text-[10px] text-[var(--vsc-fg-muted)]"
                    data-testid="preview-shield"
                    title={t('webpages.preview.shielded_hint', 'The page runs in an isolated frame: it cannot reach your session, your cookies, or the app around it.')}
                >
                    <Shield className="w-3 h-3" aria-hidden="true" />
                    {t('webpages.preview.shielded', 'Running shielded')}
                </span>
                {/* Measured, never declared — see useMeasuredSize. Absent
                    when it cannot be measured. */}
                {size && (
                    <span
                        className="text-[10px] tabular-nums [color:var(--vsc-fg-muted)]! [opacity:0.7]"
                        data-testid="preview-size"
                    >
                        {size.w} × {size.h}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-1">
                <div className="flex items-center mr-1" role="radiogroup" aria-label={t('webpages.preview.device', 'Preview width')}>
                    <DeviceButton
                        icon={Monitor} value="desktop" active={device === 'desktop'}
                        label={t('webpages.preview.desktop', 'Desktop')} onPick={onDevice}
                    />
                    <DeviceButton
                        icon={Smartphone} value="mobile" active={device === 'mobile'}
                        label={t('webpages.preview.mobile', 'Mobile')} onPick={onDevice}
                    />
                </div>
                <ToolbarAction Icon={RefreshCw} label={t('webpages.preview.reload', 'Reload')} title={t('webpages.preview.reload_hint', 'Reload preview')} onClick={onReload} />
                <ToolbarAction Icon={ExternalLink} label={t('webpages.preview.open', 'Open')} title={t('webpages.preview.open_hint', 'Open preview in a new tab')} onClick={onOpen} />
            </div>
        </div>
    );
}

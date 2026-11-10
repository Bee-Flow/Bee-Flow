import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Monitor, Smartphone, Tablet } from 'lucide-react';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useTranslation from '@/hooks/useTranslation';
import { setCanvasBreakpoint, useCanvasBreakpoint } from './canvasBreakpoint';
import type { Breakpoint } from '../runtime/styleResolver';

/**
 * The screen-size switch in the corner of the edit canvas: Desktop, Tablet, Phone.
 *
 * It decides which width a drag of the width grip writes (span, spanMd or spanSm) and makes
 * the cells show the width they have at that size. It does not resize the canvas: the real
 * thing at a real width is the Preview. Leaving the editor puts it back on Desktop, so the
 * next app opens the way the canvas always has.
 */
export default function BreakpointSwitch({ disabled = false }: { disabled?: boolean }) {
    const { t } = useTranslation();
    const breakpoint = useCanvasBreakpoint();
    useEffect(() => () => setCanvasBreakpoint('lg'), []);
    const options: { value: Breakpoint; label: string; icon: ReactNode }[] = [
        { value: 'lg', label: t('studio_apps_layout.breakpoint.lg', 'Desktop'), icon: <Monitor className="h-3.5 w-3.5" /> },
        { value: 'md', label: t('studio_apps_layout.breakpoint.md', 'Tablet'), icon: <Tablet className="h-3.5 w-3.5" /> },
        { value: 'sm', label: t('studio_apps_layout.breakpoint.sm', 'Phone'), icon: <Smartphone className="h-3.5 w-3.5" /> },
    ];
    return (
        <div
            className="pointer-events-auto rounded-lg shadow-sm bg-[var(--bg-primary)]"
            data-testid="canvas-breakpoint-switch"
            title={t('studio_apps_layout.breakpoint.hint', 'Which screen size the widths you drag are for. Preview shows the real result.')}
        >
            <SegmentedControl
                value={breakpoint}
                onChange={setCanvasBreakpoint}
                options={options}
                size="sm"
                disabled={disabled}
                ariaLabel={t('studio_apps_layout.breakpoint.label', 'Arrange widths for')}
            />
        </div>
    );
}

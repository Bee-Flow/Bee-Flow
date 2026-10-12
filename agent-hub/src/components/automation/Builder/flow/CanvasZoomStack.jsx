import { useReactFlow, useStore } from '@xyflow/react';
import { Plus, Minus, Maximize, Maximize2, Minimize2, Rows3, Presentation } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { toggleCanvasFullscreen, useStudioMenuHidden } from '../../../../hooks/useStudioChrome';

/**
 * The zoom stack in the canvas's south-west zone (design 1a): zoom in, zoom
 * out, the current percentage, fit — and "Wrap to fit", which is the same
 * kind of act as fitView (one press to get the canvas back on screen) and so
 * lives in the same stack as an icon with no label of its own.
 *
 * Replaces React Flow's own <Controls>, which cannot show a percentage. The
 * percentage is read as a rounded integer from the store, so it re-renders
 * only when the displayed number changes, not on every pan frame.
 *
 * `onFit`, when given, IS the Fit button's act. While the assistant builds, a
 * gesture on the canvas takes the camera away from the build; Fit is "show me
 * everything again", which is also the moment to hand the camera back — so the
 * same press re-arms following without a second control. The hand-back takes
 * its own wide shot, and a second fit from here on top of it read as one move
 * stumbling into another (and, unowned, as the presenter taking the camera
 * straight back). Without `onFit` the stack fits on its own, as it always has.
 *
 * `onTogglePresenter`, when given, adds the presenter-mode switch (flow/
 * presenterMode.js) at the foot of the stack — bigger text and tighter shots
 * for a projector. It is a zoom concern (it moves the LOD breaks), so it lives
 * with the zoom controls; `presenter` is its pressed state. Shift+P, and P
 * with nothing selected, do the same (DiagramPane).
 *
 * `compact` (a short canvas: the step drawer open on a laptop screen) lays
 * the stack down as one row, − 100% + fit, 30px tall instead of 182px, and
 * leaves out Wrap to fit and the presenter switch: whole-canvas acts that
 * wait until the drawer closes.
 */
const selectPct = (s) => Math.round((s?.transform?.[2] ?? 1) * 100);

const btn = 'w-[30px] h-[30px] grid place-items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed';
const sep = 'border-t border-[var(--border-default)]';
const sepRow = 'border-l border-[var(--border-default)]';

export default function CanvasZoomStack({ onWrapToFit = null, onFit = null, presenter = false, onTogglePresenter = null, compact = false }) {
    const { t } = useTranslation();
    const rf = useReactFlow();
    const pct = useStore(selectPct);
    const fullscreen = useStudioMenuHidden();
    const zoom = (dir) => {
        try { dir > 0 ? rf.zoomIn({ duration: 200 }) : rf.zoomOut({ duration: 200 }); } catch { /* canvas gone */ }
    };
    const fit = () => {
        if (onFit) { onFit(); return; }
        try { rf.fitView({ padding: 0.08, duration: 300 }); } catch { /* canvas gone */ }
    };
    // Each control takes the separator class its place in the stack gives it.
    const zoomIn = (cls) => (
        <button key="in" type="button" onClick={() => zoom(1)} className={`${btn} ${cls}`} title={t('automations.canvas.zoom_in', 'Zoom in')} aria-label={t('automations.canvas.zoom_in', 'Zoom in')}>
            <Plus size={14} />
        </button>
    );
    const zoomOut = (cls) => (
        <button key="out" type="button" onClick={() => zoom(-1)} className={`${btn} ${cls}`} title={t('automations.canvas.zoom_out', 'Zoom out')} aria-label={t('automations.canvas.zoom_out', 'Zoom out')}>
            <Minus size={14} />
        </button>
    );
    const zoomPct = (cls) => (
        <button
            key="pct"
            type="button"
            onClick={() => { try { rf.zoomTo(1, { duration: 200 }); } catch { /* canvas gone */ } }}
            className={`${btn} ${cls} text-[10px] font-semibold tabular-nums !text-[var(--text-primary)]`}
            title={t('automations.canvas.zoom_reset', 'Zoom to 100%')}
            aria-label={t('automations.canvas.zoom_reset', 'Zoom to 100%')}
            data-testid="canvas-zoom-pct"
        >
            {pct}%
        </button>
    );
    const fitBtn = (cls) => (
        <button key="fit" type="button" onClick={fit} className={`${btn} ${cls}`} title={t('automations.canvas.zoom_fit', 'Fit the whole flow on screen')} aria-label={t('automations.canvas.zoom_fit', 'Fit the whole flow on screen')}>
            <Maximize size={14} />
        </button>
    );
    const wrapBtn = (cls) => (
        <button
            key="wrap"
            type="button"
            onClick={onWrapToFit}
            className={`${btn} ${cls}`}
            title={t('automations.canvas_zoom_stack.wrap_the_flow_into_rows_that', 'Wrap the flow into rows that fit the screen (Ctrl+Z undoes it)')}
            aria-label={t('automations.canvas_zoom_stack.wrap_to_fit', 'Wrap to fit')}
        >
            <Rows3 size={14} />
        </button>
    );
    const presenterBtn = (cls) => (
        <button
            key="presenter"
            type="button"
            onClick={onTogglePresenter}
            aria-pressed={!!presenter}
            className={`${btn} ${cls} ${presenter ? '!text-[var(--text-primary)] bg-[var(--bg-tertiary)]' : ''}`}
            title={t('automations.canvas.present.hint', 'Bigger cards and text for a projector — P')}
            aria-label={presenter ? t('automations.canvas.present.off', 'Leave presenter mode') : t('automations.canvas.present.on', 'Presenter mode')}
            data-testid="canvas-presenter-toggle"
        >
            <Presentation size={14} />
        </button>
    );
    const fullscreenBtn = (cls) => (
        <button
            key="fullscreen"
            type="button"
            onClick={toggleCanvasFullscreen}
            aria-pressed={fullscreen}
            className={`${btn} ${cls} ${fullscreen ? '!text-[var(--text-primary)] bg-[var(--bg-tertiary)]' : ''}`}
            title={fullscreen ? t('automations.canvas.fullscreen_off', 'Leave fullscreen') : t('automations.canvas.fullscreen_on', 'Canvas fullscreen')}
            aria-label={fullscreen ? t('automations.canvas.fullscreen_off', 'Leave fullscreen') : t('automations.canvas.fullscreen_on', 'Canvas fullscreen')}
            data-testid="canvas-fullscreen-toggle"
        >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
    );
    const controls = compact
        ? [zoomOut, zoomPct, zoomIn, fitBtn, fullscreenBtn]
        : [zoomIn, zoomOut, zoomPct, fitBtn, fullscreenBtn, ...(onWrapToFit ? [wrapBtn] : []), ...(onTogglePresenter ? [presenterBtn] : [])];
    const between = compact ? sepRow : sep;
    return (
        <div
            className={`flex ${compact ? 'flex-row' : 'flex-col'} rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm overflow-hidden`}
            data-testid="canvas-zoom-stack"
            data-compact={compact ? '' : undefined}
        >
            {controls.map((control, i) => control(i > 0 ? between : ''))}
        </div>
    );
}

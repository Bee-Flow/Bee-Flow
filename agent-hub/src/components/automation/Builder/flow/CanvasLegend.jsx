import React from 'react';
import { CircleHelp } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import { typeColorVar, typeTint } from './nodeTypeColors';

/**
 * The legend in the canvas's north-east zone (design 1a): what the marks on
 * the lines mean. The cheapest explanation in the whole builder — four rows,
 * 232px wide, one click away behind the help button.
 */
export function LegendToggle({ open, onToggle }) {
    const { t } = useTranslation();
    const label = t('routines.canvas.legend_toggle', 'What the marks on the canvas mean');
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={!!open}
            aria-label={label}
            title={label}
            className={`w-[30px] h-[30px] rounded-lg grid place-items-center border shadow-sm ${
                open
                    ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-[var(--border-default)]'
                    : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border-[var(--border-default)] hover:text-[var(--text-primary)]'
            }`}
        >
            <CircleHelp size={15} />
        </button>
    );
}

export default function CanvasLegend() {
    const { t } = useTranslation();
    const row = 'flex items-center gap-2';
    return (
        <div
            className="w-[232px] px-3 py-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)] flex flex-col gap-2"
            style={{ boxShadow: 'var(--shadow-popover)' }}
            data-testid="canvas-legend"
        >
            <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--text-tertiary)]">
                {t('routines.canvas.legend_title', 'Legend')}
            </div>
            <div className={row}>
                <span className="px-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] font-semibold text-[var(--text-primary)] whitespace-nowrap">1 record</span>
                <span>{t('routines.canvas.legend_data', 'data that travels down the line')}</span>
            </div>
            <div className={row}>
                <span className="px-1.5 rounded-full font-semibold whitespace-nowrap" style={{ background: typeTint('branch', 16), color: typeColorVar('branch') }}>match</span>
                <span>{t('routines.canvas.legend_branch', 'a branch label — the run follows labels only')}</span>
            </div>
            <div className={row}>
                <span className="w-5 shrink-0 border-t-2 border-dashed border-[var(--text-tertiary)]" aria-hidden="true" />
                <span>{t('routines.canvas.legend_wrap', 'the line back to the start of the next row')}</span>
            </div>
            <div className={row}>
                <span className="w-5 shrink-0 border-t-2" style={{ borderColor: 'var(--error)' }} aria-hidden="true" />
                <span>{t('routines.canvas.legend_pii', 'a line carrying personal data')}</span>
            </div>
            <div className={row}>
                <span
                    className="w-4 h-2 shrink-0"
                    style={{ borderRadius: '0 0 8px 8px', background: typeTint('ai', 30), border: `1px solid ${typeColorVar('ai')}`, borderTop: 0 }}
                    aria-hidden="true"
                />
                <span>{t('routines.canvas.legend_tool', "an AI step's tool port")}</span>
            </div>
        </div>
    );
}

import React from 'react';
import type { CSSProperties } from 'react';
import { StepIcon } from '../stepIcons';
import { describeStepResult } from '../stepResultChip';
import useTranslation from '@/hooks/useTranslation';
import type { NodeRunStep } from './nodeProps';
import type { CardText } from './StepNodeBase.types';

/** A summary line's text and tone: a string, a React node, or `{ muted }`; null when empty. */
function summaryLine(value: CardText) {
    if (value == null || value === '') return null;
    const muted = typeof value === 'object' && !React.isValidElement(value) && 'muted' in value;
    const text = muted ? value.muted : value;
    return text == null || text === '' ? null : { text, muted };
}

interface StepNodeTileProps {
    icon: React.ReactNode;
    customIconName: string | null | undefined;
    glyphSize: number;
    tileStyle: CSSProperties;
    glyphStyle: CSSProperties;
    onTileClick: ((e: React.MouseEvent<HTMLButtonElement>) => void) | null;
    tileLabel: string | null;
}

/**
 * The icon tile. A button when the type has something to do with it (a
 * container expands from here — the 72px card has no room for a separate
 * chevron).
 */
export function StepNodeTile({ icon, customIconName, glyphSize, tileStyle, glyphStyle, onTileClick, tileLabel }: StepNodeTileProps) {
    const glyph = customIconName
        ? <StepIcon name={customIconName} size={glyphSize} fallback={icon} />
        : (React.isValidElement(icon) ? React.cloneElement(icon as React.ReactElement<{ size?: number }>, { size: glyphSize }) : icon);
    if (onTileClick) {
        return (
            <button
                type="button"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onTileClick(e); }}
                onMouseDown={(e: React.MouseEvent<HTMLButtonElement>) => e.stopPropagation()}
                aria-label={tileLabel || 'Expand'}
                title={tileLabel || 'Expand'}
                className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-primary)]"
                style={tileStyle}
            >
                <span style={glyphStyle}>{glyph}</span>
            </button>
        );
    }
    return (
        <span style={tileStyle} aria-hidden="true">
            <span style={glyphStyle}>{glyph}</span>
        </span>
    );
}

interface StepNodeTextProps {
    far: boolean;
    near: boolean;
    name: React.ReactNode;
    typeLabel: string | null;
    help: string | null;
    body: React.ReactNode;
    sub: CardText;
    subTitle: string | undefined;
    subDetail: CardText;
    runStep: NodeRunStep | null | undefined;
    stepNumber: number | string | null | undefined;
    isSource: boolean;
    familyColor: string;
    touchedAt: number | undefined;
}

/** The text column of the card: name, summary line, optional second line and result chip, by zoom level. */
export function StepNodeText({
    far, near, name, typeLabel, help, body, sub, subTitle, subDetail, runStep, stepNumber, isSource, familyColor, touchedAt,
}: StepNodeTextProps) {
    const { t } = useTranslation();
    // What the step PRODUCED, once its row has settled (flow/stepResultChip.js):
    // "3 items", "done", "failed". Sits at the head of the summary line at mid
    // and near LOD — the card keeps its 72px, the summary truncates beside it.
    // Null while running (the badge already says so) and with no row at all,
    // so a card without a run renders exactly as before.
    const resultText = describeStepResult(runStep, t);
    // Keyed on its text: a new result remounts the chip and its wipe plays
    // again (`.bf-result-chip`, index.css). Wraps the summary line in a row
    // only when there IS a chip, so the card's markup is untouched otherwise.
    const resultChip = resultText ? (
        <span
            key={resultText}
            className="bf-result-chip shrink-0 text-[10px] leading-[14px] font-semibold tabular-nums whitespace-nowrap text-[var(--text-tertiary)]"
            data-testid="node-result-chip"
        >
            {resultText}
        </span>
    ) : null;
    const withResultChip = (subEl: React.ReactNode) => (resultChip
        ? <div className="flex items-baseline gap-1.5 min-w-0" data-testid="node-sub-row">{resultChip}{subEl}</div>
        : subEl);

    const subIsMuted = sub != null && typeof sub === 'object' && !React.isValidElement(sub) && 'muted' in sub;
    const subText = subIsMuted ? sub.muted : sub;
    const detail = summaryLine(subDetail);
    const nameClamp = detail ? 'line-clamp-1' : 'line-clamp-2';
    const detailLine = (size: string) => (detail ? (
        <div
            className={`${size} leading-[14px] truncate ${detail.muted ? 'italic text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}
            title={subTitle || (typeof detail.text === 'string' ? detail.text : undefined)}
            data-testid="node-sub-detail"
        >
            {detail.text}
        </div>
    ) : null);

    return (
        <div
            className="flex-1 min-w-0 flex flex-col gap-px"
            // Native, so it cannot cover the neighbouring cards or the
            // action chrome. The step's own editor says it properly.
            title={[typeLabel, help].filter(Boolean).join(' — ') || undefined}
        >
            {body && name == null ? (
                <div className="text-xs text-[var(--text-primary)] leading-snug min-w-0">{body}</div>
            ) : far ? (
                // Zoomed right out: the NAME, big enough to read at 30%, on up
                // to two lines. Design 1g showed the family word here; the tile's
                // colour and glyph already say that, and a title you cannot read
                // is what the user finds first (feedback 2026-09-03).
                <div
                    className="text-[22px] font-bold leading-[24px] text-[var(--text-primary)] line-clamp-2 break-words"
                    title={typeLabel || undefined}
                    data-testid="node-far-label"
                >
                    {name ?? typeLabel}
                    {stepNumber != null && <span className="ml-2 text-[14px] font-medium text-[var(--text-tertiary)]">{stepNumber}</span>}
                </div>
            ) : !near ? (
                // Middle distance: the name on up to two lines, the number to
                // find it by, and the description in one line beneath.
                <>
                    <div className={`text-[16px] font-semibold leading-5 text-[var(--text-primary)] ${nameClamp} break-words`} data-testid="node-name">
                        {name ?? typeLabel}
                        {stepNumber != null && <span className="ml-2 text-[12px] font-medium text-[var(--text-tertiary)]" data-testid="node-step-number">{stepNumber}</span>}
                    </div>
                    {(resultChip || (subText != null && subText !== '')) && withResultChip(
                        subText != null && subText !== '' ? (
                            <div className={`text-[12px] leading-[14px] truncate ${subIsMuted ? 'italic text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`} data-testid="node-sub">
                                {subText}
                            </div>
                        ) : null,
                    )}
                    {detailLine('text-[12px]')}
                </>
            ) : (
                <>
                    {(typeLabel || stepNumber != null) && (
                        <div className="flex items-center gap-1.5 text-[10px] leading-3 font-semibold uppercase tracking-[.06em] whitespace-nowrap overflow-hidden">
                            {typeLabel && <span className="truncate" style={{ color: familyColor }}>{typeLabel}</span>}
                            {stepNumber != null && <span className="shrink-0 text-[var(--text-tertiary)]" data-testid="node-step-number">· {stepNumber}</span>}
                            {isSource && <span className="shrink-0 text-[var(--text-tertiary)]" data-testid="node-source-tag">· {t('automations.card.source', 'source')}</span>}
                        </div>
                    )}
                    <div className={`text-[13px] font-semibold leading-[17px] text-[var(--text-primary)] ${nameClamp} break-words`} data-testid="node-name">
                        {name ?? typeLabel}
                    </div>
                    {(resultChip || (subText != null && subText !== '')) && withResultChip(
                        subText != null && subText !== '' ? (
                            // `bf-rv-sub` is the wipe-in hook for the build
                            // choreography ("inputs filling in"), near LOD only —
                            // further out the whole card fades instead. Keyed on
                            // the touch time so a second edit remounts the line
                            // and the wipe plays again.
                            <div
                                key={touchedAt ?? 'sub'}
                                className={`bf-rv-sub text-[11px] leading-[14px] truncate ${subIsMuted ? 'italic text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}
                                title={subTitle || (typeof subText === 'string' ? subText : undefined)}
                                data-testid="node-sub"
                            >
                                {subText}
                            </div>
                        ) : null,
                    )}
                    {detailLine('text-[11px]')}
                </>
            )}
        </div>
    );
}

import React from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { TONES } from '@/components/shared/statusTone';
import { kindTileStyle } from '@/components/shared/kindColors';
import { heroCard, stagePadding, stageType, WIDTH } from './stageChrome';

/**
 * The frame every phase is drawn in.
 *
 * One width, one padding pair, one header, one card, one type scale — and the
 * status line inside a live region, which only the fill phase had. Before this,
 * walking the eight phases moved the content column between 560, full-bleed,
 * 780 and 980 and the top margin between 10 and 40 pixels.
 *
 *   kind      the kind key the tile borrows (recipes.phaseKind)
 *   icon      the glyph, a lucide component
 *   width     'narrow' | 'default' | 'wide'
 *   status    the one line under the title that says what is happening
 *   tone      'busy' | 'ok' | 'warn' | 'error' — colours the status line only
 */
type StageTone = 'busy' | 'ok' | 'warn' | 'error';

interface StageHeaderProps {
    kind?: string;
    icon?: LucideIcon | null;
    title?: ReactNode;
    subtitle?: ReactNode;
    status?: ReactNode;
    tone?: StageTone;
    presenter?: boolean;
    actions?: ReactNode;
}

interface StageShellProps extends StageHeaderProps {
    width?: 'narrow' | 'default' | 'wide' | 'full';
    testId?: string | null;
    phaseKey?: string | null;
    card?: boolean;
    children?: ReactNode;
}

const STATUS_INK: Record<StageTone, string> = {
    busy: 'var(--text-secondary)',
    ok: 'var(--text-secondary)',
    warn: TONES.warning.ink,
    error: TONES.error.ink,
};

/**
 * The header on its own, for the one stage that cannot live inside the shell's
 * scroll container: the fill phase is a flex column whose canvas fills the
 * height. It used to open with a bare 11px uppercase `h3` and no tile at all.
 */
export function StageHeader({ kind = 'playbook', icon: Icon = null, title, subtitle = null, status = null, tone = 'busy', presenter = false, actions = null }: StageHeaderProps) {
    const type = stageType(presenter);
    const { tile, glyph } = kindTileStyle(kind, { size: presenter ? 48 : 40 });
    return (
        <header className="flex items-start gap-3">
            {Icon && <span style={tile}><Icon style={glyph} aria-hidden="true" /></span>}
            <div className="min-w-0 flex-1">
                <h2 className="font-semibold truncate" style={{ fontSize: type.title, color: 'var(--text-primary)' }}>{title}</h2>
                {subtitle && <p style={{ fontSize: type.body, color: 'var(--text-secondary)' }}>{subtitle}</p>}
                {status && (
                    <p
                        className="flex items-center gap-2"
                        role="status"
                        aria-live="polite"
                        style={{ fontSize: type.body, color: STATUS_INK[tone] || STATUS_INK.busy }}
                        data-testid="playbook-stage-status"
                    >
                        {status}
                    </p>
                )}
            </div>
            {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </header>
    );
}

export default function StageShell({
    kind = 'playbook', icon: Icon = null, title, subtitle = null,
    status = null, tone = 'busy', width = 'default', presenter = false,
    testId = null, phaseKey = null, actions = null, card = false, children,
}: StageShellProps) {
    const max = WIDTH[width] === undefined ? WIDTH.default : WIDTH[width];

    return (
        <div
            className="pbk-stage-enter h-full overflow-y-auto"
            style={{ padding: stagePadding(presenter) }}
            data-testid={testId || undefined}
            data-phase={phaseKey || undefined}
        >
            <div className="mx-auto space-y-4" style={max ? { maxWidth: max } : undefined}>
                <StageHeader kind={kind} icon={Icon} title={title} subtitle={subtitle} status={status} tone={tone} presenter={presenter} actions={actions} />
                {card ? <section style={heroCard(presenter)}>{children}</section> : children}
            </div>
        </div>
    );
}

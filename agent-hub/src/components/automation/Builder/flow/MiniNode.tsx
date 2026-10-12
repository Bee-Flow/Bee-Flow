import type { ReactNode } from 'react';
import { Database, GitBranch, Puzzle, Sparkles, Users, Zap } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import { AppGlyph } from './appGlyphs';
import {
    CANVAS_CARD, CANVAS_CARD_COMPACT, CARD_DASHED, EYEBROW, ICON_TILE, ICON_TILE_COMPACT,
    NODE_NAME, NODE_NAME_COMPACT, NODE_SUB, RECORD_PILL, STATUS_PILL, STATUS_PILL_BASE,
    STATUS_PILL_LABEL, STATUS_RING, TRIGGER_RADIUS, familyClasses,
} from './canvasClasses';
import type { MiniFamily, MiniStatus } from './canvasClasses';

export interface MiniNodeProps {
    family: MiniFamily;
    /** The kicker: "TRIGGER · 1". The part before the first " · " takes the family colour. */
    eyebrow?: ReactNode;
    title: ReactNode;
    sub?: ReactNode;
    /** A glyph of your own; wins over `appId` and the family default. */
    icon?: ReactNode;
    /** An integration id; its brand mark goes in the tile (AppGlyph). */
    appId?: string;
    status?: MiniStatus;
    /** A record pill ("412 events"). Inside a MiniFlow it sits on the outgoing connector. */
    pill?: string;
    /** A placeholder card: dashed outline, no family bar. */
    dashed?: boolean;
    compact?: boolean;
    /** The trigger shape (pill-shaped leading edge). Defaults to `family === 'trigger'`. */
    trigger?: boolean;
    /** Extra content under the sub-line: app glyph rows, a toggle, a link. */
    children?: ReactNode;
    testId?: string;
}

const FAMILY_GLYPH: Readonly<Record<MiniFamily, typeof Zap>> = Object.freeze({
    trigger: Zap,
    app: Puzzle,
    ai: Sparkles,
    data: Database,
    branch: GitBranch,
    people: Users,
});

/** The eyebrow, split so the family word is coloured and the rest is tertiary ink. */
function Eyebrow({ eyebrow, textClass }: { eyebrow: ReactNode; textClass: string }) {
    if (typeof eyebrow === 'string') {
        const at = eyebrow.indexOf(' · ');
        const head = at === -1 ? eyebrow : eyebrow.slice(0, at);
        const rest = at === -1 ? '' : eyebrow.slice(at + 3);
        return (
            <div className={EYEBROW} data-testid="mini-node-eyebrow">
                <span className={`truncate ${textClass}`}>{head}</span>
                {rest && <span className="shrink-0 text-[var(--text-tertiary)]">· {rest}</span>}
            </div>
        );
    }
    return <div className={`${EYEBROW} ${textClass}`} data-testid="mini-node-eyebrow">{eyebrow}</div>;
}

/** The card's classes: body, family bar, trigger shape, status chrome, placeholder. */
function cardClass(family: MiniFamily, { compact, trigger, status, dashed }: { compact: boolean; trigger: boolean; status: MiniStatus; dashed: boolean }): string {
    return [
        compact ? CANVAS_CARD_COMPACT : CANVAS_CARD,
        familyClasses(family).bar,
        trigger ? TRIGGER_RADIUS : '',
        STATUS_RING[status] ?? '',
        dashed ? CARD_DASHED : '',
    ].filter(Boolean).join(' ');
}

/** The tile's glyph: your own icon, else the app's mark, else the family's lucide. */
function tileGlyph(family: MiniFamily, icon: ReactNode, appId: string | undefined, size: number): ReactNode {
    if (icon) return icon;
    if (appId) return <AppGlyph integrationId={appId} size={size} />;
    const Glyph = FAMILY_GLYPH[family] ?? Puzzle;
    return <Glyph size={size} aria-hidden="true" />;
}

const present = (v: ReactNode) => v != null && v !== '';

/**
 * A canvas step card outside React Flow (StepNodeBase's near-LOD markup with
 * canvasClasses): the 4px family bar, the icon tile, the eyebrow, the name,
 * a sub-line and the solid status badge in the top-right corner. No handles,
 * no runtime context, so a page can render it anywhere.
 */
export default function MiniNode({
    family, eyebrow, title, sub, icon, appId, status = 'idle', pill, dashed = false,
    compact = false, trigger, children, testId = 'mini-node',
}: MiniNodeProps) {
    const { t } = useTranslation();
    const fam = familyClasses(family);
    const card = cardClass(family, { compact, trigger: trigger ?? family === 'trigger', status, dashed });
    const glyph = tileGlyph(family, icon, appId, compact ? 14 : 16);
    const badge = STATUS_PILL_LABEL[status];

    return (
        <div className={card} data-testid={testId} data-family={family} data-status={status}>
            <span className={`${compact ? ICON_TILE_COMPACT : ICON_TILE} ${fam.tile}`} data-testid="mini-node-tile">
                <span className={`inline-flex ${family === 'branch' ? '-rotate-45' : ''}`}>{glyph}</span>
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-px py-2">
                {present(eyebrow) && <Eyebrow eyebrow={eyebrow} textClass={fam.text} />}
                <div className={compact ? NODE_NAME_COMPACT : NODE_NAME} data-testid="mini-node-name">{title}</div>
                {present(sub) && <div className={NODE_SUB} data-testid="mini-node-sub">{sub}</div>}
                {children}
            </div>
            {badge && (
                <span className={`${STATUS_PILL_BASE} ${STATUS_PILL[status]}`} data-testid="mini-node-status">
                    {t(badge.key, badge.en)}
                </span>
            )}
            {pill && (
                <span className={`absolute -bottom-[9px] right-2.5 ${RECORD_PILL}`} data-testid="mini-node-pill">{pill}</span>
            )}
        </div>
    );
}

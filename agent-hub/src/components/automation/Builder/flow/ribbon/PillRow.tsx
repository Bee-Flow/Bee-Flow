import { Fragment, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import useFitClusters from '../useFitClusters';
import useTranslation from '../../../../../hooks/useTranslation';
import { DropdownPill } from './MenuPanel';
import type { MenuSection } from './menuRows';
import type { OpenState } from './AppCommands';
import type { StepPayload } from './ribbonCategories';

/**
 * One tab of the ribbon as ONE compact row of pills (the Nextcloud apps tab
 * is the model): segments of pills with a thin divider between them, no
 * boxes, no captions. When the row is wider than the ribbon, the last pills
 * fold, one at a time, into a "More" pill at its end (flow/useFitClusters.js
 * measures); the first pill never folds. A folded pill's commands are rows in
 * the More dropdown, under the pill's own name, and its build-film stamps
 * move onto the More pill so a card still departs from where its command is.
 */

type AddFn = (payload: StepPayload) => void;

export interface RowPill {
    key: string;
    node: ReactNode;
    /** The pill's commands as dropdown rows, for "More" while it is folded. */
    fold: MenuSection;
    /** Its `data-ribbon-origin` stamps, which "More" carries while it is folded. */
    origins?: string[];
}

interface Props extends OpenState {
    segments: RowPill[][];
    testId: string;
    /** The row is on screen (it only measures itself then). */
    enabled: boolean;
    onAdd: AddFn;
    /** Stamps the More pill always carries, e.g. `more:Nextcloud`. */
    moreOrigins?: string[];
    /** Shown instead of the row when there is nothing to offer. */
    empty?: string | null;
    /** The More list's filter placeholder (steps by default; the apps tabs fold apps). */
    moreFilterLabel?: ((n: number) => string) | null;
}

const MORE_KEY = '__more';

const Divider = () => <span aria-hidden="true" className="shrink-0 w-px h-5 mx-1 bg-[var(--border-default)]" />;

/** Nested stamps: the build film finds the More pill under every key it stands in for. */
function Stamped({ origins, children }: { origins: string[]; children: ReactNode }) {
    return origins.reduceRight<ReactNode>(
        (inner, origin) => <span data-ribbon-origin={origin} className="inline-flex shrink-0">{inner}</span>,
        children,
    );
}

/** The folded pills' rows, one section per pill name (neighbours with the same name share one). */
function foldSections(pills: RowPill[]): MenuSection[] {
    const out: MenuSection[] = [];
    for (const { fold } of pills) {
        const last = out[out.length - 1];
        if (last && last.title === fold.title) out[out.length - 1] = { ...last, rows: [...last.rows, ...fold.rows] };
        else out.push(fold);
    }
    return out;
}

export default function PillRow({ segments, testId, enabled, onAdd, openKey, setOpenKey, moreOrigins = [], empty = null, moreFilterLabel = null }: Props) {
    const { t } = useTranslation();
    const rowRef = useRef<HTMLDivElement | null>(null);
    const shown = segments.filter(seg => seg.length > 0);
    const count = shown.reduce((n, seg) => n + seg.length, 0);
    // Index ids, not the pills' keys: a key can hold a space (a category
    // name) and useFitClusters splits on spaces. The tab's test id keeps two
    // tabs with as many pills apart. Last pill first; the first never folds.
    const candidates = useMemo(
        () => Array.from({ length: Math.max(0, count - 1) }, (_, i) => `${testId}#${count - 1 - i}`),
        [count, testId],
    );
    const folded = useFitClusters(rowRef, candidates, { enabled: enabled && count > 1 }) as Set<string>;

    if (count === 0) {
        return <div className="text-[12px] text-[var(--text-tertiary)] py-1.5" data-testid={testId}>{empty}</div>;
    }

    let index = 0;
    const foldedPills: RowPill[] = [];
    const visible = shown.map(seg => seg.filter((pill) => {
        const isFolded = folded.has(`${testId}#${index}`);
        index += 1;
        if (isFolded) foldedPills.push(pill);
        return !isFolded;
    })).filter(seg => seg.length > 0);
    const origins = [...new Set([...moreOrigins, ...foldedPills.flatMap(p => p.origins || [])])];
    const names = `${foldedPills.flatMap(p => p.fold.rows.map(r => r.label)).slice(0, 8).join(', ')}.`;

    return (
        // `overflow-x-clip`, not hidden: scrollWidth stays measurable and the
        // spotlight ring on a pill is not cut off vertically.
        <div ref={rowRef} className="flex items-center gap-1 flex-nowrap overflow-x-clip" data-testid={testId} data-ribbon-pill-row="">
            {visible.map((seg, i) => (
                <Fragment key={seg[0].key}>
                    {i > 0 && <Divider />}
                    <div className="shrink-0 flex items-center gap-1">
                        {seg.map(pill => <Fragment key={pill.key}>{pill.node}</Fragment>)}
                    </div>
                </Fragment>
            ))}
            {foldedPills.length > 0 && (
                <>
                    <Divider />
                    <Stamped origins={origins}>
                        <DropdownPill
                            id={MORE_KEY}
                            label={t('automations.ribbon.more', 'More')}
                            glyph={<MoreHorizontal size={14} />}
                            desc={names}
                            tipFooter={t('automations.ribbon.more_hint', 'What did not fit on the ribbon.')}
                            sections={foldSections(foldedPills)}
                            filterLabel={moreFilterLabel || ((n) => t('automations.ribbon.filter_steps', 'Filter {n} steps…', { n }))}
                            onAdd={onAdd}
                            openKey={openKey}
                            setOpenKey={setOpenKey}
                        />
                    </Stamped>
                </>
            )}
        </div>
    );
}

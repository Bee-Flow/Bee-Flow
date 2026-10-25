import { CHROME_H, CHROME_W, NODE_H, NODE_W, classifyInternal, edgeEndpoints } from './sitemapGraph';
import type { InternalEdge, Point } from './sitemapGraph';

/** What an edge click explains: where the link is defined. */
interface EdgeInfo {
    kind: 'chrome' | 'tree' | 'backlink';
    text: string;
}

export interface EdgePopoverState extends Point {
    info: EdgeInfo;
}

interface SitemapEdgesProps {
    canvasWidth: number;
    canvasHeight: number;
    positions: Map<string, Point>;
    chromePos: Point | null;
    chromeTargets: Set<string>;
    chromeSources: Map<string, Array<{ location: string }>>;
    internalEdges: InternalEdge[];
    internalMeta: Map<string, Array<{ blockType?: string; blockId?: string }>>;
    parent: Map<string, string>;
    onEdgeClick: (popover: EdgePopoverState) => void;
}

/** A wide transparent hit line under the visible one, so a thin edge is still clickable. */
function EdgeLine({ ends, onClick, ...visible }: {
    ends: { sx: number; sy: number; ex: number; ey: number };
    onClick: () => void;
    stroke: string;
    strokeWidth: number;
    strokeOpacity?: number;
    strokeDasharray?: string;
    markerEnd: string;
}) {
    const { sx, sy, ex, ey } = ends;
    return (
        <g onClick={onClick} className="[cursor:pointer]">
            <line x1={sx} y1={sy} x2={ex} y2={ey}
                stroke="transparent" strokeWidth={12} />
            <line x1={sx} y1={sy} x2={ex} y2={ey} {...visible} />
        </g>
    );
}

/** The SVG edge layer — sits behind the cards via DOM order. */
export default function SitemapEdges(props: SitemapEdgesProps) {
    const {
        canvasWidth, canvasHeight, positions, chromePos, chromeTargets, chromeSources,
        internalEdges, internalMeta, parent, onEdgeClick,
    } = props;
    return (
        <svg
            width={canvasWidth}
            height={canvasHeight}
            className="[position:absolute] [left:0] [top:0]"
        >
            <defs>
                <marker id="sm-arrow-nav" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill="var(--accent-primary)" />
                </marker>
                <marker id="sm-arrow-internal" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill="var(--text-secondary)" />
                </marker>
                <marker id="sm-arrow-backlink" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill="#f59e0b" />
                </marker>
            </defs>

            {/* NAV edges from the chrome pseudo-node. */}
            {chromePos && Array.from(chromeTargets).map(targetId => {
                const tpos = positions.get(targetId);
                if (!tpos) return null;
                const ends = edgeEndpoints(chromePos.x + CHROME_W / 2, chromePos.y + CHROME_H / 2, CHROME_H, tpos.x + NODE_W / 2, tpos.y + NODE_H / 2, NODE_H);
                const onClick = () => {
                    const srcs = chromeSources.get(targetId) || [];
                    const where = srcs.map(s => s.location).join(' / ');
                    onEdgeClick({
                        x: (ends.sx + ends.ex) / 2,
                        y: (ends.sy + ends.ey) / 2,
                        info: { kind: 'chrome', text: `Defined in ${where || 'site chrome'} — edit it in Site chrome.` },
                    });
                };
                return (
                    <EdgeLine key={`nav-${targetId}`} ends={ends} onClick={onClick}
                        stroke="var(--accent-primary)" strokeWidth={1.75} markerEnd="url(#sm-arrow-nav)" />
                );
            })}

            {/* INTERNAL / BACKLINK edges, page → page. */}
            {internalEdges.map((edge, i) => {
                const s = positions.get(edge.source);
                const t = positions.get(edge.target);
                if (!s || !t) return null;
                const cls = classifyInternal(edge, parent);
                const ends = edgeEndpoints(s.x + NODE_W / 2, s.y + NODE_H / 2, NODE_H, t.x + NODE_W / 2, t.y + NODE_H / 2, NODE_H);
                const blocks = internalMeta.get(`${edge.source}->${edge.target}`) || [];
                const onClick = () => {
                    const where = blocks.length
                        ? `block${blocks.length > 1 ? 's' : ''}: ${blocks.map(b => b.blockType).join(', ')}`
                        : 'block content';
                    onEdgeClick({
                        x: (ends.sx + ends.ex) / 2,
                        y: (ends.sy + ends.ey) / 2,
                        info: { kind: cls, text: `Defined inside ${where} on the source page — edit it from that block.` },
                    });
                };
                return (
                    <EdgeLine key={`int-${i}`} ends={ends} onClick={onClick}
                        stroke={cls === 'tree' ? 'var(--text-secondary)' : '#f59e0b'}
                        strokeWidth={1.5}
                        strokeOpacity={0.85}
                        strokeDasharray={cls === 'tree' ? '6,4' : '2,4'}
                        markerEnd={cls === 'tree' ? 'url(#sm-arrow-internal)' : 'url(#sm-arrow-backlink)'} />
                );
            })}
        </svg>
    );
}

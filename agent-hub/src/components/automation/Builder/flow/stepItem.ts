import type { LucideIcon } from 'lucide-react';
import { nodeLabel, nodeDesc, nodeDefaultLabel } from './nodeDefs';

/**
 * The palette entry of one step type. Split out of stepPalette.ts so the entries
 * that live in their own files (tablePaletteItems.ts) can use it without a cycle.
 *
 * A step's NAME and DESCRIPTION come from flow/nodeDefs.js, which holds the
 * same facts for every node type and is kept exhaustive by a test. The palette
 * owns only what is genuinely a palette concern: the id, the icon, the search
 * keywords and the drop payload.
 *
 * KEYWORDS ARE NOT DECORATION. The ranker matches on them, so every word a node
 * used to be called has to stay: someone who learned "aggregate" or "HTTP
 * request" elsewhere — or here, last month — must still find the node under its
 * plainer name. A rename that dropped them would make a node unfindable by the
 * only word half its users know.
 */
export const stepItem = (kind: string, id: string, icon: LucideIcon, keywords: string, payloadExtra: Record<string, unknown> | null = null) => ({
    id, icon, keywords,
    label: nodeLabel(kind), desc: nodeDesc(kind),
    payload: { kind, label: nodeDefaultLabel(kind), ...payloadExtra },
});

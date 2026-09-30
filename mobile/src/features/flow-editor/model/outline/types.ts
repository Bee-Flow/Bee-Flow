/**
 * The Steps outline's data: one flat list of rows (a FlatList renders it) and
 * the places a new step can go. Built by rows.ts from a definition; nothing
 * here renders.
 *
 * A step is addressed by its id, or — inside a loop body or a parallel
 * branch, which hold steps rather than wiring them — by the path of
 * container ids down to it, joined with the web's INLINE_SEP (`loop_1/ai_2`,
 * as flow/inlineFlowlets.js names an expanded child).
 */

import type { EdgeIdentity } from '..';

/** A step's row of the last test run, as far as a card or its menu reads it. */
export interface RunRow {
    status?: string | null;
    output?: unknown;
}

/** Words a row carries: a translation key with its English, or the author's own text. */
export type RowText =
    | { key: string; fallback: string; params?: Record<string, string | number> }
    | { raw: string };

/** Where a picked step goes. */
export type AddTarget =
    /** Wire it from this node's port (`handle` null: the plain continuation). */
    | { kind: 'after'; sourceId: string; handle: string | null }
    /** Put it ON this edge: source → new → target. */
    | { kind: 'splice'; sourceId: string; targetId: string; identity: EdgeIdentity }
    /** Into a loop body (`branch` null) or one parallel branch, at `index`. */
    | { kind: 'inline'; container: string; branch: number | null; index: number }
    /** Nowhere in particular: a trigger, a note, or a graph with no trigger yet. */
    | { kind: 'root' };

/** The colour a lane header speaks in (the web's port tones). */
export type LaneTone = 'then' | 'else' | 'case' | 'default' | 'error' | 'path';

export type OutlineRow =
    | { kind: 'trigger'; key: string; depth: number; nodeId: string; primary: boolean }
    | {
          kind: 'step';
          key: string;
          depth: number;
          /** The id, or the container path for a held step. */
          address: string;
          nodeId: string;
          /** Held by a loop or a parallel step: no edges of its own. */
          nested: boolean;
      }
    /** The label over one branch of a Condition, a Switch, a guard, or an error path. */
    | { kind: 'lane'; key: string; depth: number; text: RowText; tone: LaneTone }
    /** A loop body or one parallel branch: collapsible. */
    | {
          kind: 'group';
          key: string;
          depth: number;
          container: string;
          branch: number | null;
          count: number;
          collapsed: boolean;
          text: RowText;
      }
    /** A "+": between two cards, or at the end of a lane. */
    | { kind: 'add'; key: string; depth: number; target: AddTarget; end: boolean }
    /** The flow goes on at a step shown elsewhere (a join, or a way back). */
    | { kind: 'jump'; key: string; depth: number; toId: string; back: boolean }
    /** A heading between parts of the outline ("Not connected"). */
    | { kind: 'section'; key: string; text: RowText };

export type OutlineRowKind = OutlineRow['kind'];

export interface OutlineOptions {
    /** Group keys (`group:<container>|<branch>`) the reader folded away. */
    collapsed?: ReadonlySet<string>;
}

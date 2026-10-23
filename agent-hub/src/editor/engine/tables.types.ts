import type { DocNode } from '../model/schema.js';

/** One slot of the visual grid: the cell occupying it and where that cell starts. */
export interface GridEntry { cell: DocNode; rowIdx: number; cellIdx: number; originR: number; originC: number }

export type Grid = (GridEntry | undefined)[][];

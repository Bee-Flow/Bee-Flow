import type { Bag } from './resolveBinding.types';

export const EMPTY: Bag = Object.freeze({ actionState: {}, dataState: {}, scope: undefined });

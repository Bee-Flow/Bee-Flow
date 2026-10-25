import type { ModelTierMap } from '../../api/queries/modelTiers';
import type { MemoryLock, MemoryMode } from '../../utils/memoryMode';
import type { TierMeta } from './tierMeta';

export type MetaFor = (key: string) => TierMeta;

/** The composer's memory control as TierSlider is handed it: the current `{ mode, onChange, lock }` shape or the older `{ enabled, onToggle }`. */
interface TierSliderMemory {
    mode?: MemoryMode;
    onChange?: (next: MemoryMode) => void;
    lock?: MemoryLock;
    enabled?: boolean;
    onToggle?: () => void;
}

export interface TierSliderProps {
    tiers?: ModelTierMap;
    value?: string;
    onChange?: (key: string) => void;
    variant?: string;
    memory?: TierSliderMemory | null;
}

export interface TierTrackProps {
    stops: string[];
    activeIndex: number;
    metaFor: MetaFor;
    onSelect: (key: string) => void;
    trackRef: React.RefObject<HTMLDivElement | null>;
    onPointerDown: React.PointerEventHandler<HTMLDivElement>;
    onPointerMove: React.PointerEventHandler<HTMLDivElement>;
    onPointerEnd: React.PointerEventHandler<HTMLDivElement>;
    onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
}

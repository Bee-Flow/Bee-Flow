import type { ServerPlaybook } from './usePlaybook';
import type { Phase, PlaybookEvent } from './phaseMachine';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppUserLike } from '@/components/projects/workspace/types';

/** What a playbook was started with, as far as the film reads it. */
export interface PlaybookOptions {
    tier?: string;
    tableMode?: string;
}

/** What every stage is handed; each stage reads the part it needs. */
export interface StageProps {
    playbook: ServerPlaybook;
    phase: Phase;
    dispatch: (event: PlaybookEvent, base?: ServerPlaybook | null) => Promise<ServerPlaybook | null>;
    t: TranslateFn;
    user?: AppUserLike | null;
    onBack: () => void;
    forcedTier?: string;
    reducedMotion: boolean;
    presenter: boolean;
    onNavigate: ((to: string) => void) | null;
}

export interface PlaybookRunProps {
    playbookId: string;
    user?: AppUserLike | null;
    onBack: () => void;
    onNavigate?: ((to: string) => void) | null;
}

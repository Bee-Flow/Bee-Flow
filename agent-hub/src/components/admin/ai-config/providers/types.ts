import type { ProviderMessage } from '@/hooks/useProviderConfig';

/** The props every provider pane takes: where to say what happened. */
export interface ProviderPaneProps {
    onMessage?: (message: ProviderMessage) => void;
}

/** GET /ai/config as the panes read it: has-flags and plain settings. */
export type AiConfigBag = Record<string, unknown> | null;

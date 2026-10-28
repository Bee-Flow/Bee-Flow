import type { TranslateParams } from '@/hooks/useTranslation';
import type { DesignElement } from '../../admin/Studio/Playbooks/phaseMachine';

/**
 * "What Bee Flow may access" — the per-user Nextcloud scope.
 *
 * Lives inside the Nextcloud IntegrationRow's expanded body, so it costs
 * zero pixels until someone opens the row. One quiet bordered container of
 * catalog rows; each row states its scope IN WORDS ("Everything", "3
 * calendars", "Off") with a small warning-dot when narrowed — the collapsed
 * control must still say what's on (the chat-composer lesson). Clicking a
 * row discloses an inline panel (the settings-page pattern —
 * MeetingNotesSection), with the KB-picker chrome inside: segmented mode
 * choice, then search + checkbox list (or a lazy folder tree for Files)
 * only when "Only selected" is active.
 *
 * Every change saves immediately through PUT /api/nc-scope — the server
 * sanitises, audits, and enforces in the tool dispatcher; this component
 * is presentation, never authorization.
 */

export type TFn = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

export interface ScopeResource { id: string; label: string; color?: string }

export interface ScopeEntry { name: string; description: string; mode: string; selected: string[]; scopable: boolean; resource: DesignElement | null }

export type ScopeMap = Record<string, ScopeEntry>;

export interface ScopeBody { integrations: Record<string, { mode: string; selected?: string[] }> }

export interface FolderNodeProps {
    path: string;
    label: string;
    depth: number;
    selected: string[];
    onToggle: (path: string) => void;
    t: TFn;
}

export interface FolderTreePickerProps {
    selected: string[];
    onToggle: (path: string) => void;
    t: TFn;
}

export interface ResourcePickerProps {
    integrationId: string;
    resourceLabel: string;
    selected: string[];
    onToggle: (id: string) => void;
    t: TFn;
}

export interface ScopeRowProps {
    id: string;
    entry: ScopeEntry;
    last: boolean;
    onModeChange: (id: string, mode: string) => void;
    onSelectionSave: (id: string, selected: string[]) => void;
    t: TFn;
}

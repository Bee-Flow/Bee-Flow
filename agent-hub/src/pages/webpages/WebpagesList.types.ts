import type { WebpageCardData } from './WebpageCard';
import type { BuildSource } from './SourcePicker';
import type React from 'react';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { PromptPreset } from './promptPresets';

/**
 * WebpagesList — the Webpages overview (artboard 1a, plan W1).
 *
 * Three things changed against the W0 split, and they are the whole track:
 *
 *   1. It opens with `StudioSectionHeader`, the row every Studio object now
 *      shares, so "where is search / where is New" is learned once.
 *   2. Making a page starts from a BRIEF, not a name (`BuildBar`). The
 *      name-only shortcut still exists, under "All options", because a
 *      shortcut is not the front door.
 *   3. A card says what the page IS: its own rendered preview, who can see it
 *      (including the derived "Public" state a public share creates), and the
 *      tables and automations it is wired to.
 *
 * Still purely presentational: every request leaves through a callback the
 * shell passes in, and the only local state is the search box, the build
 * bar's draft, the "All options" disclosure and the in-card rename editor.
 *
 * Props
 *   webpages          list rows (id, name, tagline, icon, thumbnailSha,
 *                     updatedAt, isPublished, sharedGroups, bridgeGrants,
 *                     publicShareCount, …)
 *   loading           list fetch in flight
 *   loadingWebpageId  card whose open is in flight (spinner + dims the rest)
 *   error / onDismissError
 *   newName / onNewNameChange / creating / onCreate(e)   the name-only shortcut
 *   onBuild({ prompt, sources })   describe-to-build; resolves when the page
 *                     has been created (the shell opens the editor)
 *   building          a build request is in flight
 *   onOpen(id) / onEdit(id) / onClone(id) / onDelete(id) / onRename(id, name)
 *   onBack            optional back arrow
 *
 * `embedded` is gone: the section header IS the header now, in the Studio
 * mount and standalone alike (Studio Home artboard 1b). The shell may keep
 * passing it; it is ignored.
 */
export interface WebpagesListProps {
    webpages?: WebpageCardData[];
    error?: string | null;
    onBuild?: (arg: { prompt: string; sources: BuildSource[] }) => Promise<unknown> | void;
    onRename?: (id: string, name: string) => void;
    embedded?: boolean;
    loading?: boolean;
    loadingWebpageId: string | null;
    onDismissError: () => void;
    newName: string;
    onNewNameChange: React.Dispatch<React.SetStateAction<string>>;
    creating: boolean;
    onCreate: React.SubmitEventHandler<HTMLFormElement>;
    building?: boolean;
    onOpen: (id: string) => void;
    onEdit: (id: string) => void;
    onClone: (id: string) => void;
    onDelete: (id: string) => void;
    onBack?: React.MouseEventHandler<HTMLButtonElement>;
}

/** The header's 220px search field (artboard 1a). */
export interface SearchFieldProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    value: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
}

/**
 * The name-only shortcut, kept but demoted (plan W1). The panel stays MOUNTED
 * while collapsed — `hidden` takes it out of the layout and the accessibility
 * tree, which is what a disclosure means, and keeps the form addressable for
 * anything holding a reference to it.
 */
export interface AllOptionsProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    open: boolean;
    onToggle: () => void;
    newName: string;
    onNewNameChange: (value: string) => void;
    creating: boolean;
    onCreate: React.SubmitEventHandler<HTMLFormElement>;
}

/**
 * The dashed last cell (artboard 1a). Its four phrases are the artboard's
 * own, one middot-separated line — but each is a button that fills the build
 * bar, because there is no template entity behind them (plan deviation).
 */
export interface ExampleCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    onPick: (preset: PromptPreset) => void;
}

export interface EmptySearchProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

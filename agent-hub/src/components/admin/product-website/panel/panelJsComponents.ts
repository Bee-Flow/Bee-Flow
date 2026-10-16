import type { ComponentType, ReactNode } from 'react';
import AddBlockDialogJs from '../dialogs/AddBlockDialog';
import InspectorHostJs from '../inspector/InspectorHost';
import NavigatorPanelJs from '../navigator/NavigatorPanel';
import PreviewStageJs from '../preview/PreviewStage';

// The builder's panes are plain JS: TypeScript reads a `= null` default as
// "this prop is always null" and every destructured prop without a default as
// required. These are the props the panel container passes (same approach as
// blog/jsComponents.ts).

type Props = Record<string, unknown>;

export const NavigatorPanel = NavigatorPanelJs as unknown as ComponentType<{
    activeEntryId: string | null;
    onSelectEntry: (id: string) => void;
    pageListProps: Props;
    /** null hides the BLOCKS zone. */
    blockListProps: Props | null;
    /** The Blog entry's post list; replaces PAGES + BLOCKS while set. */
    blogSlot?: ReactNode;
}>;

export const InspectorHost = InspectorHostJs as unknown as ComponentType<{
    activePageId: string | null;
    activePage: unknown;
    translationMode: boolean;
    translateProps: Props;
    chromeProps: Props;
    designProps: Props;
    analyticsProps: Props;
    pageProps: Props;
    blogInspector?: ReactNode;
    redirectsInspector?: ReactNode;
}>;

export const PreviewStage = PreviewStageJs as unknown as ComponentType<{
    /** 'preview' | 'sitemap' */
    view: string;
    statusText: string | null;
    iframe: ReactNode;
    sitemap: ReactNode;
    deviceWidth?: number | null;
    overlay?: ReactNode;
    errorText?: string | null;
    onDismissError: () => void;
}>;

export const AddBlockDialog = AddBlockDialogJs as unknown as ComponentType<{
    onAdd: (type: string, variant?: string) => void;
    onCancel: () => void;
    design?: Record<string, unknown> | null;
}>;

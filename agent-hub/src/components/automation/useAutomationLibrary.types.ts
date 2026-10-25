import type { Dispatch, SetStateAction } from 'react';
import useAutomationApi from '../../hooks/useAutomationApi';

/** One row of the sidebar's automation list. */
export interface AutomationListRow {
    id: string;
    title?: string;
    description?: string | null;
    /** null = at the top level, outside every folder. */
    folderId?: string | null;
    isActive?: boolean;
    isDraft?: boolean;
    definition?: unknown;
    [key: string]: unknown;
}

/** One sidebar folder. */
export interface AutomationFolder {
    id: string;
    name?: string;
    [key: string]: unknown;
}

/** One reusable Step (an automation of kind 'block'). */
export interface StepRow {
    id: string;
    title?: string;
    [key: string]: unknown;
}

export interface AutomationLibrary {
    automationApi: ReturnType<typeof useAutomationApi>;
    automations: AutomationListRow[];
    setAutomations: Dispatch<SetStateAction<AutomationListRow[]>>;
    folders: AutomationFolder[];
    automationsLoading: boolean;
    pendingDeleteAutomation: AutomationListRow | null;
    setPendingDeleteAutomation: Dispatch<SetStateAction<AutomationListRow | null>>;
    steps: StepRow[];
    stepsLoading: boolean;
    /** Ids of the automations executing right now — the sidebar's live dot. */
    activeRunIds: Set<string>;
    fetchAutomations: () => Promise<void>;
    fetchFolders: () => Promise<void>;
    createFolder: (name: string) => Promise<void>;
    renameFolder: (id: string, name: string) => Promise<void>;
    deleteFolder: (folder: AutomationFolder) => Promise<void>;
    moveToFolder: (automationId: string, folderId: string | null) => Promise<void>;
    fetchSteps: () => Promise<void>;
    onDeleteStep: (step: StepRow) => Promise<void>;
    toggleAutomation: (a: AutomationListRow) => Promise<void>;
    requestDeleteAutomation: (a: AutomationListRow) => void;
    confirmDeleteAutomation: () => Promise<void>;
    duplicateAutomation: (a: AutomationListRow) => Promise<void>;
    exportAutomationJson: (a: AutomationListRow) => Promise<void>;
    importAutomationFile: (file: File | null) => Promise<void>;
    copyAutomationId: (a: AutomationListRow) => Promise<void>;
}

export interface UseAutomationLibraryOptions {
    confirm: (opts: {
        title: string;
        description?: string;
        confirmLabel?: string;
        destructive?: boolean;
    }) => Promise<boolean>;
    builderAutomationId: string | null;
    openingBuilder: boolean;
    builderStepId: string | null;
    setBuilderAutomationId: (id: string | null) => void;
    setBuilderInitialTab: (tab: string | null) => void;
    setBuilderStepId: (id: string | null) => void;
    setOpeningBuilder: (opening: boolean) => void;
}

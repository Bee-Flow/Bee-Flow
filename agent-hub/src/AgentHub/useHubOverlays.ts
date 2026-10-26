import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { OPEN_MEMORY_PANEL_EVENT } from '../utils/memoryMode';
import { themePreviewHints } from './hubUrl';

interface HubOverlaysArgs {
    /** The routed full-page views: opening any of them closes the Projects views. */
    pages: { showSettings: boolean; showAgentDesigner: boolean; showAgentWizard: boolean; showStudio: boolean; showSkillsPanel: boolean };
    setShowProjectsStore: Dispatch<SetStateAction<boolean>>;
    setActiveProjectId: Dispatch<SetStateAction<string | null>>;
}

/**
 * The hub's panel and overlay switches: design mode, the agent store
 * (marketplace), search, the memory panel and the agent menu, with the three
 * things that open them from outside (Theme Studio preview hints, the memory
 * event, Cmd/Ctrl+K).
 */
export default function useHubOverlays({ pages, setShowProjectsStore, setActiveProjectId }: HubOverlaysArgs) {
    const [designMode, setDesignMode] = useState(false);
    const [showMarketplace, setShowMarketplace] = useState(false);
    // A Theme Studio preview can ask for the search overlay to start open.
    const [showSearch, setShowSearch] = useState(() => themePreviewHints().openSearch);
    const [showMemoryPanel, setShowMemoryPanel] = useState(false);
    const [showAgentMenu, setShowAgentMenu] = useState(false);

    // Message rows (the "Memory used" and "Remembered" lines) ask for the panel
    // by event: they sit too deep in the tree to be handed a callback.
    useEffect(() => {
        const open = () => setShowMemoryPanel(true);
        window.addEventListener(OPEN_MEMORY_PANEL_EVENT, open);
        return () => window.removeEventListener(OPEN_MEMORY_PANEL_EVENT, open);
    }, []);

    // Global Cmd/Ctrl+K to open Search
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setShowSearch(prev => !prev);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Close the Projects views when the user navigates to a chat (agent or direct).
    // Mirrors how the agent marketplace closes itself in handleSelectAgent etc.
    const { showSettings, showAgentDesigner, showAgentWizard, showStudio, showSkillsPanel } = pages;
    useEffect(() => {
        if (showMarketplace || showSettings || showAgentDesigner || showAgentWizard || showStudio || showSkillsPanel) {
            setShowProjectsStore(false);
            setActiveProjectId(null);
        }
    }, [showMarketplace, showSettings, showAgentDesigner, showAgentWizard, showStudio, showSkillsPanel, setShowProjectsStore, setActiveProjectId]);

    return {
        designMode, setDesignMode,
        showMarketplace, setShowMarketplace,
        showSearch, setShowSearch,
        showMemoryPanel, setShowMemoryPanel,
        showAgentMenu, setShowAgentMenu,
    };
}

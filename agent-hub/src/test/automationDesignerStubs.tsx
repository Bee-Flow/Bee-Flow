/**
 * Stand-ins for the two heavy panes of AITasksDesigner (the builder and the
 * launcher): they expose the props the designer hands them. Kept apart from
 * the harness because a `vi.mock` factory imports this file, and the harness
 * imports the designer, which imports the mocked modules (a cycle).
 */

export interface Row { id: string; title: string; isActive?: boolean; triggerType?: string; folderId?: string | null }
export interface BuilderStubProps {
    mode?: string; automationId: string | null; initialTab: string | null; initialChatInput?: string;
    autoSendInput?: string | null; initialScopeKey?: string | null;
    onBack: () => void; onOpenList: () => void; onAutomationIdResolved: (id: string) => void;
    onScopeChange?: (key: string | null) => void; onExportJson?: () => void;
}
export interface LauncherStubProps {
    automations: Row[]; automationsQuery: string; canCreateAutomation: boolean;
    onCreateAutomation: () => void; onOpenAutomation: (id: string) => void;
    onPickTemplate: (id: string) => Promise<void>;
    onBuildSuggestion: (s: { id: string; title: string; buildPrompt: string }) => void;
    onAskSuggestion: (s: { id: string; title: string; buildPrompt: string }) => void;
    onCreateStep: (() => void) | null; onCreateFolder: (() => void) | null;
}

export function BuilderStub(p: BuilderStubProps) {
    return (
        <div data-testid="builder" data-mode={p.mode ?? 'automation'} data-id={String(p.automationId)} data-tab={String(p.initialTab)}
            data-chat={p.initialChatInput ?? ''} data-auto-send={p.autoSendInput ?? ''} data-scope={String(p.initialScopeKey ?? null)}
            data-can-export={String(!!p.onExportJson)}>
            <button onClick={p.onBack}>stub-back</button>
            <button onClick={p.onOpenList}>stub-open-list</button>
            <button onClick={() => p.onAutomationIdResolved('live-1')}>stub-resolve</button>
            <button onClick={() => p.onScopeChange?.('layer1')}>stub-scope</button>
        </div>
    );
}

export function LauncherStub(p: LauncherStubProps) {
    const s = { id: 's1', title: 'Log invoices', buildPrompt: 'Log every invoice' };
    return (
        <div data-testid="launcher" data-count={p.automations.length} data-query={p.automationsQuery} data-can-create={String(p.canCreateAutomation)}
            data-has-step={String(!!p.onCreateStep)} data-has-folder={String(!!p.onCreateFolder)}>
            <button onClick={p.onCreateAutomation}>stub-new</button>
            <button onClick={() => p.onOpenAutomation('a2')}>stub-open-a2</button>
            <button onClick={() => { void p.onPickTemplate('t1'); }}>stub-template</button>
            <button onClick={() => p.onBuildSuggestion(s)}>stub-build</button>
            <button onClick={() => p.onAskSuggestion(s)}>stub-ask</button>
            <button onClick={() => p.onCreateStep?.()}>stub-new-block</button>
        </div>
    );
}


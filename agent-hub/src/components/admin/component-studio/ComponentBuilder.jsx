import React, { useState } from 'react';
import AIComponentDesigner from './AIComponentDesigner';
import ComponentDocsModal from './builder/ComponentDocsModal';
import ComponentEditorPane from './builder/ComponentEditorPane';
import ComponentListPane from './builder/ComponentListPane';
import { useComponentEditor } from './builder/useComponentEditor';

// Component Studio's builder: the component list on the left, the editor
// (config, code, test) on the right, plus the AI designer and the guide.
// The behaviour lives in builder/useComponentEditor, the requests in
// api/componentStudio, the form model in builder/componentForm.
// Props from the shell (onBack, hasPermission) are accepted and not used.
const ComponentBuilder = (_props) => {
    const editor = useComponentEditor();
    const [showDocs, setShowDocs] = useState(false);
    const [showAI, setShowAI] = useState(false);

    return (
        <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden p-6" style={{ background: 'var(--bg-primary)' }}>
                <div className="flex-1 flex overflow-hidden border rounded-xl shadow-sm" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
                    {/* Component List Sidebar */}
                    <ComponentListPane
                        components={editor.components}
                        loading={editor.loading}
                        selectedComponent={editor.selectedComponent}
                        onNew={editor.handleNewComponent}
                        onOpenAI={() => setShowAI(true)}
                        onSelect={editor.handleSelectComponent}
                        onDeleteCategory={editor.handleDeleteCategory}
                        onDeleteOne={editor.handleDeleteSingleComponent}
                    />

                    {/* Editor Panel */}
                    <ComponentEditorPane editor={editor} onOpenAI={() => setShowAI(true)} />
                </div>
            </div>

            {/* Documentation Modal */}
            {showDocs && <ComponentDocsModal onClose={() => setShowDocs(false)} />}

            {/* AI Component Designer Modal */}
            {
                showAI && (
                    <div className="fixed inset-0 z-[100]" style={{ background: 'var(--bg-primary)' }}>
                        <AIComponentDesigner
                            onComponentCreated={() => {
                                editor.fetchComponents();
                                // Don't close immediately - let the designer handle post-create actions
                            }}
                            onClose={() => setShowAI(false)}
                        />
                    </div>
                )
            }
            {editor.confirmDialog}
        </div >
    );
};

export default ComponentBuilder;

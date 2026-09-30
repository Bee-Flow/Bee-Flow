/**
 * One Studio document — the web's DocumentEditor, natively.
 *
 * The header is the Studio object header: the document's tile, its name
 * (tap to rename), the autosave's state, the PDF as the one primary action
 * and the rest of the web toolbar behind the overflow. The tabs are the web
 * editor's panels: the text (a presentation: its outline), Parameters,
 * Sections, Design, Customer preview and History.
 *
 * There is no WebView in this app, so the page is not drawn here: its words
 * are edited in place (BodyEditor), and what it looks like is the PDF, or the
 * composed page opened from the menu — both rendered by the server, which is
 * where the web's preview comes from too.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { QueryScreen } from '@/shared/patterns';
import { Button, Icon, IconButton, ObjectHeader } from '@/shared/ui';

import { DocumentMenu } from '../components/DocumentMenu';
import { EditorBody } from '../components/EditorBody';
import { RenameSheet } from '../components/RenameSheet';
import { SaveProblem } from '../components/SaveProblem';
import { useDocumentEditor, type DocumentEditor } from '../hooks/useDocumentEditor';
import { useDocumentExport } from '../hooks/useDocumentExport';
import { docIcon, docTypeLabel } from '../model/format';
import { editorTabs, saveStatus, type EditorTab } from '../model/tabs';
import type { StudioDocument } from '../model/types';

interface HeaderProps {
    doc: StudioDocument | undefined;
    editor: DocumentEditor;
    tab: EditorTab;
    onTab: (tab: EditorTab) => void;
    onPdf: () => void;
    exporting: boolean;
    onMenu: () => void;
    onRename: () => void;
}

function Header({ doc, editor, tab, onTab, onPdf, exporting, onMenu, onRename }: HeaderProps) {
    const t = useTranslation();
    const theme = useTheme();
    if (!doc) return <ObjectHeader kind="document" title="" backLabel={t('documents.back', 'Back to Documents')} />;
    return (
        <ObjectHeader<EditorTab>
            kind="document"
            icon={docIcon(doc)}
            title={doc.name}
            status={saveStatus(t, editor.autosave.state, docTypeLabel(t, doc.docType))}
            backLabel={t('documents.back', 'Back to Documents')}
            onTitlePress={doc.editable ? onRename : undefined}
            titleHint={t('mobile.studio_documents.rename_hint', 'Renames the document')}
            primary={<Button label={t('documents.download_pdf_short', 'PDF')} iconName="Download" size="sm" disabled={exporting} onPress={onPdf} />}
            extras={
                <IconButton
                    icon={<Icon name="MoreVertical" size={20} color={theme.colors.textSecondary} />}
                    accessibilityLabel={t('mobile.studio_documents.more', 'More actions')}
                    onPress={onMenu}
                />
            }
            tabs={editorTabs(t, doc.docType === 'presentation')}
            activeTab={tab}
            onTab={onTab}
            testID="document-header"
        />
    );
}

export function StudioDocumentScreen({ documentId }: { documentId: string }) {
    const t = useTranslation();
    const editor = useDocumentEditor(documentId);
    const { doc } = editor;
    const [tab, setTab] = useState<EditorTab>('content');
    const [menu, setMenu] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const exporter = useDocumentExport(documentId, doc?.name ?? '', editor.autosave.flush);
    const pdf = () => void exporter.run('pdf');

    return (
        <QueryScreen
            query={{ ...editor.query, data: doc, error: editor.query.error ?? new Error(t('documents.not_found', 'Document not found.')) }}
            scroll={false}
            screen={{ avoidKeyboard: true }}
            header={(loaded) => (
                <Header doc={loaded} editor={editor} tab={tab} onTab={setTab} onPdf={pdf} exporting={exporter.busy} onMenu={() => setMenu(true)} onRename={() => setRenaming(true)} />
            )}
        >
            {(loaded) => (
                <>
                    <SaveProblem editor={editor} />
                    <EditorBody tab={tab} doc={loaded} editor={editor} onPdf={pdf} exporting={exporter.busy} />
                    <DocumentMenu
                        doc={loaded}
                        visible={menu}
                        onClose={() => setMenu(false)}
                        write={editor.write}
                        onExport={(format) => void exporter.run(format)}
                        onRename={() => setRenaming(true)}
                    />
                    <RenameSheet visible={renaming} name={loaded.name} write={editor.write} onClose={() => setRenaming(false)} />
                </>
            )}
        </QueryScreen>
    );
}

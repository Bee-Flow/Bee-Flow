/**
 * The open tab of the document editor. Every tab is keyed by the editor's
 * epoch, so a restore (or a section added to the body) starts each one again
 * from what is stored.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { BodyEditor } from './BodyEditor';
import { DesignTab } from './DesignTab';
import { HistoryTab } from './HistoryTab';
import { OutlineEditor } from './OutlineEditor';
import { ParametersTab } from './ParametersTab';
import { PreviewTab } from './PreviewTab';
import { SectionsTab } from './SectionsTab';
import type { DocumentEditor } from '../hooks/useDocumentEditor';
import { isDeck } from '../model/format';
import type { EditorTab } from '../model/tabs';
import type { StudioDocument } from '../model/types';

const styles = StyleSheet.create({ fill: { flex: 1 }, hidden: { display: 'none' } });

export interface EditorBodyProps {
    tab: EditorTab;
    doc: StudioDocument;
    editor: DocumentEditor;
    onPdf: () => void;
    exporting: boolean;
}

function Content({ doc, editor }: { doc: StudioDocument; editor: DocumentEditor }) {
    const { autosave, epoch } = editor;
    if (isDeck(doc)) return <OutlineEditor key={epoch} outline={doc.bodyHtml} editable={doc.editable} onChange={autosave.schedule} />;
    return (
        <BodyEditor
            key={epoch}
            bodyHtml={doc.bodyHtml}
            sections={new Map(doc.contract.sections.map((s) => [s.id, s.title]))}
            editable={doc.editable}
            onChange={autosave.schedule}
        />
    );
}

function OtherTab({ tab, doc, editor, onPdf, exporting }: EditorBodyProps) {
    const key = `${tab}:${editor.epoch}`;
    const { write, autosave, reload } = editor;
    switch (tab) {
        case 'parameters':
            return <ParametersTab key={key} doc={doc} write={write} />;
        case 'sections':
            return <SectionsTab key={key} doc={doc} write={write} beforeBodyChange={autosave.flush} onBodyChanged={reload} />;
        case 'design':
            return <DesignTab key={key} doc={doc} write={write} />;
        case 'preview':
            return <PreviewTab key={key} doc={doc} write={write} onOpenPdf={onPdf} exporting={exporting} />;
        case 'history':
            return <HistoryTab key={key} documentId={doc.id} editable={doc.editable} beforeRestore={autosave.flush} onRestored={reload} />;
        default:
            return null;
    }
}

/**
 * The text (or outline) stays mounted while another tab is open: its fields
 * hold what is being typed, and remounting it from a body the autosave has
 * not written back yet would show the old words.
 */
export function EditorBody(props: EditorBodyProps) {
    const onContent = props.tab === 'content';
    return (
        <>
            <View style={onContent ? styles.fill : styles.hidden}>
                <Content doc={props.doc} editor={props.editor} />
            </View>
            {onContent ? null : <OtherTab {...props} />}
        </>
    );
}

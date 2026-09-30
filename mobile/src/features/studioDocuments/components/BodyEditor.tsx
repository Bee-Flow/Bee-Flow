/**
 * The page's text, editable in place — the phone's form of the web's "Edit
 * text": every stretch of text in the body, in reading order, each in its own
 * field. Only the words change; the markup around them is kept byte for byte
 * (model/htmlRuns.ts), so an invoice cannot lose its layout on a phone.
 *
 * The body the runs were cut from is fixed for the life of this component
 * (the screen remounts it when a version is restored), so run positions stay
 * valid while the autosave writes the edited body back.
 */

import React, { createContext, useContext, useRef, useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Banner, EmptyState } from '@/shared/ui';

import { RunField } from './RunField';
import { applyRunEdits, textRuns, type TextRun } from '../model/htmlRuns';

interface EditContextValue {
    editable: boolean;
    sections: ReadonlyMap<string, string>;
    onEdit: (index: number, text: string) => void;
    /** What a run reads now: a field scrolled out of the list and back must keep its edit. */
    textOf: (run: TextRun) => string;
}
const EditContext = createContext<EditContextValue>({
    editable: false,
    sections: new Map(),
    onEdit: () => undefined,
    textOf: (run) => run.text,
});

function ContextRun({ run }: { run: TextRun }) {
    const { editable, sections, onEdit, textOf } = useContext(EditContext);
    const sectionTitle = run.section ? (sections.get(run.section) ?? run.section) : null;
    return <RunField run={run} initial={textOf(run)} editable={editable} onEdit={onEdit} sectionTitle={sectionTitle} />;
}
const renderRun: ListRenderItem<TextRun> = ({ item }) => <ContextRun run={item} />;
const keyOf = (run: TextRun) => String(run.index);

const styles = StyleSheet.create({
    list: { padding: 16, gap: 14, paddingBottom: 48 },
    hint: { paddingHorizontal: 16, paddingTop: 12 },
});

export interface BodyEditorProps {
    bodyHtml: string;
    sections: ReadonlyMap<string, string>;
    editable: boolean;
    /** The whole edited body, after every change; the caller autosaves it. */
    onChange: (bodyHtml: string) => void;
}

export function BodyEditor({ bodyHtml, sections, editable, onChange }: BodyEditorProps) {
    const t = useTranslation();
    const [base] = useState(bodyHtml);
    const [runs] = useState(() => textRuns(base));
    const edits = useRef(new Map<number, string>());
    const onEdit = (index: number, text: string) => {
        edits.current.set(index, text);
        onChange(applyRunEdits(base, runs, edits.current));
    };
    const textOf = (run: TextRun) => edits.current.get(run.index) ?? run.text;

    if (!runs.length) {
        return (
            <EmptyState
                icon="FileText"
                title={t('mobile.studio_documents.no_text_title', 'No text to edit yet')}
                message={t('mobile.studio_documents.no_text', 'This document has no words on its page yet. Start it from a template, or ask the assistant in chat to write it.')}
            />
        );
    }
    return (
        <EditContext.Provider value={{ editable, sections, onEdit, textOf }}>
            <View style={styles.hint}>
                <Banner tone="info" icon="PenLine">
                    {editable
                        ? t('mobile.studio_documents.edit_hint', 'Tap any text and type. The layout stays exactly as designed; placeholders like {{customer.name}} are filled per customer.')
                        : t('mobile.studio_documents.read_only', 'You can read this document but not change it.')}
                </Banner>
            </View>
            <FlatList
                data={runs}
                renderItem={renderRun}
                keyExtractor={keyOf}
                contentContainerStyle={styles.list}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={12}
                windowSize={7}
                removeClippedSubviews={false}
            />
        </EditContext.Provider>
    );
}

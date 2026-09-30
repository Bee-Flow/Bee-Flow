/**
 * The knowledge-base file list (every document across your bases). The screen
 * lives in features/documents; `?open=<id>` names a document to open once the
 * list holding it has arrived. A static segment, so it wins over
 * `knowledge/[id]` in expo-router's matching.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { DocumentsScreen } from '@/features/documents';

export default function KnowledgeDocumentsRoute() {
    const { open } = useLocalSearchParams<{ open?: string }>();
    return <DocumentsScreen openId={open} />;
}

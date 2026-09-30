/**
 * Preview what can honestly be previewed.
 *
 * Three renderers and one refusal:
 *
 *   text      — selectable. This is what the server actually stores for a
 *               source or a KB document: the extracted text, not the original
 *               bytes — and a person who uploaded a 40-page PDF should know
 *               they are looking at what the model sees.
 *   markdown  — the same content through the chat renderer, for anything the
 *               server produced as markdown (URL sources are converted).
 *   image     — expo-image, which is the whole story for a photo or a scan.
 *   binary    — no renderer. Offer "Open with…" and say why.
 *
 * There is no WebView in this app, and this file is the reason that stays
 * true: a WebView is the tempting way to fake a PDF viewer, and it would put a
 * browser engine — with its own cookie jar and attack surface — inside a
 * privacy product.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Sheet } from '@/shared/ui';

import { PreviewActions } from './PreviewActions';
import { PreviewBody, type PreviewKind } from './PreviewBody';

export type { PreviewKind } from './PreviewBody';

export interface PreviewSheetProps {
    visible: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    kind: PreviewKind;
    /** Body for the text/markdown renderers. */
    content?: string;
    /** Local or absolute uri for the image renderer. */
    imageUri?: string;
    loading?: boolean;
    error?: unknown;
    onRetry?: () => void;
    /** Hands the file to the Android share sheet. */
    onShare?: () => void;
    /** For `binary`: the only sensible action. */
    onOpenWith?: () => void;
    busyAction?: boolean;
}

const styles = StyleSheet.create({ body: { flexShrink: 1, minHeight: 200 } });

export function PreviewSheet({ visible, onClose, title, subtitle, onShare, onOpenWith, busyAction = false, ...body }: PreviewSheetProps) {
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={title}
            subtitle={subtitle}
            scroll={false}
            tall
            footer={
                onShare || onOpenWith ? (
                    <PreviewActions onShare={onShare} onOpenWith={onOpenWith} busy={busyAction} />
                ) : undefined
            }
        >
            <View style={styles.body}>
                <PreviewBody title={title} {...body} />
            </View>
        </Sheet>
    );
}

/**
 * Scan a document with the camera.
 *
 * This is the one thing the phone does that the browser cannot, so it is a
 * first-class way to get a source into a notebook or a knowledge base rather
 * than a shortcut into the image picker.
 *
 * Multi-shot on purpose: paper documents have more than one page, and making
 * somebody re-open the camera per page turns a two-minute job into a chore.
 * Each shot becomes its own upload — the server extracts text per file, so
 * pages stay separately retryable if one of them fails.
 *
 * A full-screen <Modal> rather than a route, because this component is owned
 * by three screens and a route would have to live in app/ where the file it
 * needs is not ours to create.
 */

import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React, { useCallback, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button, IconButton } from '../../../ui/Button';
import { Text } from '../../../ui/Text';
import type { UploadFile } from '../upload';

/** A shot that has been taken but not yet handed back. */
interface Page {
    uri: string;
    width: number;
    height: number;
}

export function ScanCamera({
    visible,
    onClose,
    onCapture,
    /** Used to name the files: "Contract page 1.jpg". */
    baseName = 'Scan',
}: {
    visible: boolean;
    onClose: () => void;
    onCapture: (files: UploadFile[]) => void;
    baseName?: string;
}) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const [permission, requestPermission] = useCameraPermissions();
    const cameraRef = useRef<CameraView | null>(null);
    const [pages, setPages] = useState<Page[]>([]);
    const [busy, setBusy] = useState(false);

    const reset = useCallback(() => {
        setPages([]);
        setBusy(false);
    }, []);

    const shoot = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            // quality 0.8 rather than 1: a full-quality phone photo of an A4
            // page is 6-8 MB and adds nothing an OCR pass can use, while four
            // of them walk straight into the server's upload cap.
            const shot = await cameraRef.current?.takePictureAsync({ quality: 0.8 });
            if (shot?.uri) {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                setPages((prev) => [...prev, { uri: shot.uri, width: shot.width, height: shot.height }]);
            }
        } catch {
            // A failed shutter is not worth a dialog — the preview is still
            // live and the obvious recovery is to press it again.
        } finally {
            setBusy(false);
        }
    }, [busy]);

    const finish = useCallback(() => {
        const files: UploadFile[] = pages.map((page, i) => ({
            uri: page.uri,
            name: pages.length > 1 ? `${baseName} page ${i + 1}.jpg` : `${baseName}.jpg`,
            mimeType: 'image/jpeg',
            // The camera does not report a byte count. 0 means "unknown", and
            // uploadFile then leaves the size check to the server.
            size: 0,
        }));
        reset();
        onCapture(files);
    }, [pages, baseName, onCapture, reset]);

    const cancel = useCallback(() => {
        reset();
        onClose();
    }, [onClose, reset]);

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={cancel} statusBarTranslucent>
            <View style={[styles.root, { backgroundColor: '#000' }]}>
                {!permission ? null : !permission.granted ? (
                    <View style={[styles.centre, { padding: theme.spacing.xxl, gap: theme.spacing.lg }]}>
                        <Feather name="camera-off" size={32} color="#fff" />
                        <Text variant="heading" center style={{ color: '#fff' }}>
                            Camera access is off
                        </Text>
                        <Text variant="body" center style={{ color: 'rgba(255,255,255,0.7)' }}>
                            Bee Flow needs the camera to scan a document into your library. Nothing is
                            captured until you press the shutter.
                        </Text>
                        <Button label="Allow camera" onPress={() => void requestPermission()} />
                        <Button label="Not now" variant="ghost" onPress={cancel} />
                    </View>
                ) : (
                    <>
                        <CameraView
                            ref={cameraRef}
                            style={StyleSheet.absoluteFill}
                            facing="back"
                            // Documents are flat and high-contrast; the default
                            // auto flash fires on a white page and blows it out.
                            flash="off"
                        />

                        <View style={[styles.topBar, { paddingTop: insets.top + theme.spacing.sm }]}>
                            <IconButton
                                icon={<Feather name="x" size={22} color="#fff" />}
                                accessibilityLabel="Close the scanner"
                                onPress={cancel}
                            />
                            <Text
                                variant="caption"
                                style={{ color: '#fff', flex: 1 }}
                                accessibilityLiveRegion="polite"
                            >
                                {pages.length === 0
                                    ? 'Fill the frame with the page'
                                    : `${pages.length} page${pages.length === 1 ? '' : 's'} captured`}
                            </Text>
                        </View>

                        {pages.length > 0 ? (
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                style={[styles.filmstrip, { bottom: insets.bottom + 128 }]}
                                contentContainerStyle={{ gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg }}
                            >
                                {pages.map((page, i) => (
                                    <Pressable
                                        key={page.uri}
                                        onPress={() => setPages((prev) => prev.filter((p) => p.uri !== page.uri))}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Discard page ${i + 1}`}
                                    >
                                        <Image
                                            source={{ uri: page.uri }}
                                            style={{ width: 54, height: 72, borderRadius: theme.radii.sm }}
                                            contentFit="cover"
                                        />
                                        <View style={styles.discardBadge}>
                                            <Feather name="x" size={11} color="#fff" />
                                        </View>
                                    </Pressable>
                                ))}
                            </ScrollView>
                        ) : null}

                        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
                            <View style={{ width: 88 }} />
                            <Pressable
                                onPress={() => void shoot()}
                                accessibilityRole="button"
                                accessibilityLabel="Capture this page"
                                accessibilityState={{ busy }}
                                style={({ pressed }) => [
                                    styles.shutter,
                                    { opacity: pressed || busy ? 0.7 : 1 },
                                ]}
                            >
                                <View style={styles.shutterInner} />
                            </Pressable>
                            <View style={{ width: 88, alignItems: 'flex-end' }}>
                                {pages.length > 0 ? (
                                    <Button
                                        label={`Use ${pages.length}`}
                                        onPress={finish}
                                        accessibilityHint="Adds the captured pages to the upload queue"
                                    />
                                ) : null}
                            </View>
                        </View>
                    </>
                )}
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    topBar: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingBottom: 12,
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    filmstrip: { position: 'absolute', left: 0, right: 0, maxHeight: 80 },
    bottomBar: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 16,
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    shutter: {
        width: 72,
        height: 72,
        borderRadius: 36,
        borderWidth: 4,
        borderColor: '#fff',
        alignItems: 'center',
        justifyContent: 'center',
    },
    shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
    discardBadge: {
        position: 'absolute',
        top: -4,
        right: -4,
        width: 18,
        height: 18,
        borderRadius: 9,
        backgroundColor: 'rgba(0,0,0,0.8)',
        alignItems: 'center',
        justifyContent: 'center',
    },
});

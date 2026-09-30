/**
 * Scan a document with the camera.
 *
 * This is the one thing the phone does that the browser cannot, so it is a
 * first-class way to get a source into a notebook or a knowledge base rather
 * than a shortcut into the image picker.
 *
 * Multi-shot on purpose: paper documents have more than one page. Each shot
 * becomes its own upload — the server extracts text per file, so pages stay
 * separately retryable if one of them fails.
 *
 * A full-screen <Modal> rather than a route, because three screens own it and
 * a route would have to live in app/.
 *
 * Leaving (Back, the ✕, "Not now") with pages shot asks first: none of them is
 * uploaded until Done, so closing would throw them away.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useRef, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { deniedForGood, openAppSettings, useOnForeground } from '@/shared/device/appSettings';
import { useConfirm } from '@/shared/patterns';

import { CameraAccessOff } from './CameraAccessOff';
import { ScanBottomBar } from './ScanBottomBar';
import { ScanFilmstrip, type ScanPage } from './ScanFilmstrip';
import { scanStyles as styles } from './scanStyles';
import { ScanTopBar } from './ScanTopBar';
import type { UploadFile } from '../api/upload';

/** The camera does not report a byte count; 0 leaves the size check to the server. */
function toFiles(pages: ScanPage[], baseName: string): UploadFile[] {
    return pages.map((page, i) => ({
        uri: page.uri,
        name: pages.length > 1 ? `${baseName} page ${i + 1}.jpg` : `${baseName}.jpg`,
        mimeType: 'image/jpeg',
        size: 0,
    }));
}

/** The shutter, and the pages it has captured so far. */
function useScanPages() {
    const cameraRef = useRef<CameraView | null>(null);
    const [pages, setPages] = useState<ScanPage[]>([]);
    const [busy, setBusy] = useState(false);

    const shoot = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            // quality 0.8 rather than 1: a full-quality photo of an A4 page is
            // 6-8 MB and adds nothing an OCR pass can use.
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

    const reset = useCallback(() => {
        setPages([]);
        setBusy(false);
    }, []);

    const discard = (uri: string) => setPages((prev) => prev.filter((p) => p.uri !== uri));

    return { cameraRef, pages, busy, shoot, reset, discard };
}

/**
 * The camera permission. Once Android will no longer ask, "Allow" opens this
 * app's page in Android's settings, and the permission is read again whenever
 * the app comes back to the front, so turning it on there shows the camera.
 */
function useScanPermission(visible: boolean) {
    const [permission, requestPermission, getPermission] = useCameraPermissions();
    const blocked = Boolean(permission && deniedForGood(permission));
    useOnForeground(() => void getPermission(), visible && Boolean(permission) && !permission?.granted);
    const allow = async () => {
        if (!blocked) {
            await requestPermission();
            return;
        }
        await openAppSettings();
        await getPermission();
    };
    return { permission, blocked, allow };
}

/** Pages shot and not uploaded are lost on leaving; this asks before that happens. */
function useKeepPages(count: number) {
    const t = useTranslation();
    const confirm = useConfirm();
    return async (): Promise<boolean> => {
        if (count === 0) return true;
        return confirm({
            title: t('mobile.knowledge.scan_discard_title', 'Discard this scan?'),
            message:
                count === 1
                    ? t('mobile.knowledge.scan_discard_one', 'The page you scanned is not uploaded yet and will be lost.')
                    : t('mobile.knowledge.scan_discard_many', 'The {count} pages you scanned are not uploaded yet and will be lost.', { count }),
            confirmLabel: t('mobile.ui.discard', 'Discard'),
        });
    };
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
    const { permission, blocked, allow } = useScanPermission(visible);
    const { cameraRef, pages, busy, shoot, reset, discard } = useScanPages();
    const mayLeave = useKeepPages(pages.length);

    const finish = () => {
        const files = toFiles(pages, baseName);
        reset();
        onCapture(files);
    };

    const cancel = async () => {
        if (!(await mayLeave())) return;
        reset();
        onClose();
    };

    let body: React.ReactNode = null;
    if (permission && !permission.granted) {
        body = <CameraAccessOff blocked={blocked} onAllow={() => void allow()} onCancel={() => void cancel()} />;
    } else if (permission) {
        body = (
            <>
                {/* Documents are flat and high-contrast; auto flash blows a white page out. */}
                <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" flash="off" />
                <ScanTopBar count={pages.length} onClose={() => void cancel()} />
                <ScanFilmstrip pages={pages} onDiscard={discard} />
                <ScanBottomBar count={pages.length} busy={busy} onShoot={() => void shoot()} onFinish={finish} />
            </>
        );
    }

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={() => void cancel()} statusBarTranslucent>
            <View style={styles.root}>{body}</View>
        </Modal>
    );
}

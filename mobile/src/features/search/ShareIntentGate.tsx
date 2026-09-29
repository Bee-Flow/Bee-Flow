/**
 * Drains Android's share intent and sends the user to a new chat.
 *
 * Renders nothing. It has to be mounted ONCE, high in the tree and inside the
 * auth providers, because:
 *
 *   - `useShareIntent` reads a value the native module holds for the launch
 *     that delivered it. Mounted per-screen it would miss the cold-start case
 *     entirely, which is the common one: Bee Flow is not usually already open
 *     when you share something into it.
 *   - Navigating on a share only makes sense once the user is past the login /
 *     unlock gate. Pushing `/chat/new` at someone sitting on the PIN screen
 *     would bounce them straight back and lose the payload.
 *
 * The manifest filters are already declared (app.config.ts → expo-share-intent:
 * text/*, image/*, audio/*, video/*, and multi-share of image/* and PDFs), so
 * everything Android can hand over lands in one of the two branches below.
 */

import { useRouter } from 'expo-router';
import { useShareIntent } from 'expo-share-intent';
import { useEffect } from 'react';

import { stagePendingShare, type SharedFile } from './shareIntent';
import { useAuth } from '../../auth/AuthProvider';


export function ShareIntentGate() {
    const router = useRouter();
    const { stage } = useAuth();
    // `resetOnBackground: false` — a share that arrives while the app is being
    // brought to the foreground must survive the foreground transition, or the
    // payload is cleared before this effect ever sees it.
    const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
        resetOnBackground: false,
    });

    const signedIn = stage.kind === 'signed-in';

    useEffect(() => {
        if (!hasShareIntent || !signedIn) return;

        // `path` is already a readable local uri on Android — expo-share-intent
        // copies a content:// stream into the app's own cache before handing it
        // over, so the composer can read it without a content resolver.
        const files: SharedFile[] = (shareIntent.files ?? []).map<SharedFile>((file) => ({
            name: file.fileName,
            mimeType: file.mimeType,
            uri: file.path,
            size: file.size,
        }));

        stagePendingShare({
            text: shareIntent.text ?? null,
            webUrl: shareIntent.webUrl ?? null,
            files,
            receivedAt: Date.now(),
        });

        // Clear the native side immediately. The payload now lives in our own
        // store, and leaving it armed means the next foreground delivers it a
        // second time.
        resetShareIntent(true);

        // `new` is a real conversation id as far as the chat screen is
        // concerned (app/chat/[id].tsx treats it as "not saved yet"), so this
        // opens an empty chat rather than creating a server row for a message
        // the user may still cancel.
        router.push('/chat/new');
    }, [hasShareIntent, signedIn, shareIntent, resetShareIntent, router]);

    return null;
}

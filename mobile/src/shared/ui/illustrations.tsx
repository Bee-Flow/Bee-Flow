/**
 * The shared empty-state artwork, ported path for path from the web's
 * agent-hub/src/components/shared/illustrations.tsx (illustrations.lockstep
 * .test.ts holds the two together).
 *
 * Six scenes, because six is how many distinct "there is nothing here"
 * moments the product has — an inbox with no mail is not a search with no
 * hits, and a disconnected integration is not an empty one.
 *
 * Drawn rather than bundled as images, so they follow the theme: the line
 * work is the caller's `color` (the web's `currentColor`, tertiary text) and
 * the one accent stroke is the org accent. Deliberately flat and thin — a
 * signpost, not a picture.
 */

import React, { type ReactElement, type ReactNode } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

export type IllustrationName =
    | 'empty-inbox'
    | 'no-results'
    | 'no-files'
    | 'all-done'
    | 'not-connected'
    | 'broken';

interface ArtProps {
    /** The line work (the web's currentColor). */
    color: string;
    /** The one accent stroke. */
    accent: string;
}

/** The web's 5.5rem width on the 96×72 viewBox. */
const WIDTH = 88;
const HEIGHT = (WIDTH * 72) / 96;

function Frame({ color, children }: { color: string; children: ReactNode }) {
    return (
        <Svg
            width={WIDTH}
            height={HEIGHT}
            viewBox="0 0 96 72"
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.9}
        >
            {children}
        </Svg>
    );
}

/** A tray with the lid open and nothing in it. */
function EmptyInbox({ color, accent }: ArtProps) {
    return (
        <Frame color={color}>
            <Path d="M20 34h14l4 8h20l4-8h14v20a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4z" opacity={0.55} />
            <Path d="M28 34 34 18h28l6 16" opacity={0.35} />
            <Path d="M44 26h8" stroke={accent} />
        </Frame>
    );
}

/** A magnifier over an empty field. */
function NoResults({ color, accent }: ArtProps) {
    return (
        <Frame color={color}>
            <Circle cx={44} cy={32} r={14} opacity={0.55} />
            <Path d="m55 43 9 9" opacity={0.55} />
            <Path d="M38 32h12" stroke={accent} />
            <Path d="M26 58h44" opacity={0.25} />
        </Frame>
    );
}

/** A folder standing open. */
function NoFiles({ color, accent }: ArtProps) {
    return (
        <Frame color={color}>
            <Path d="M22 24h16l5 6h31v26a3 3 0 0 1-3 3H25a3 3 0 0 1-3-3z" opacity={0.55} />
            <Path d="M22 40h52" opacity={0.25} />
            <Path d="M44 48h8" stroke={accent} />
        </Frame>
    );
}

/** A checked circle — the good empty. */
function AllDone({ color, accent }: ArtProps) {
    return (
        <Frame color={color}>
            <Circle cx={48} cy={36} r={18} opacity={0.4} />
            <Path d="m40 36 6 6 12-13" stroke={accent} strokeWidth={2} />
        </Frame>
    );
}

/** Two plug halves that do not meet. */
function NotConnected({ color, accent }: ArtProps) {
    return (
        <Frame color={color}>
            <Path d="M26 36h12v-6a4 4 0 0 1 4-4h2v20h-2a4 4 0 0 1-4-4v-6" opacity={0.55} />
            <Path d="M70 36H58v-6a4 4 0 0 0-4-4h-2v20h2a4 4 0 0 0 4-4v-6" opacity={0.55} />
            <Path d="M46 36h4" stroke={accent} strokeDasharray="2 4" />
            <Path d="M20 36h4M72 36h4" opacity={0.3} />
        </Frame>
    );
}

/** A page with a break through it. */
function Broken({ color, accent }: ArtProps) {
    return (
        <Frame color={color}>
            <Path d="M32 16h20l12 12v28a3 3 0 0 1-3 3H32a3 3 0 0 1-3-3V19a3 3 0 0 1 3-3z" opacity={0.5} />
            <Path d="M52 16v12h12" opacity={0.4} />
            <Path d="m44 34-5 10h9l-4 10" stroke={accent} strokeWidth={2} />
        </Frame>
    );
}

export const ILLUSTRATIONS: Record<IllustrationName, (props: ArtProps) => ReactElement> = {
    'empty-inbox': EmptyInbox,
    'no-results': NoResults,
    'no-files': NoFiles,
    'all-done': AllDone,
    'not-connected': NotConnected,
    broken: Broken,
};

/** Render one by name; an unknown name renders nothing rather than throwing. */
export function Illustration({ name, color, accent }: ArtProps & { name: IllustrationName }) {
    const Art = Object.prototype.hasOwnProperty.call(ILLUSTRATIONS, name) ? ILLUSTRATIONS[name] : null;
    return Art ? <Art color={color} accent={accent} /> : null;
}

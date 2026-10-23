import type React from 'react';
import type DeckLookFields from './DeckLookFields';

export type DeckOptions = NonNullable<React.ComponentProps<typeof DeckLookFields>['options']>;

export type DeckSettings = NonNullable<React.ComponentProps<typeof DeckLookFields>['deck']>;

export type TextKey = 'companyName' | 'companyTagline' | 'companyAddress' | 'companyEmail' | 'companyPhone' | 'companyWebsite' | 'companyChamber' | 'companyVat' | 'companyIban' | 'footerText';

export type ColourKey = 'accent' | 'ink' | 'muted';

/** The organisation's house style, as far as this panel reads it. */
export type HouseStyle = { [K in TextKey | ColourKey]?: string } & {
    enabled?: boolean;
    logoDataUrl?: string;
    logoWidthMm?: number;
    font?: string;
    deck?: DeckSettings;
};

export interface HouseStylePanelProps {
    onBack: () => void;
}

export interface CardProps {
    title?: string;
    children?: React.ReactNode;
}

export interface NoticeProps {
    tone: string;
    children?: React.ReactNode;
}

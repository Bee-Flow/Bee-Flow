import React from 'react';
import AppIcon from '../../components/icons/AppIcon';
import EditableText from '../components/EditableText';

export interface SocialProofChip {
    label?: string;
    /** Name of a catalogue icon; empty = no icon. */
    icon?: string;
}

/**
 * Honest-proof chips ("EU-hosted", "Open source", "GDPR") for a product that
 * has no logos to show. Body font by default, so it reads as part of the page
 * and not as the mono-caps register of the trust band.
 */
export default function SocialProofChips({ chips }: { chips: SocialProofChip[] }) {
    return (
        <ul className="social-proof-chips">
            {chips.map((chip, i) => (
                <li key={i} className="social-proof-chip">
                    {chip.icon ? <AppIcon name={chip.icon} className="social-proof-chip-icon" aria-hidden="true" /> : null}
                    <EditableText
                        as="span"
                        path={`socialProof.chips.${i}.label`}
                        placeholder="Label"
                    >
                        {chip.label || ''}
                    </EditableText>
                </li>
            ))}
        </ul>
    );
}

export interface SocialProofStat {
    number?: string;
    label?: string;
}

/** The hard-numbers row (stars, users, uptime) of the numbers and stats variants. */
export function SocialProofStats({ stats }: { stats: SocialProofStat[] }) {
    return (
        <div className="social-proof-stats reveal">
            {stats.map((s, i) => (
                <div key={i} className="social-proof-stat">
                    <EditableText
                        as="div"
                        path={`socialProof.stats.${i}.number`}
                        placeholder="4.7★"
                        className="social-proof-stat-number tnum"
                    >
                        {s.number || ''}
                    </EditableText>
                    <EditableText
                        as="div"
                        path={`socialProof.stats.${i}.label`}
                        placeholder="G2 rating"
                        className="social-proof-stat-label"
                    >
                        {s.label || ''}
                    </EditableText>
                </div>
            ))}
        </div>
    );
}

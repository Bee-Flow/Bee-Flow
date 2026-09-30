/** The user's own shield switches. Everything but the master switch needs it on. */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, ToggleRow } from '@/shared/ui';

import type { UserShield } from '../model/types';

export function YourShieldGroup({
    shield,
    onChange,
}: {
    shield: UserShield;
    onChange: (changes: Partial<UserShield>) => void;
}) {
    const theme = useTheme();
    return (
        <Group
            title="Your shield"
            footer="Applies to everything you send from any device signed in to this account."
        >
            <ToggleRow
                label="Privacy Shield"
                description="Screen your messages before they reach a model"
                value={shield.enabled}
                onValueChange={(value) => onChange({ enabled: value })}
                icon={
                    <Icon
                        name="Shield"
                        size={16}
                        color={shield.enabled ? theme.colors.success : theme.colors.textMuted}
                    />
                }
            />
            <ToggleRow
                label="Detect personal data"
                description="Find names, numbers and identifiers in what you send"
                value={shield.piiDetectionEnabled}
                disabled={!shield.enabled}
                onValueChange={(value) => onChange({ piiDetectionEnabled: value })}
            />
            <ToggleRow
                label="EU-only models"
                description="Route your work to models hosted in the EU"
                value={shield.euModeEnabled}
                disabled={!shield.enabled}
                onValueChange={(value) => onChange({ euModeEnabled: value })}
                icon={<Icon name="Globe" size={16} color={theme.colors.textSecondary} />}
            />
            <ToggleRow
                label="No web search on uploads"
                description="Keep uploaded documents out of any web lookup"
                value={shield.disableSearchOnUpload}
                disabled={!shield.enabled}
                onValueChange={(value) => onChange({ disableSearchOnUpload: value })}
            />
        </Group>
    );
}

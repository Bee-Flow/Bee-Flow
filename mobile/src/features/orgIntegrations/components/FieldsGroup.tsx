/** A titled card of text fields, padded like the kit's rows. */

import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Group } from '@/shared/ui';

const styles = StyleSheet.create({ fields: { padding: 12, gap: 12 } });

export function FieldsGroup({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
    return (
        <Group title={title} footer={footer}>
            <View style={styles.fields}>{children}</View>
        </Group>
    );
}

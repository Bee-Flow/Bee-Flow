/** Datatables. The screen lives in features/datatables; `?new=1` opens the New table sheet. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { DatatablesScreen } from '@/features/datatables';

export default function DatatablesRoute() {
    const params = useLocalSearchParams<{ new?: string }>();
    return <DatatablesScreen startCreating={params.new === '1'} />;
}

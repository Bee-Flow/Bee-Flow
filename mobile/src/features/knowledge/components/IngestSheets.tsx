/**
 * The add sheet and the scanner of an ingest flow (hooks/useIngestFlow.ts).
 * The scanner is a sibling of the sheet, not inside it, so it survives the
 * sheet closing when "Scan with the camera" is chosen.
 */

import React from 'react';

import { Sheet } from '@/shared/ui';

import { AddSourceBody } from './AddSourceSheet';
import { ScanCamera } from './ScanCamera';
import type { IngestFlow } from '../hooks/useIngestFlow';

export function IngestSheets({
    flow,
    title,
    subtitle,
    accepts,
    scanName,
}: {
    flow: IngestFlow;
    title: string;
    subtitle?: string;
    /** e.g. "PDF, Word, Excel, CSV or text · up to 20 MB". */
    accepts: string;
    /** Names the scanned files; the scanner's own default when omitted. */
    scanName?: string;
}) {
    return (
        <>
            <Sheet
                visible={flow.addOpen}
                onClose={() => flow.setAddOpen(false)}
                title={title}
                subtitle={subtitle}
                scroll={false}
            >
                <AddSourceBody
                    accepts={accepts}
                    busy={flow.busy}
                    onFiles={(files) => {
                        flow.setAddOpen(false);
                        flow.uploads.add(files);
                    }}
                    onScan={() => {
                        flow.setAddOpen(false);
                        flow.setScanOpen(true);
                    }}
                    onUrl={flow.addUrl}
                    onText={flow.addText}
                />
            </Sheet>

            <ScanCamera
                visible={flow.scanOpen}
                onClose={() => flow.setScanOpen(false)}
                baseName={scanName}
                onCapture={(files) => {
                    flow.setScanOpen(false);
                    flow.uploads.add(files);
                }}
            />
        </>
    );
}

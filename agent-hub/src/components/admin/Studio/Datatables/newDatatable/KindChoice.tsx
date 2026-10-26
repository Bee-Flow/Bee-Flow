import { Cloud, FileSpreadsheet } from 'lucide-react';
import React from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import ChoiceCard from '../ChoiceCard';
import { ssReasonText } from '../spreadsheet/wizardState';
import type { Linkable, StorageProbe } from './useLinkSources';

interface KindChoiceProps {
    kind: string;
    setKind: (kind: string) => void;
    managed: boolean;
    nextcloud: boolean;
    spreadsheet: boolean;
    offerNextcloud: boolean;
    offerSpreadsheet: boolean;
    linkable: Linkable | null;
    ssConnected: boolean;
    providers: StorageProbe[];
    t: TranslateFn;
}

/** Why the Nextcloud card is off right now — the server's reason, as a sentence. */
function reasonText(t: TranslateFn, reason: string | undefined): string {
    switch (reason) {
        case 'nc_scope_denied':
            return t('datatables.nc_reason_scope_off', 'Bee Flow may not read this account’s Nextcloud tables yet. Switch Tables on under Settings → Connections → Nextcloud.');
        case 'nextcloud_integration_off':
            return t('datatables.nc_reason_integration_off', 'Nextcloud Tables is switched off for this organisation. An administrator can switch it on under Organisation → Nextcloud.');
        case 'not_nc_org':
            return t('datatables.err_not_nc_org', 'This organisation is not connected to Nextcloud.');
        default:
            return t('datatables.nc_reason_unavailable', 'Nextcloud could not be reached just now.');
    }
}

export default function KindChoice({ kind, setKind, managed, nextcloud, spreadsheet, offerNextcloud, offerSpreadsheet, linkable, ssConnected, providers, t }: KindChoiceProps) {
    return (
        <fieldset>
            <legend className="block text-sm font-medium mb-2 text-[var(--text-primary)]">
                {t('datatables.new_kind', 'What kind of table?')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
                <ChoiceCard
                    name="datatable-kind"
                    checked={kind === 'plain'}
                    onChange={() => setKind('plain')}
                    kind="datatable"
                    title={t('datatables.kind_plain', 'An ordinary table')}
                    blurb={t('datatables.kind_plain_blurb', 'You decide the columns. Automations read and write the rows.')}
                />
                <ChoiceCard
                    name="datatable-kind"
                    checked={managed}
                    onChange={() => setKind('http_cache')}
                    kind="app"
                    title={t('datatables.kind_http_cache', 'Web service answers')}
                    blurb={t('datatables.kind_http_cache_blurb', 'For the “remember answers in a table” tick on a Call a web service step. Its columns are fixed, because an automation writes them by name.')}
                />
                {offerNextcloud && (
                    <ChoiceCard
                        name="datatable-kind"
                        checked={nextcloud}
                        onChange={() => setKind('nextcloud_table')}
                        kind="datatable"
                        icon={<Cloud className="w-3.5 h-3.5 shrink-0 [color:var(--type-data)]" aria-hidden="true" />}
                        title={t('datatables.kind_nextcloud', 'A table from Nextcloud')}
                        blurb={t('datatables.kind_nextcloud_blurb', 'A copy of a Nextcloud Tables table or view, kept in step with it. Rows changed here are changed in Nextcloud; the columns are Nextcloud’s.')}
                        disabled={!!linkable && !linkable.connected}
                        note={linkable && !linkable.connected ? reasonText(t, linkable.reason) : null}
                    />
                )}
                {offerSpreadsheet && (
                    <ChoiceCard
                        name="datatable-kind"
                        checked={spreadsheet}
                        onChange={() => setKind('spreadsheet_file')}
                        kind="datatable"
                        icon={<FileSpreadsheet className="w-3.5 h-3.5 shrink-0 [color:var(--type-data)]" aria-hidden="true" />}
                        title={t('datatables.kind_spreadsheet', 'A spreadsheet from your files')}
                        blurb={t('datatables.kind_spreadsheet_blurb', 'A copy of a sheet in Google Drive, OneDrive or Nextcloud, kept in step with the file. Rows changed here are written to the file; the columns are the sheet’s header row.')}
                        disabled={!ssConnected}
                        note={!ssConnected ? ssReasonText(t, providers[0]) : null}
                    />
                )}
            </div>
        </fieldset>
    );
}

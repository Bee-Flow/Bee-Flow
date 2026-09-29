import { X, ImageDown, FileDown, Link, Copy, Check, Share2, Award, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import Modal from '../../../components/shared/Modal';
import { Eyebrow, PrimaryButton, SecondaryButton } from './bits';
import { fetchAssetObjectUrl, downloadAsset } from '../../../components/onboarding/achievements';

/**
 * CertificateDrawer — artboard 1e: the in-app drawer for an issued
 * certificate. A 480px right-hand panel: eyebrow + title, the rendered
 * certificate preview, Download PNG / PDF, and the "Make public & share"
 * switch. Sharing is opt-in — without the switch the verify link does not
 * exist; with it, the copyable link and the LinkedIn button appear.
 *
 * Props: cert (issued entry with imageUrl/pdfUrl/verifyUrl/linkedInUrl/isPublic),
 *        busy, onTogglePublic(makePublic), onClose, t
 */
export default function CertificateDrawer({ cert, busy, onTogglePublic, onClose, t }) {
    const [imgSrc, setImgSrc] = useState(null);
    const [imgError, setImgError] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let url;
        let cancelled = false;
        setImgSrc(null); setImgError(false);
        (async () => {
            try {
                url = await fetchAssetObjectUrl(cert.imageUrl);
                if (!cancelled) setImgSrc(url);
            } catch (_) { if (!cancelled) setImgError(true); }
        })();
        return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
    }, [cert.imageUrl]);

    const copyVerify = async () => {
        try { await navigator.clipboard.writeText(cert.verifyUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch (_) { /* ignore */ }
    };
    // Public but no link: the deployment has no public base URL to mint one.
    const noPublicUrl = !!cert.isPublic && !cert.verifyUrl;

    return (
        <Modal
            open
            onClose={onClose}
            variant="bare"
            placement="right"
            size="auto"
            zIndex={1000}
            label={cert.title}
            className="w-[480px] max-w-full h-full"
            data-testid="certificate-drawer"
        >
            <div className="flex flex-col min-h-0 h-full w-full"
                style={{ background: 'var(--bg-card)', borderLeft: '1px solid var(--border-default)', boxShadow: 'var(--shadow-popover)', fontSize: 13, color: 'var(--text-primary)' }}>
                <div className="flex items-center gap-2 flex-shrink-0" style={{ height: 48, padding: '0 10px 0 16px', borderBottom: '1px solid var(--border-default)' }}>
                    <div className="min-w-0 flex-1">
                        <Eyebrow accent>{t('learn.cert.drawer_label', 'Certificate')}</Eyebrow>
                        <div className="font-semibold text-[14px] leading-[18px] truncate">{cert.title}</div>
                    </div>
                    <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="grid place-items-center w-7 h-7 rounded-lg hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-secondary)' }}>
                        <X style={{ width: 14, height: 14 }} />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3.5 text-[12px]" style={{ padding: 16 }}>
                    {/* Preview */}
                    <div className="relative overflow-hidden rounded-[10px]" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
                        <div style={{ height: 6, background: 'var(--accent-primary)' }} />
                        {imgSrc ? (
                            <img src={imgSrc} alt={cert.title} className="w-full h-auto block" />
                        ) : (
                            <div className="flex flex-col gap-1.5" style={{ padding: '16px 18px', minHeight: 150 }}>
                                <div className="flex items-center gap-1.5">
                                    <span className="text-[16px] leading-none" aria-hidden="true">🐝</span>
                                    <span className="uppercase font-semibold" style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--text-tertiary)' }}>{t('learn.cert.brand', 'Bee Flow AI Certified')}</span>
                                </div>
                                <div className="text-[22px] font-bold leading-[26px]">{cert.level || cert.title}</div>
                                <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                                    {imgError ? t('learn.cert.preview_failed', 'Could not load the preview — the download still works.') : <span className="inline-flex items-center gap-1.5"><Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />{t('learn.cert.preview_loading', 'Rendering the preview…')}</span>}
                                </div>
                                <div className="absolute grid place-items-center rounded-full" style={{ right: 18, bottom: 16, width: 44, height: 44, border: '2px solid var(--accent-primary)', color: 'var(--accent-primary)' }} aria-hidden="true">
                                    <Award style={{ width: 20, height: 20 }} />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex gap-2">
                        <SecondaryButton className="flex-1" onClick={() => downloadAsset(cert.imageUrl, `beeflow-certificate-${cert.serial || 'cert'}.png`)}>
                            <ImageDown style={{ width: 13, height: 13 }} aria-hidden="true" />{t('learn.cert.download_png_full', 'Download PNG')}
                        </SecondaryButton>
                        <SecondaryButton className="flex-1" onClick={() => downloadAsset(cert.pdfUrl, `beeflow-certificate-${cert.serial || 'cert'}.pdf`)}>
                            <FileDown style={{ width: 13, height: 13 }} aria-hidden="true" />{t('learn.cert.download_pdf_full', 'Download PDF')}
                        </SecondaryButton>
                    </div>

                    <div className="flex flex-col gap-2.5" style={{ borderTop: '1px solid var(--border-default)', paddingTop: 12 }}>
                        <div className="flex items-center gap-2.5">
                            <div className="flex-1 min-w-0">
                                <div className="font-semibold">{t('learn.cert.make_public', 'Make public & share')}</div>
                                <div className="text-[11px] leading-[15px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.cert.public_explainer', 'Creates a verification link. Without this switch the link does not exist; you can revoke it at any time.')}</div>
                            </div>
                            <button type="button" role="switch" aria-checked={!!cert.isPublic} disabled={busy} onClick={() => onTogglePublic(!cert.isPublic)}
                                aria-label={t('learn.cert.make_public', 'Make public & share')}
                                className="relative flex-shrink-0 rounded-full transition disabled:opacity-50"
                                style={{ width: 34, height: 20, background: cert.isPublic ? 'var(--accent-primary)' : 'var(--bg-tertiary)' }}>
                                <span className="absolute rounded-full" style={{ top: 2, left: cert.isPublic ? 16 : 2, width: 16, height: 16, background: '#fff', boxShadow: 'var(--shadow-sm)', transition: 'left .15s' }} />
                            </button>
                        </div>
                        {cert.isPublic && cert.verifyUrl && (
                            <>
                                <div className="flex items-center gap-2 rounded-lg" style={{ padding: '7px 10px', border: '1px solid var(--border-default)', background: 'var(--bg-secondary)' }}>
                                    <Link style={{ width: 12, height: 12, color: 'var(--text-tertiary)', flexShrink: 0 }} aria-hidden="true" />
                                    <span className="flex-1 min-w-0 truncate text-[11px]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', color: 'var(--text-secondary)' }}>{cert.verifyUrl.replace(/^https?:\/\//, '')}</span>
                                    <button type="button" onClick={copyVerify} className="inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap rounded-md" style={{ padding: '3px 8px', background: 'var(--bg-card)', border: '1px solid var(--border-default)' }}>
                                        {copied ? <Check style={{ width: 11, height: 11, color: 'var(--learn-complete)' }} /> : <Copy style={{ width: 11, height: 11 }} aria-hidden="true" />}
                                        {copied ? t('learn.cert.copied', 'Copied') : t('learn.cert.copy', 'Copy')}
                                    </button>
                                </div>
                                {cert.linkedInUrl && (
                                    <PrimaryButton onClick={() => window.open(cert.linkedInUrl, '_blank', 'noopener')}>
                                        <Share2 style={{ width: 13, height: 13 }} aria-hidden="true" />{t('learn.cert.add_linkedin', 'Add to LinkedIn')}
                                    </PrimaryButton>
                                )}
                            </>
                        )}
                        {noPublicUrl && (
                            <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.cert.no_public_url', 'A public verify link isn’t available on this deployment — your certificate PNG/PDF download still works.')}</div>
                        )}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

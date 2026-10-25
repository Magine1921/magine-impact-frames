'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Images, Loader2, Maximize2, Replace, Upload, X } from 'lucide-react';
import { useMaterialRefs } from '../canvas/useCanvasDerivedData';
import { MediaPreviewOverlay, ZoomableImagePreview } from '../canvas/MediaZoomPan';
import { getMaterialReferenceKind, type MaterialRef } from '@/lib/material-mentions';
import { getMaterialBlob, isMaterialIdbRef, materialRefToNodeId } from '@/lib/canvas-material-idb';
import { resolveMaterialPlayableUrl } from '@/lib/material-disk-playable-url';
import { getMaterialKindFromFile, resolveMaterialMediaAspect } from '@/lib/material-import-from-file';
import { sniffBinaryMedia } from '@/lib/maginecanvas-media-binary';

const actionClass = 'nodrag nopan inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-black/25 px-2.5 py-2 text-xs text-zinc-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';

async function imageBlobDataUrl(blob: Blob): Promise<string> {
  const detected = sniffBinaryMedia(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
  const mime = detected.kind === 'image' ? detected.mime : blob.type;
  if (!blob.size || !mime.startsWith('image/')) throw new Error('请选择可读取的图片文件');
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择'));
    reader.readAsDataURL(blob.slice(0, blob.size, mime));
  });
  if (!await resolveMaterialMediaAspect('image', url)) throw new Error('图片无法解码，请选择其他图片');
  return url;
}

async function originalImageUrl(source: string): Promise<string> {
  let url = source;
  if (isMaterialIdbRef(url)) {
    url = (await getMaterialBlob(materialRefToNodeId(url), { requireOriginal: true }))?.fileUrl || '';
    if (!url || isMaterialIdbRef(url)) throw new Error('原图片缺失，请重新导入素材');
  }
  url = resolveMaterialPlayableUrl(url, 'image');
  if (url.startsWith('blob:')) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('原图片读取失败，请重新导入素材');
    return imageBlobDataUrl(await response.blob());
  }
  return url;
}

function CanvasImageThumbnail({ image }: { image: MaterialRef }) {
  const source = image.thumbnailUrl || image.fileUrl;
  const [url, setUrl] = useState(() => isMaterialIdbRef(source) ? '' : resolveMaterialPlayableUrl(source, 'image'));
  useEffect(() => {
    let active = true;
    void originalImageUrl(source).then((next) => { if (active) setUrl(next); }).catch(() => { if (active) setUrl(''); });
    return () => { active = false; };
  }, [source]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="aspect-video w-full rounded-md object-cover" />
    : <span className="flex aspect-video items-center justify-center rounded-md bg-white/5"><Images className="h-5 w-5 text-zinc-500" /></span>;
}

function ReplacementDialog({ disabled, onReplace, onClose }: {
  disabled: boolean;
  onReplace: (url: string) => Promise<void>;
  onClose: () => void;
}) {
  const materials = useMaterialRefs();
  const images = useMemo(() => materials.filter((item) => item.fileUrl && !item.fileUrl.startsWith('asset:') && getMaterialReferenceKind(item) === 'image'), [materials]);
  const [showCanvas, setShowCanvas] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = useCallback(() => { if (!busyRef.current) onClose(); }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
      if (!buttons.length) { event.preventDefault(); return; }
      const target = event.shiftKey ? buttons.at(-1)! : buttons[0];
      if (!buttons.includes(document.activeElement as HTMLButtonElement) || document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) {
        event.preventDefault(); target.focus();
      }
    };
    window.addEventListener('keydown', keyDown, true);
    return () => { window.removeEventListener('keydown', keyDown, true); previous?.focus(); };
  }, [close]);

  const replace = async (source: string | File) => {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try {
      if (source instanceof File && getMaterialKindFromFile(source) !== 'image') throw new Error('请选择图片文件');
      const url = source instanceof File ? await imageBlobDataUrl(source) : await originalImageUrl(source);
      if (typeof source === 'string' && !await resolveMaterialMediaAspect('image', url)) throw new Error('原图片无法读取，请重新导入素材');
      await onReplace(url);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图片替换失败，请重试');
    } finally {
      busyRef.current = false; setBusy(false);
    }
  };

  return <MediaPreviewOverlay ariaLabel="替换冲击图" className="flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onClose={close}>
    <div ref={dialogRef} className={`flex max-h-[80vh] w-full flex-col rounded-2xl border border-white/15 bg-[#202020] p-4 shadow-2xl ${showCanvas && images.length ? 'max-w-md' : 'max-w-xs'}`} onKeyDown={(event) => event.stopPropagation()}>
      <div className="relative mb-3 flex h-7 shrink-0 items-center justify-center text-sm font-medium text-zinc-100">
        <span>替换冲击图</span>
        <button type="button" aria-label="关闭图片替换" disabled={busy} onClick={close} className="absolute right-0 rounded-md p-1.5 hover:bg-white/10 disabled:opacity-40"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2">
        <button type="button" disabled={busy || disabled} onClick={() => { setShowCanvas(true); setError(''); }} className={`${actionClass} h-10 w-full`}><Images className="h-4 w-4" />从画布选择</button>
        <button type="button" disabled={busy || disabled} onClick={() => fileInput.current?.click()} className={`${actionClass} h-10 w-full`}><Upload className="h-4 w-4" />从本机选择</button>
      </div>
      <input ref={fileInput} data-impact-replace-file aria-label="从本机选择冲击图" type="file" accept="image/*" className="hidden" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void replace(file);
      }} />
      {showCanvas && <div className="mt-3 grid min-h-0 grid-cols-3 gap-2 overflow-y-auto">
        {images.map((item) => <button key={item.nodeId} type="button" data-impact-replace-canvas-image={item.nodeId} aria-label={`选择 ${item.fileName || item.slug}`} disabled={busy || disabled} onClick={() => void replace(item.fileUrl)} className="min-w-0 rounded-lg border border-white/10 p-1.5 text-left hover:border-violet-300/60 hover:bg-white/5 disabled:opacity-40">
          <CanvasImageThumbnail image={item} />
          <span className="mt-1.5 block truncate text-[11px] text-zinc-300">{item.fileName || item.slug}</span>
        </button>)}
        {!images.length && <p className="col-span-3 py-6 text-center text-xs text-zinc-400">画布中暂无可用图片，可从本机选择。</p>}
      </div>}
      {busy && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-zinc-300"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取并保存图片…</p>}
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
    </div>
  </MediaPreviewOverlay>;
}

export function ImpactFrameReplaceButton({ disabled, onReplace }: { disabled: boolean; onReplace: (url: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <button type="button" data-impact-replace aria-label="替换冲击图" disabled={disabled} onClick={() => setOpen(true)} className={actionClass}><Replace className="h-3.5 w-3.5" />替换</button>
    {open && createPortal(<ReplacementDialog disabled={disabled} onReplace={onReplace} onClose={close} />, document.body)}
  </>;
}

export function ImpactFrameZoomButton({ imageUrl, label = '冲击图大图' }: { imageUrl: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" data-impact-zoom aria-label="放大查看冲击图" title="放大查看" onClick={(event) => { event.stopPropagation(); setOpen(true); }} className="nodrag nopan absolute bottom-2 right-2 z-10 rounded-md border border-white/20 bg-black/65 p-1.5 text-white backdrop-blur-sm hover:bg-black/85"><Maximize2 className="h-3.5 w-3.5" /></button>
    {open && createPortal(<ZoomableImagePreview src={resolveMaterialPlayableUrl(imageUrl, 'image')} alt={label} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

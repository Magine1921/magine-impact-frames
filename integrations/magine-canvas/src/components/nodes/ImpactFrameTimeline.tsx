'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';

type ImpactFrameTimelineProps = {
  videoUrl: string;
  duration: number;
  time: number;
  points: { id: string; time: number }[];
  activePointId?: string;
  disabled: boolean;
  onSeek: (time: number) => void;
  onSelectPoint: (id: string) => void;
};

const THUMBNAIL_COUNT = 8;

function clockTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

export default function ImpactFrameTimeline({ videoUrl, duration, time, points, activePointId, disabled, onSeek, onSelectPoint }: ImpactFrameTimelineProps) {
  const [filmstrip, setFilmstrip] = useState<{ key: string; images: string[] }>({ key: '', images: [] });
  const dragging = useRef<number | null>(null);
  const key = `${videoUrl}|${duration}`;
  const images = filmstrip.key === key ? filmstrip.images : [];
  const maxTime = Math.max(0, duration - 0.08);
  const position = (seconds: number) => maxTime > 0 ? Math.min(100, Math.max(0, seconds / maxTime * 100)) : 0;
  const playhead = position(time);

  useEffect(() => {
    if (!videoUrl || !Number.isFinite(duration) || duration <= 0) return;
    const controller = new AbortController();
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 144;
    const context = canvas.getContext('2d');

    const waitFor = (event: 'loadeddata' | 'seeked', start: () => void) => new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        video.removeEventListener(event, ready);
        video.removeEventListener('error', failed);
        controller.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new Error('时间轨预览读取失败'));
      const aborted = () => finish(new Error('时间轨预览已取消'));
      const timer = window.setTimeout(failed, 15000);
      video.addEventListener(event, ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      controller.signal.addEventListener('abort', aborted, { once: true });
      try { start(); } catch { failed(); }
    });

    void (async () => {
      if (!context) return;
      await waitFor('loadeddata', () => { video.src = videoUrl; video.load(); });
      const thumbnails: string[] = [];
      for (let index = 0; index < THUMBNAIL_COUNT; index++) {
        if (controller.signal.aborted) return;
        const target = index / (THUMBNAIL_COUNT - 1) * Math.max(0, duration - 0.08);
        if (Math.abs(video.currentTime - target) > 0.0001) {
          await waitFor('seeked', () => { video.currentTime = target; });
        }
        if (controller.signal.aborted || !video.videoWidth || !video.videoHeight) return;
        const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;
        context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        thumbnails.push(canvas.toDataURL('image/jpeg', 0.7));
        setFilmstrip({ key, images: [...thumbnails] });
      }
    })().catch(() => { /* The main video remains available if optional thumbnails cannot load. */ });

    return () => {
      controller.abort();
      video.pause();
      video.removeAttribute('src');
      video.load();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [videoUrl, duration, key]);

  const seekFromPointer = (event: PointerEvent<HTMLInputElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    onSeek(Math.min(maxTime, Math.round(ratio * maxTime * 1000) / 1000));
  };

  return (
    <div data-impact-timeline className="nodrag nopan cursor-default select-none">
      <div className="relative h-9">
        <div
          className="pointer-events-none absolute top-0 whitespace-nowrap rounded-full border border-white/15 bg-zinc-800 px-2.5 py-1 text-[10px] font-medium tabular-nums text-zinc-100 shadow-sm"
          style={{ left: `clamp(48px, ${playhead}%, calc(100% - 48px))`, transform: 'translateX(-50%)' }}
          title={`${time.toFixed(3)} / ${duration.toFixed(3)} 秒`}
        >{clockTime(time)} <span className="mx-1 text-zinc-500">|</span> {clockTime(duration)}</div>
      </div>
      <div className="relative rounded-md focus-within:ring-1 focus-within:ring-violet-300/70">
        <div data-impact-filmstrip className="flex h-14 overflow-hidden rounded-md border border-white/15 bg-black/40">
          {Array.from({ length: THUMBNAIL_COUNT }, (_, index) => (
            <div key={index} className="min-w-0 flex-1 overflow-hidden border-r border-black/25 last:border-0">
              {images[index] ? (
                // Generated local video thumbnails do not need Next Image optimization.
                // eslint-disable-next-line @next/next/no-img-element
                <img data-impact-thumb src={images[index]} alt="" draggable={false} className="h-full w-full object-cover" />
              ) : <div className="h-full w-full bg-white/5" />}
            </div>
          ))}
        </div>
        <input
          type="range"
          aria-label="冲击帧截取时间"
          aria-valuetext={`${time.toFixed(3)} 秒，共 ${duration.toFixed(3)} 秒`}
          min={0}
          max={maxTime}
          step={0.001}
          value={Math.max(0, Math.min(time, maxTime))}
          disabled={disabled || !maxTime}
          className="nodrag nopan absolute inset-0 z-10 m-0 h-full w-full touch-none cursor-default opacity-0"
          onChange={(event) => onSeek(Number(event.target.value))}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            dragging.current = event.pointerId;
            seekFromPointer(event);
          }}
          onPointerMove={(event) => {
            if (!disabled && dragging.current === event.pointerId) seekFromPointer(event);
          }}
          onPointerUp={(event) => {
            if (dragging.current !== event.pointerId) return;
            if (!disabled) seekFromPointer(event);
            dragging.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { dragging.current = null; }}
          onLostPointerCapture={() => { dragging.current = null; }}
        />
        <div
          data-impact-playhead
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-1 -top-2 z-20 w-0.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
          style={{ left: `${playhead}%` }}
        />
      </div>
      <div className="relative mt-1 h-6">
        {points.map((point, index) => (
          <button
            key={point.id}
            type="button"
            data-impact-point={point.id}
            aria-label={`冲击点 ${index + 1} · ${point.time.toFixed(3)}秒`}
            aria-pressed={point.id === activePointId}
            title={`截取点 ${index + 1} · ${point.time.toFixed(3)} 秒，点击编辑`}
            disabled={disabled}
            className={`nodrag nopan absolute top-1 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border text-[9px] tabular-nums transition-colors disabled:opacity-40 ${point.id === activePointId ? 'border-violet-300/70 bg-violet-300 text-zinc-950' : 'border-white/25 bg-zinc-800 text-zinc-300 hover:border-violet-300 hover:text-white'}`}
            style={{ left: `clamp(10px, ${position(point.time)}%, calc(100% - 10px))` }}
            onClick={() => onSelectPoint(point.id)}
          >{index + 1}</button>
        ))}
      </div>
    </div>
  );
}

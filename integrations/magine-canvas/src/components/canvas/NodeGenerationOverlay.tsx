'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { useMediaViewportVisibility } from '@/lib/use-media-viewport-visibility';

const generationProgressContinuity = new Map<string, number>();
const GENERATION_PROGRESS_CACHE_LIMIT = 500;

export function generationProgressPercent(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.round(progress))) : 0;
}

function rememberGenerationProgress(key: string | undefined, value: number): void {
  if (!key) return;
  generationProgressContinuity.set(key, generationProgressPercent(value));
  if (generationProgressContinuity.size <= GENERATION_PROGRESS_CACHE_LIMIT) return;
  const oldestKey = generationProgressContinuity.keys().next().value;
  if (oldestKey) generationProgressContinuity.delete(oldestKey);
}

function initialGenerationProgress(key: string | undefined, target: number): number {
  if (!key) return 0;
  const previous = generationProgressContinuity.get(key);
  if (previous === undefined || target < previous) return 0;
  return Math.min(previous, target);
}

function useSmoothGenerationProgress(progress: number, animate = true, continuityKey?: string): number {
  const target = generationProgressPercent(progress);
  const initial = initialGenerationProgress(continuityKey, target);
  const displayedRef = useRef(initial);
  const [displayed, setDisplayed] = useState(initial);

  useEffect(() => {
    let frame = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const settle = (value: number) => {
      displayedRef.current = value;
      setDisplayed(value);
      rememberGenerationProgress(continuityKey, value);
    };

    if (!animate || reducedMotion.matches || target <= displayedRef.current) {
      settle(target);
      return;
    }

    const start = displayedRef.current;
    const distance = target - start;
    const duration = Math.min(1200, Math.max(240, distance * 32));
    const startedAt = performance.now();
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - startedAt) / duration);
      const value = start + distance * ratio;
      displayedRef.current = value;
      const rounded = generationProgressPercent(value);
      rememberGenerationProgress(continuityKey, rounded);
      setDisplayed((current) => current === rounded ? current : rounded);
      if (ratio < 1) frame = requestAnimationFrame(tick);
      else settle(target);
    };
    const onReducedMotion = () => {
      if (!reducedMotion.matches) return;
      cancelAnimationFrame(frame);
      settle(target);
    };

    frame = requestAnimationFrame(tick);
    reducedMotion.addEventListener('change', onReducedMotion);
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion.removeEventListener('change', onReducedMotion);
    };
  }, [animate, continuityKey, target]);

  return animate ? displayed : target;
}

export function NodeGenerationPercent({
  progress,
  animated = true,
  continuityKey,
}: {
  progress: number;
  animated?: boolean;
  continuityKey?: string;
}) {
  const displayed = useSmoothGenerationProgress(progress, animated, continuityKey);
  return <span className="mc-generation-percent">{displayed}%</span>;
}

function FluidFlow() {
  return (
    <div className="mc-generation-fluid" aria-hidden="true">
      <span className="mc-generation-fluid-field mc-generation-fluid-field--blue" />
      <span className="mc-generation-fluid-field mc-generation-fluid-field--cyan" />
      <span className="mc-generation-fluid-field mc-generation-fluid-field--amber" />
      <span className="mc-generation-fluid-field mc-generation-fluid-field--pearl" />
      <span className="mc-generation-fluid-sheen" />
    </div>
  );
}

function PerimeterProgress({ percent }: { percent: number }) {
  return (
    <svg className="mc-generation-ring" aria-hidden="true">
      <rect className="mc-generation-ring-track" width="100%" height="100%" rx="8" pathLength="100" />
      <rect
        className="mc-generation-ring-value"
        width="100%"
        height="100%"
        rx="8"
        pathLength="100"
        strokeDasharray="100"
        strokeDashoffset={100 - percent}
      />
    </svg>
  );
}

/** Display only: visibility may pause the fluid motion, never the generation task. */
export const NodeGenerationOverlay = memo(function NodeGenerationOverlay({
  progress,
  label = '生成中',
  showPercent = true,
  continuityKey,
}: {
  progress: number;
  label?: string;
  showPercent?: boolean;
  continuityKey?: string;
}) {
  const [overlayRef, visible] = useMediaViewportVisibility<HTMLDivElement>();
  const percent = useSmoothGenerationProgress(progress, visible, continuityKey);

  return (
    <div
      ref={overlayRef}
      className="mc-generation-overlay"
      data-animated={visible}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${label} ${percent}%`}
    >
      <FluidFlow />
      <PerimeterProgress percent={percent} />
      {showPercent && <NodeGenerationPercent progress={percent} animated={false} />}
    </div>
  );
});

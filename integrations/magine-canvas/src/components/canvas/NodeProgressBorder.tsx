'use client';

import { memo, useEffect, useRef, useState } from 'react';

/** Mount inside a positioned container; the border never intercepts node controls. */
export const NodeProgressBorder = memo(function NodeProgressBorder({
  progress,
  borderRadius = 12,
  className,
}: {
  progress: number;
  borderRadius?: number;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, radius: borderRadius });
  const percent = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateSize = () => {
      // Computed layout pixels retain fractions and ignore React Flow's canvas scale.
      const style = getComputedStyle(svg);
      const width = parseFloat(style.width);
      const height = parseFloat(style.height);
      const parentStyle = svg.parentElement ? getComputedStyle(svg.parentElement) : null;
      // Canvas shell CSS can override the declared radius. The overlay starts inside its border.
      const radius = parentStyle
        ? Math.max(0, parseFloat(parentStyle.borderTopLeftRadius) - parseFloat(parentStyle.borderTopWidth))
        : borderRadius;
      setSize((current) => current.width === width && current.height === height && current.radius === radius
        ? current : { width, height, radius });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [borderRadius]);

  const width = Math.max(0, size.width - 2);
  const height = Math.max(0, size.height - 2);
  const radius = Math.max(0, Math.min(size.radius - 1, width / 2, height / 2));

  return (
    <svg
      ref={svgRef}
      className={className}
      data-node-progress-border=""
      data-progress={percent}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0,
        overflow: 'hidden', clipPath: `inset(0 round ${size.radius}px)`,
        pointerEvents: 'none', zIndex: 30, color: 'rgba(244, 244, 245, 0.8)' }}
    >
      {width > 0 && height > 0 && (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="1" y="1" width={width} height={height} rx={radius} opacity="0.16" />
          {percent > 0 && (
            <rect
              x="1"
              y="1"
              width={width}
              height={height}
              rx={radius}
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - percent}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 180ms linear' }}
            />
          )}
        </g>
      )}
    </svg>
  );
});

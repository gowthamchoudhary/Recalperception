import type { ReactNode, CSSProperties } from "react";

/**
 * Wraps children and overlays a proper SVG stitched border —
 * rounded-rect with round linecap dashes, consistent spacing.
 * Use instead of a plain CSS border on floating photo/video cards.
 */
type Props = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Border radius of the card in px — must match the card's own radius. */
  radius?: number;
  /** Stroke color (default: rgba(0,0,0,0.18) on light, rgba(255,255,255,0.18) on dark) */
  strokeColor?: string;
  strokeWidth?: number;
  dashLength?: number;
  dashGap?: number;
};

export function StitchedCard({
  children,
  className = "",
  style,
  radius = 16,
  strokeColor = "rgba(0,0,0,0.2)",
  strokeWidth = 1.5,
  dashLength = 5,
  dashGap = 4,
}: Props) {
  return (
    <div className={`relative ${className}`} style={style}>
      {children}
      {/* SVG overlay — pointer-events:none so it never blocks clicks */}
      <svg
        aria-hidden="true"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        style={{ borderRadius: radius }}
      >
        <rect
          x={strokeWidth / 2}
          y={strokeWidth / 2}
          width={`calc(100% - ${strokeWidth}px)`}
          height={`calc(100% - ${strokeWidth}px)`}
          rx={radius - strokeWidth / 2}
          ry={radius - strokeWidth / 2}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={`${dashLength} ${dashGap}`}
          strokeLinecap="round"
          /* small offset so the dash pattern starts cleanly at a corner */
          strokeDashoffset={dashLength / 2}
        />
      </svg>
    </div>
  );
}

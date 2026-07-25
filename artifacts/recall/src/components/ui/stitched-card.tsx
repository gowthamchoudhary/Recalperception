import type { ReactNode, CSSProperties } from "react";

/**
 * Stitched / dashed frame — matches the reference landing spec.
 *
 * The card has a solid outer background/border/shadow with a dashed inner
 * border inset a few pixels from the edge, rendered with a pseudo-element
 * so the dashes are rounded and look like scrapbook stitching rather than
 * a flat browser dashed border.
 */
type Props = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Color of the dashed inner border (default: rgba(20,20,15,0.28)). */
  stitchColor?: string;
  /** Distance the dashed border is inset from the card edge in px. */
  inset?: number;
  /** Stroke width of the dashed border in px. */
  strokeWidth?: number;
  /** Radius of the dashed border in px (outerRadius - inset). */
  radius?: number;
};

export function StitchedCard({
  children,
  className = "",
  style,
  stitchColor = "rgba(20,20,15,0.28)",
  inset = 5,
  strokeWidth = 2,
  radius = 9,
}: Props) {
  return (
    <div
      className={`relative ${className}`}
      style={style}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{
          top: inset,
          left: inset,
          right: inset,
          bottom: inset,
          borderRadius: radius,
          border: `${strokeWidth}px dashed ${stitchColor}`,
        }}
      />
    </div>
  );
}

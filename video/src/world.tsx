import React from "react";
import { interpolate, useCurrentFrame, Easing } from "remotion";
import { chalk, chalkDim, coral } from "./theme";

/**
 * One world, one camera.
 *
 * The first cut of this video was a deck: separate scenes, hard cuts, text
 * fading in place. Nothing was ever in the same space as anything else, so
 * nothing could move between them.
 *
 * Here the schematic is a single fixed coordinate space and the camera travels
 * through it. The treasury is somewhere. The gate is somewhere else. Getting
 * from one to the other is a move, not a cut, and value can be watched making
 * the same journey.
 */
export const WORLD_W = 2400;
// Tall enough to hold the counterparty agent below the pool. A node placed
// past this is silently clipped by the SVG canvas — its edges still draw,
// which makes the omission look like a styling bug rather than a bounds one.
export const WORLD_H = 1800;

export type Shot = { at: number; x: number; y: number; scale: number };

/** Where the camera is, given a list of shots it eases between. */
export function camera(frame: number, shots: Shot[]) {
  const times = shots.map((s) => s.at);
  const ease = Easing.bezier(0.65, 0, 0.2, 1);
  const pick = (key: "x" | "y" | "scale") =>
    interpolate(
      frame,
      times,
      shots.map((s) => s[key]),
      { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
    );
  return { x: pick("x"), y: pick("y"), scale: pick("scale") };
}

/** A point along a path, so a token can ride it. */
export function pointOn(path: SVGPathElement | null, t: number) {
  if (!path) return { x: 0, y: 0 };
  const len = path.getTotalLength();
  const p = path.getPointAtLength(len * Math.max(0, Math.min(1, t)));
  return { x: p.x, y: p.y };
}

/** A box in the schematic. Draws on, then holds. */
export const Node: React.FC<{
  x: number; y: number; w: number; h: number;
  title: string; sub?: string; sub2?: string;
  delay?: number; accent?: boolean; dashed?: boolean;
}> = ({ x, y, w, h, title, sub, sub2, delay = 0, accent, dashed }) => {
  const frame = useCurrentFrame();
  const draw = interpolate(frame - delay, [0, 20], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.bezier(0.4, 0, 0.2, 1),
  });
  const text = interpolate(frame - delay - 12, [0, 14], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const per = 2 * (w + h);

  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h}
        fill="none"
        stroke={accent ? coral : "rgba(226,236,252,0.34)"}
        strokeWidth={2}
        strokeDasharray={dashed ? "10 10" : per}
        strokeDashoffset={dashed ? 0 : per * (1 - draw)}
        opacity={dashed ? draw : 1}
      />
      <text
        x={x + 28} y={y + 52} fill={accent ? coral : chalk}
        fontFamily="'Barlow Semi Condensed', sans-serif" fontSize={34}
        letterSpacing="2.4" opacity={text}
      >
        {title}
      </text>
      {sub && (
        <text
          x={x + 28} y={y + 90} fill={chalkDim}
          fontFamily="'Barlow Semi Condensed', sans-serif" fontSize={24}
          letterSpacing="1.8" opacity={text}
        >
          {sub}
        </text>
      )}
      {sub2 && (
        <text
          x={x + 28} y={y + 122} fill={chalkDim}
          fontFamily="'Barlow Semi Condensed', sans-serif" fontSize={24}
          letterSpacing="1.8" opacity={text}
        >
          {sub2}
        </text>
      )}
    </g>
  );
};

/** A number that counts, because a number that simply appears is a label. */
export const Count: React.FC<{
  to: number; from?: number; delay?: number; dur?: number;
  format?: (n: number) => string;
  style?: React.CSSProperties;
}> = ({ to, from = 0, delay = 0, dur = 40, format = (n) => String(Math.round(n)), style }) => {
  const frame = useCurrentFrame();
  const v = interpolate(frame - delay, [0, dur], [from, to], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return <span style={style}>{format(v)}</span>;
};

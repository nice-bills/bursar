import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { chalk, chalkDim, coral, ink, label, mono } from "./theme";

/**
 * Real output, opening out of the node it belongs to.
 *
 * The diagram alone is an illustration: it shows what the system would do if it
 * existed. The proof is the terminal. So rather than cutting away to a terminal
 * scene, the box the camera is already looking at expands into one — the claim
 * and its evidence occupy the same place.
 */
export const Panel: React.FC<{
  at: number;
  hold: number;
  title: string;
  lines: { text: string; kind?: "ok" | "warn" | "dim" }[];
  /** Screen-space anchor, since the camera has already framed the subject. */
  side?: "left" | "right";
  cps?: number;
}> = ({ at, hold, title, lines, side = "left", cps = 46 }) => {
  const frame = useCurrentFrame();
  const f = frame - at;
  if (f < 0 || f > hold) return null;

  const open = interpolate(f, [0, 16], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.bezier(0.2, 0.9, 0.2, 1),
  });
  const close = interpolate(f, [hold - 14, hold], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const o = open * close;

  // Characters land at a steady rate so a hash takes the time it deserves.
  const budget = Math.max(0, ((f - 10) / 30) * cps);
  let spent = 0;

  return (
    <div
      style={{
        position: "absolute",
        [side]: 96,
        top: "50%",
        transform: `translateY(-50%) scaleY(${0.86 + open * 0.14})`,
        transformOrigin: "center",
        width: 1180,
        opacity: o,
        background: "rgba(11, 25, 66, 0.94)",
        border: `1px solid rgba(226,236,252,0.34)`,
        boxShadow: `0 40px 120px ${ink}`,
        padding: "36px 44px 42px",
      }}
    >
      <div
        style={{
          fontFamily: label, fontSize: 22, letterSpacing: "0.2em",
          textTransform: "uppercase", color: coral, marginBottom: 26,
        }}
      >
        {title}
      </div>

      {lines.map((l, i) => {
        const len = l.text.length || 1;
        const avail = budget - spent;
        spent += len + 4;
        if (avail <= 0) return null;
        const shown = l.text.slice(0, Math.floor(Math.min(len, avail)));
        const colour =
          l.kind === "ok" ? "#7fd6a3" : l.kind === "warn" ? coral : l.kind === "dim" ? chalkDim : chalk;
        return (
          <div
            key={i}
            style={{
              fontFamily: mono, fontSize: 27, lineHeight: 1.58, color: colour,
              whiteSpace: "pre", fontWeight: l.kind ? 400 : 600,
            }}
          >
            {shown || " "}
          </div>
        );
      })}
    </div>
  );
};

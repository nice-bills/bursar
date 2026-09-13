import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import {
  chalk, chalkDim, coral, ink, label, line, lineSoft, mono, serif, type Line,
} from "./theme";

/** The ruled border every frame sits inside. */
export const Sheet: React.FC<{ children: React.ReactNode; sheet?: string }> = ({
  children,
  sheet = "L-001",
}) => (
  <div style={{ position: "absolute", inset: 0, background: ink, overflow: "hidden" }}>
    <div style={{ position: "absolute", inset: 28, border: `1px solid ${line}` }} />
    <div
      style={{
        position: "absolute", left: 52, top: 46, fontFamily: label, fontSize: 15,
        letterSpacing: "0.18em", textTransform: "uppercase", color: coral,
      }}
    >
      Bursar · Sheet {sheet}
    </div>
    <div
      style={{
        position: "absolute", right: 52, top: 46, fontFamily: label, fontSize: 15,
        letterSpacing: "0.18em", textTransform: "uppercase", color: chalkDim,
      }}
    >
      Sepolia · 11155111
    </div>
    {children}
  </div>
);

/** Type settles in rather than sliding — a drawing does not swoosh. */
export const Settle: React.FC<{
  children: React.ReactNode;
  delay?: number;
  y?: number;
}> = ({ children, delay = 0, y = 14 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 22 });
  return (
    <div style={{ opacity: s, transform: `translateY(${(1 - s) * y}px)` }}>{children}</div>
  );
};

/**
 * A terminal that types itself.
 *
 * Characters land at a steady rate rather than per line, so long hashes take
 * the time they deserve and the eye can actually follow one.
 */
export const Terminal: React.FC<{
  lines: Line[];
  startAt?: number;
  cps?: number;
  fontSize?: number;
}> = ({ lines, startAt = 0, cps = 55, fontSize = 21 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const budget = Math.max(0, ((frame - startAt) / fps) * cps);

  let spent = 0;
  const rendered: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const len = l.text.length || 1;
    const available = budget - spent;
    if (available <= 0) break;
    const shown = l.text.slice(0, Math.floor(Math.min(len, available)));
    spent += len + 6; // a beat between lines, so it reads as typing not streaming

    const colour =
      l.kind === "cmd" ? chalk
      : l.kind === "head" ? chalk
      : l.kind === "ok" ? "#7fd6a3"
      : l.kind === "warn" ? coral
      : chalkDim;

    rendered.push(
      <div
        key={i}
        style={{
          fontFamily: mono,
          fontSize,
          lineHeight: 1.62,
          color: colour,
          fontWeight: l.kind === "head" || l.kind === "cmd" ? 700 : 400,
          whiteSpace: "pre",
        }}
      >
        {shown || " "}
      </div>,
    );
  }

  const done = spent <= budget;
  return (
    <div>
      {rendered}
      {!done && (
        <span
          style={{
            display: "inline-block", width: 11, height: fontSize,
            background: coral, marginTop: 4,
            opacity: Math.floor(frame / 8) % 2 ? 0.25 : 1,
          }}
        />
      )}
    </div>
  );
};

/** Draws an SVG path on, the way ink lays down. */
export const Ink: React.FC<{
  d: string;
  delay?: number;
  dur?: number;
  stroke?: string;
  width?: number;
  dash?: string;
  len?: number;
}> = ({ d, delay = 0, dur = 26, stroke = line, width = 1, dash, len = 1400 }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame - delay, [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <path
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeDasharray={dash ?? len}
      strokeDashoffset={dash ? 0 : len * (1 - p)}
      opacity={dash ? p : 1}
    />
  );
};

export const Caption: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => (
  <Settle delay={delay}>
    <div
      style={{
        fontFamily: label, fontSize: 17, letterSpacing: "0.16em",
        textTransform: "uppercase", color: chalkDim,
        borderTop: `1px solid ${lineSoft}`, paddingTop: 12, marginTop: 20,
      }}
    >
      {children}
    </div>
  </Settle>
);

export const Headline: React.FC<{ children: React.ReactNode; size?: number }> = ({
  children,
  size = 76,
}) => (
  <div
    style={{
      fontFamily: serif, fontWeight: 300, fontSize: size, lineHeight: 1.06,
      letterSpacing: "-0.02em", color: chalk, maxWidth: 1500,
    }}
  >
    {children}
  </div>
);

export const Em: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontStyle: "italic" }}>{children}</span>
);

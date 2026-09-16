import React from "react";
import {
  AbsoluteFill, Easing, interpolate, useCurrentFrame, spring, useVideoConfig,
} from "remotion";
import { chalk, chalkDim, coral, ink, label, serif } from "./theme";
import { camera, Count, Node, WORLD_H, WORLD_W } from "./world";
import { Panel } from "./panel";

/* ------------------------------------------------------------------ paths */
/* The geometry every scene shares. Value rides these; the camera visits them. */

const P = {
  earnToTreasury: "M560 420 H 800",
  treasuryToGate: "M1010 560 V 720",
  gateToPayout: "M1230 780 H 1420 V 360 H 1600",
  gateToKeeper: "M1230 780 H 1600",
  gateToYield: "M1230 780 H 1420 V 1160 H 1600",
  /* The leg that makes yield a round trip rather than a one-way door. */
  yieldToTreasury: "M1600 1230 H 1360 V 600 H 1010",
  /* Buying: the treasury paying another agent's invoice. */
  gateToAgent: "M1230 780 H 1420 V 1620 H 1600",
};

/* ----------------------------------------------------------------- pieces */

/**
 * Measure a path without mounting it.
 *
 * Remotion renders every frame from scratch and screenshots it; an effect that
 * sets state after paint has not run yet, so the token would be missing from
 * the very frame it needed to be in. Building a detached path and measuring it
 * during render keeps the position a pure function of the frame.
 */
function alongPath(d: string, t: number) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  const len = path.getTotalLength();
  const at = path.getPointAtLength(len * Math.max(0, Math.min(1, t)));
  return { x: at.x, y: at.y };
}

/** A unit of value, riding a path. Lands with a pulse. */
const Token: React.FC<{
  d: string; start: number; dur: number; label?: string; colour?: string;
}> = ({ d, start, dur, label: text, colour = coral }) => {
  const frame = useCurrentFrame();
  const f = frame - start;
  if (f < 0 || f > dur + 20) return null;

  const t = interpolate(f, [0, dur], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.bezier(0.5, 0, 0.3, 1),
  });
  const pt = alongPath(d, t);
  const land = interpolate(f - dur, [0, 12], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const fade = interpolate(f, [0, 6, dur + 12, dur + 20], [0, 1, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <g opacity={fade}>
      <circle cx={pt.x} cy={pt.y} r={16 + land * 26} fill={colour} opacity={0.2} />
      <circle cx={pt.x} cy={pt.y} r={12} fill={colour} />
      {text && (
        <text
          x={pt.x} y={pt.y - 38} fill={colour} textAnchor="middle"
          fontFamily="'Barlow Semi Condensed', sans-serif" fontSize={32} letterSpacing="1.6"
        >
          {text}
        </text>
      )}
    </g>
  );
};

/** A token that travels to the gate and is thrown back by it. */
const Rejected: React.FC<{ start: number; d: string }> = ({ start, d }) => {
  const frame = useCurrentFrame();
  const f = frame - start;
  if (f < 0 || f > 78) return null;

  // Out, held against the gate, then returned the way it came.
  const t = interpolate(f, [0, 30, 46, 74], [0, 0.92, 0.92, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.bezier(0.5, 0, 0.3, 1),
  });
  const pt = alongPath(d, t);
  const hit = interpolate(f, [30, 36, 50], [0, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const fade = interpolate(f, [0, 6, 68, 78], [0, 1, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <g opacity={fade}>
      <rect x={1010} y={694} width={220} height={10} fill={coral} opacity={hit} />
      <circle cx={pt.x} cy={pt.y} r={14 + hit * 22} fill={coral} opacity={0.25} />
      <circle cx={pt.x} cy={pt.y} r={13} fill={coral} />
      <text
        x={pt.x} y={pt.y - 40} fill={coral} textAnchor="middle"
        fontFamily="'Barlow Semi Condensed', sans-serif" fontSize={36} letterSpacing="1.6"
      >
        5.0
      </text>
    </g>
  );
};

/** The schematic. One object, always present, seen from wherever the camera is. */
const Schematic: React.FC = () => {
  const frame = useCurrentFrame();
  const flow = (d: string, delay: number, lit: number) => {
    const on = interpolate(frame - delay, [0, 22], [0, 1], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
    return (
      <path
        d={d} fill="none" stroke={coral} strokeWidth={3}
        strokeDasharray="14 18"
        strokeDashoffset={-(frame < 700 ? frame : 700 + (frame - 700) * 0.06) * 1.6}
        opacity={on * lit}
      />
    );
  };

  return (
    <svg width={WORLD_W} height={WORLD_H} style={{ position: "absolute", inset: 0 }}>
      <defs>
        <pattern id="hatch" width="14" height="14" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="14" stroke="rgba(239,106,82,0.5)" strokeWidth="3" />
        </pattern>
      </defs>

      {flow(P.earnToTreasury, 40, 1)}
      {flow(P.treasuryToGate, 120, 1)}
      {flow(P.gateToPayout, 300, 1)}
      {flow(P.gateToKeeper, 310, 1)}
      {flow(P.gateToYield, 320, 1)}
      {flow(P.yieldToTreasury, 1760, 1)}
      {flow(P.gateToAgent, 2180, 1)}

      <Node x={280} y={330} w={280} h={180} title="EARNINGS" sub="X402 · MPP" sub2="FEES" delay={10} />
      <Node x={800} y={400} w={420} h={200} title="TREASURY" sub="ORG SIGNER · TURNKEY" sub2="0X8D9ABC…FBDC9" delay={60} />

      <rect x={1010} y={700} width={220} height={160} fill="url(#hatch)"
        opacity={interpolate(frame - 150, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
      <Node x={1010} y={700} w={220} h={160} title="POLICY" sub="ALLOWLIST" sub2="CAPS" delay={150} accent />

      <Node x={1600} y={280} w={520} h={170} title="PAYOUT" sub="60 / 40 BY SHARE" delay={330} />
      <Node x={1600} y={700} w={520} h={170} title="GAS KEEPER" sub="RUNS WITHOUT THE AGENT" delay={345} />
      <Node x={1600} y={1080} w={520} h={170} title="AAVE V3" sub="LIVE PROTOCOL · READ AND WRITTEN" sub2="RATE GATES THE DEPOSIT" delay={360} />
      <Node x={1600} y={1540} w={520} h={170} title="ANOTHER AGENT" sub="LUCID · X402 INVOICE" sub2="PAID UNDER POLICY" delay={2180} />

      <Node x={280} y={980} w={420} h={170} title="INTENT LEDGER" sub="WRITTEN BEFORE SENDING" delay={200} dashed />

      {/* value making the journey */}
      <Token d={P.earnToTreasury} start={60} dur={38} label="0.0000041" />
      <Token d={P.treasuryToGate} start={200} dur={30} />
      <Rejected start={430} d={P.treasuryToGate} />
      <Token d={P.gateToPayout} start={620} dur={44} label="0.00000246" />
      <Token d={P.gateToKeeper} start={1320} dur={40} />
      <Token d={P.gateToYield} start={1345} dur={48} />
      {/* Aave hands it back, with interest. */}
      <Token d={P.yieldToTreasury} start={1800} dur={104} label="+0.1654" />
      {/* An invoice, paid only after the gate says so. */}
      <Token d={P.gateToAgent} start={2390} dur={124} label="0.01 USDC" />
    </svg>
  );
};

/* ------------------------------------------------------------------ chrome */

const Frame: React.FC = () => (
  <>
    {/* The diagram travels under the chrome, so the chrome needs its own ground. */}
    <div
      style={{
        position: "absolute", left: 0, right: 0, top: 0, height: 120,
        background: `linear-gradient(to bottom, ${ink} 45%, rgba(20,42,99,0) 100%)`,
        pointerEvents: "none",
      }}
    />
    <div style={{ position: "absolute", inset: 28, border: "1px solid rgba(226,236,252,0.3)", pointerEvents: "none" }} />
    <div style={{ position: "absolute", left: 52, top: 44, fontFamily: label, fontSize: 17, letterSpacing: "0.2em", textTransform: "uppercase", color: coral }}>
      Bursar · Sheet L-001
    </div>
    <div style={{ position: "absolute", right: 52, top: 44, fontFamily: label, fontSize: 17, letterSpacing: "0.2em", textTransform: "uppercase", color: chalkDim }}>
      Sepolia · 11155111
    </div>
  </>
);

/** Big, short, high contrast. A caption is not a paragraph. */
const Caption: React.FC<{
  at: number; hold?: number; children: React.ReactNode;
  sub?: React.ReactNode; bottom?: boolean;
}> = ({ at, hold = 100, children, sub, bottom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inS = spring({ frame: frame - at, fps, config: { damping: 200 }, durationInFrames: 20 });
  const out = interpolate(frame - at - hold, [0, 16], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const o = inS * out;
  if (o <= 0.001) return null;

  return (
    <div
      style={{
        position: "absolute", left: 0, right: 0,
        [bottom ? "bottom" : "top"]: 0,
        paddingLeft: 96, paddingRight: 96,
        paddingTop: bottom ? 190 : 130, paddingBottom: bottom ? 96 : 190,
        opacity: o, transform: `translateY(${(1 - inS) * 18}px)`,
        // The diagram runs underneath; a caption must never compete with it.
        background: bottom
          ? `linear-gradient(to top, ${ink} 40%, rgba(20,42,99,0.92) 70%, rgba(20,42,99,0) 100%)`
          : `linear-gradient(to bottom, ${ink} 40%, rgba(20,42,99,0.92) 70%, rgba(20,42,99,0) 100%)`,
      }}
    >
      <div
        style={{
          fontFamily: serif, fontWeight: 300, fontSize: 96, lineHeight: 1.02,
          letterSpacing: "-0.025em", color: chalk, textShadow: `0 6px 40px ${ink}`,
        }}
      >
        {children}
      </div>
      {sub && (
        <div
          style={{
            fontFamily: label, fontSize: 30, letterSpacing: "0.16em",
            textTransform: "uppercase", color: coral, marginTop: 26,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
};

const Em: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontStyle: "italic" }}>{children}</span>
);

/* -------------------------------------------------------------------- film */

export const Demo: React.FC = () => {
  const frame = useCurrentFrame();

  /*
    Where the camera looks, and when.

    Every change of subject is a move through the same space, never a cut. And
    where a claim needs evidence, the camera stays put and the node opens into
    the real output instead of cutting to a terminal somewhere else.
  */
  const cam = camera(frame, [
    { at: 0, x: 200, y: 220, scale: 1.45 },
    { at: 90, x: 240, y: 250, scale: 1.35 },
    { at: 180, x: 620, y: 300, scale: 1.25 },
    { at: 300, x: 700, y: 400, scale: 1.18 },
    { at: 420, x: 820, y: 430, scale: 1.32 },
    { at: 560, x: 820, y: 430, scale: 1.32 },
    { at: 660, x: 900, y: 250, scale: 0.95 },
    { at: 860, x: 900, y: 250, scale: 0.95 },
    { at: 980, x: 860, y: 430, scale: 1.1 },
    { at: 1180, x: 860, y: 430, scale: 1.1 },
    /*
      Down to Aave — but not so far down that the sheet runs out. The world
      ends just below the pool, so a camera centred on it frames half a screen
      of empty paper; sitting higher keeps the policy gate and the keeper in
      shot above, which is what gives the frame its weight.
    */
    { at: 1300, x: 980, y: 300, scale: 0.85 },
    { at: 1480, x: 1000, y: 310, scale: 0.84 },
    { at: 1700, x: 1020, y: 300, scale: 0.86 },
    /* Back up the return leg to the treasury the money lands in. */
    { at: 1900, x: 620, y: 160, scale: 0.95 },
    { at: 2080, x: 620, y: 160, scale: 0.95 },
    /*
      Down to the agent being paid. Framed left of centre so it clears the panel
      on the right and the caption along the bottom, with Aave stacked directly
      above it — the two counterparties this treasury deals with, in one shot.
    */
    { at: 2240, x: 1350, y: 915, scale: 0.8 },
    { at: 2420, x: 1360, y: 925, scale: 0.79 },
    /* Out, for the tally. */
    { at: 2620, x: 430, y: 300, scale: 0.7 },
    { at: 2800, x: 430, y: 300, scale: 0.68 },
    { at: 3020, x: 430, y: 300, scale: 0.66 },
  ]);

  return (
    <AbsoluteFill style={{ background: ink, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          transform: `scale(${cam.scale}) translate(${-cam.x}px, ${-cam.y}px)`,
          transformOrigin: "0 0",
        }}
      >
        <Schematic />
      </div>

      <Frame />

      <Caption at={14} hold={62}>An agent can earn.</Caption>

      <Caption at={96} hold={72} sub="Bursar keeps the books">
        Someone has to <Em>count it</Em>.
      </Caption>

      <Caption at={210} hold={80} bottom sub="Written down before it is sent">
        Every movement is <Em>an intent</Em> first.
      </Caption>

      {/* The gate refuses, and the model had already read why. */}
      <Caption at={440} hold={110} bottom sub="Asked for 5. The cap is 0.02.">
        The most useful thing it does <Em>is say no</Em>.
      </Caption>

      {/* Claim, then evidence, in the same place. */}
      <Panel
        at={680}
        hold={180}
        side="left"
        title="Paying the contributors · live on Sepolia"
        lines={[
          { text: "$ npm run demo -- --execute" },
          { text: "" },
          { text: "  Distributing 0.0000041 across 2 contributors", kind: "dim" },
          { text: "    model-provider  0.00000246  paid", kind: "ok" },
          { text: "    0x17df748646a1247bcb73efc033256407752e4531…", kind: "ok" },
          { text: "    tool-author     0.00000164  409 Conflict", kind: "warn" },
        ]}
      />

      <Caption at={700} hold={150} sub="60 / 40 by configured share">
        What it allows, <Em>it proves</Em>.
      </Caption>

      {/* The twist. */}
      <Caption at={1000} hold={130}>
        The network said <Em>conflict</Em>.
      </Caption>

      <Panel
        at={1060}
        hold={230}
        side="right"
        title="Reconcile · replayed under the original key"
        lines={[
          { text: "  Reconciled 1 of 1 open movement(s)", kind: "dim" },
          { text: "    confirmed — already executed", kind: "ok" },
          { text: "    0x8f8c37284de3028682e848bd8fa355e9fe7d1a6f…", kind: "ok" },
          { text: "" },
          { text: "  Treasury is unlocked.", kind: "ok" },
        ]}
      />

      <Caption at={1130} hold={160} bottom sub="Guessing failed here pays twice">
        The money had <Em>already moved</Em>.
      </Caption>

      {/* The live protocol, answering for itself. */}
      <Caption at={1300} hold={120}>
        The pool is <Em>a live protocol</Em>.
      </Caption>

      <Panel
        at={1360}
        hold={220}
        side="right"
        title="Aave v3 · read three times, minutes apart"
        lines={[
          { text: "  currentATokenBalance", kind: "dim" },
          { text: "    5.165120505432263390 LINK", kind: "ok" },
          { text: "    5.165395463617371347 LINK", kind: "ok" },
          { text: "    5.165400046253789813 LINK", kind: "ok" },
          { text: "" },
          { text: "  accrued interest  0.1654 LINK", kind: "ok" },
        ]}
      />

      <Caption at={1440} hold={150} bottom sub="Principal plus interest, read from the protocol">
        It climbs <Em>while you watch</Em>.
      </Caption>

      {/* The protocol drives, not us. */}
      <Caption at={1630} hold={120}>
        And Aave <Em>decides</Em>.
      </Caption>

      <Panel
        at={1690}
        hold={230}
        side="left"
        title="Rate keeper · on KeeperHub's schedule, agent absent"
        lines={[
          { text: "  floor 1.00%   rate 234.37%", kind: "dim" },
          { text: "    condition: false — nothing moved", kind: "ok" },
          { text: "" },
          { text: "  floor 300.00% rate 234.37%", kind: "dim" },
          { text: "    withdrew, with no agent involved", kind: "warn" },
          { text: "    0x10f52eadf477d85a439a9a7b3ce75c8aa55cec42…", kind: "ok" },
        ]}
      />

      <Caption at={1780} hold={160} bottom sub="A rate collapse does not wait for the agent">
        The money <Em>comes back</Em>.
      </Caption>

      {/* It earns, too. */}
      <Caption at={1960} hold={120}>
        It also <Em>sends invoices</Em>.
      </Caption>

      <Panel
        at={2010}
        hold={230}
        side="right"
        title="bursar-payout-preflight · listed on KeeperHub"
        lines={[
          { text: "  402 Payment Required", kind: "warn" },
          { text: "    amount   10000        (USDC, $0.01)", kind: "ok" },
          { text: "    network  eip155:8453  (Base)", kind: "ok" },
          { text: "    payTo    0x8d9abc5b…fbdc9", kind: "ok" },
          { text: "" },
          { text: "  the treasury it splits from", kind: "dim" },
        ]}
      />

      <Caption at={2100} hold={150} bottom sub="Priced per call, discoverable by any agent on the Hub">
        The revenue it splits <Em>is revenue it made</Em>.
      </Caption>

      {/* Buying, which is the leg KeeperHub's own issue tracker asked for. */}
      <Caption at={2230} hold={120}>
        And it <Em>pays other agents</Em>.
      </Caption>

      <Panel
        at={2290}
        hold={250}
        side="right"
        title="Lucid agent · one invoice, four answers"
        lines={[
          { text: "  asset has no configured limits", kind: "dim" },
          { text: "    refused", kind: "warn" },
          { text: "  price feed 18 hours stale", kind: "dim" },
          { text: "    refused", kind: "warn" },
          { text: "  everything clears", kind: "dim" },
          { text: "    pay — within policy, 0.01 USDC", kind: "ok" },
        ]}
      />

      <Caption at={2390} hold={170} bottom sub="A price cap can only ask the first">
        Their spec said <Em>a price cap</Em>.
      </Caption>

      <Counters at={2660} />

      <Caption at={2820} hold={140} bottom sub="Payout · Sweep · Yield · Withdraw · Keeper · Reconcile · Earn · Buy">
        Eight legs. Every one <Em>a transaction</Em>.
      </Caption>

      <Closer at={2980} />
    </AbsoluteFill>
  );
};

/** The surface-area argument, as two numbers that move. */
const Counters: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame - at, [0, 18, 96, 114], [0, 1, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  if (o <= 0.001) return null;

  const big: React.CSSProperties = {
    fontFamily: label, fontSize: 128, letterSpacing: "-0.02em", color: chalk,
    lineHeight: 1, fontVariantNumeric: "tabular-nums",
  };

  return (
    <div style={{ position: "absolute", left: 96, bottom: 130, opacity: o }}>
      <div style={{ display: "flex", gap: 130, alignItems: "flex-end" }}>
        <div>
          <div style={big}>
            <Count to={13300} delay={at + 6} dur={44} format={(n) => Math.round(n).toLocaleString()} />
          </div>
          <div style={{ fontFamily: label, fontSize: 27, letterSpacing: "0.16em", textTransform: "uppercase", color: chalkDim, marginTop: 16 }}>
            Tokens to mount KeeperHub
          </div>
        </div>
        <div>
          <div style={{ ...big, color: coral }}>
            <Count to={950} delay={at + 26} dur={38} format={(n) => Math.round(n).toLocaleString()} />
          </div>
          <div style={{ fontFamily: label, fontSize: 27, letterSpacing: "0.16em", textTransform: "uppercase", color: coral, marginTop: 16 }}>
            Tokens to mount Bursar
          </div>
        </div>
      </div>
    </div>
  );
};

const Closer: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 200 }, durationInFrames: 24 });
  if (frame < at) return null;

  return (
    <AbsoluteFill
      style={{
        background: ink, opacity: s,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{ fontFamily: serif, fontStyle: "italic", fontSize: 150, color: chalk, letterSpacing: "-0.03em" }}>
        Bursar
      </div>
      <div style={{ fontFamily: label, fontSize: 30, letterSpacing: "0.24em", textTransform: "uppercase", color: coral, marginTop: 28 }}>
        A treasury for ElizaOS agents
      </div>
      <div style={{ fontFamily: label, fontSize: 26, letterSpacing: "0.12em", color: chalkDim, marginTop: 46 }}>
        github.com/nice-bills/bursar
      </div>
    </AbsoluteFill>
  );
};

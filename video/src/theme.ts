/**
 * The same drafting sheet the landing page is drawn on, so the video and the
 * site are obviously one thing rather than two takes on a theme.
 */
export const ink = "#142a63";
export const chalk = "#e8effb";
export const chalkDim = "#a9bce0";
export const coral = "#ef6a52";
export const line = "rgba(226, 236, 252, 0.30)";
export const lineSoft = "rgba(226, 236, 252, 0.14)";

export const serif = "Newsreader, Georgia, serif";
export const label = "'Barlow Semi Condensed', Helvetica, Arial, sans-serif";
export const mono = "'JetBrains Mono', ui-monospace, monospace";

export const FPS = 30;

/**
 * Terminal lines, taken verbatim from a real run.
 *
 * `kind` drives colour only. Nothing here is written for the video: the hashes
 * resolve on Sepolia, and the 409 in the middle is a failure that actually
 * happened while recording.
 */
export type Line = { text: string; kind?: "cmd" | "dim" | "ok" | "warn" | "head" };

export const bootLines: Line[] = [
  { text: "$ npm run demo -- --execute", kind: "cmd" },
  { text: "" },
  { text: "1. Loading plugin-bursar into the runtime", kind: "head" },
  { text: "   plugin:    bursar", kind: "dim" },
  { text: "   actions:   PAY_CONTRIBUTORS  SWEEP_EARNINGS  DEPLOY_SURPLUS", kind: "dim" },
  { text: "              CHECK_GAS_FLOAT  RECONCILE_TREASURY  REVIEW_PENDING", kind: "dim" },
  { text: "   providers: TREASURY", kind: "dim" },
  { text: "" },
  { text: "2. What the agent knows before it reasons", kind: "head" },
  { text: "   Revenue splits: model-provider 60.0%, tool-author 40.0%.", kind: "dim" },
  { text: "   Spending limits: 0.005 per transfer, 0.02 per rolling 24h.", kind: "dim" },
  { text: "   All movements reconciled; the treasury can transact.", kind: "dim" },
];

export const payLines: Line[] = [
  { text: "4. PAY_CONTRIBUTORS — distributing 0.0000041 onchain", kind: "head" },
  { text: "" },
  { text: "   Distributing 0.0000041 across 2 contributors:", kind: "dim" },
  { text: "     model-provider: 0.00000246 paid", kind: "ok" },
  { text: "       0x17df748646a1247bcb73efc033256407752e4531be5b51db044d41b68ea3dd00", kind: "ok" },
  { text: "     tool-author: 0.00000164 failed", kind: "warn" },
  { text: "       409 Conflict — no answer from the network", kind: "warn" },
  { text: "" },
  { text: "   Run RECONCILE_TREASURY before attempting further payouts.", kind: "warn" },
];

export const reconcileLines: Line[] = [
  { text: "9. RECONCILE_TREASURY", kind: "head" },
  { text: "" },
  { text: "   Reconciled 1 of 1 open movement(s).", kind: "dim" },
  { text: "     confirmed, already executed", kind: "ok" },
  { text: "       0x8f8c37284de3028682e848bd8fa355e9fe7d1a6f6ba5243c97d96ab2f3824503", kind: "ok" },
  { text: "" },
  { text: "   Treasury is unlocked.", kind: "ok" },
];

import React from "react";
import { Composition } from "remotion";
import { loadFont as loadSerif } from "@remotion/google-fonts/Newsreader";
import { loadFont as loadLabel } from "@remotion/google-fonts/BarlowSemiCondensed";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { Demo } from "./Demo";
import { FPS } from "./theme";

// Loaded at module scope so every frame renders with the real faces rather
// than a fallback that reflows halfway through.
loadSerif();
loadLabel();
loadMono();

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={2790}
    fps={FPS}
    width={1920}
    height={1080}
  />
);

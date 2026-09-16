import React from "react";
import { Composition, staticFile, continueRender, delayRender } from "remotion";
import { Demo } from "./Demo";
import { FPS } from "./theme";

/**
 * Fonts, served from this repo rather than fetched at render time.
 *
 * `@remotion/google-fonts` pulls the faces from fonts.gstatic.com while the
 * headless browser is starting, which makes every render depend on a network
 * that may be slow or unavailable — and the failure arrives as a browser setup
 * timeout, which reads like a broken renderer rather than a missing font.
 *
 * The woff2 files are committed under `public/fonts`, so a clone renders the
 * same frames on a train.
 */
const FONT_CSS = staticFile("fonts/fonts.css");

const Fonts: React.FC = () => {
  const [handle] = React.useState(() => delayRender("Loading local fonts"));

  React.useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONT_CSS;
    // Continue either way: a missing stylesheet should render in the fallback
    // face rather than hang the renderer until it times out.
    link.onload = () => document.fonts.ready.then(() => continueRender(handle));
    link.onerror = () => continueRender(handle);
    document.head.appendChild(link);
    return () => link.remove();
  }, [handle]);

  return null;
};

const WithFonts: React.FC = () => (
  <>
    <Fonts />
    <Demo />
  </>
);

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Demo"
    component={WithFonts}
    durationInFrames={3160}
    fps={FPS}
    width={1920}
    height={1080}
  />
);

# The demo video

`bursar-demo.mp4` is the delivered cut — 105s, 1920x1080. It is committed rather
than left as a build artefact so the link in a submission keeps working.

Rendered with [Remotion](https://remotion.dev), from output this repo actually
produced. `captured-run.txt` collects the runs the terminal panels quote —
`npm run demo -- --execute`, `npm run aave` and `npm run listing` — under
hand-written banners, so it reads as one session rather than three. The figures
and hashes in it are verbatim from those runs and resolve on Sepolia; the
banners and the section ordering are editorial.

```bash
npm install
npm run render     # out/bursar-demo.mp4
npm run studio     # scrub the timeline
```

The piece is one continuous coordinate space with a camera moving through it,
rather than a sequence of scenes. `world.tsx` holds the camera and the nodes,
`Demo.tsx` the timeline, `panel.tsx` the terminal panels that open out of a node
when a claim needs its evidence.

Nothing is voiced or scored. It is meant to be watched muted.

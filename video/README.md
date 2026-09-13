# The demo video

Rendered with [Remotion](https://remotion.dev), from output this repo actually
produced. `captured-run.txt` is the `npm run demo -- --execute` session the
terminal panels quote, hashes included; they resolve on Sepolia.

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

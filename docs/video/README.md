# Demo video

`nandout-demo.mp4` (2:14, 1280×720) is attached to the GitHub release `demo-video`.

- **How it was recorded:** headless Chromium on the **live** site (nandout.xyz, `/lock/<token>`, `/hook`, the DeWEB mirror
  at 1-2-230.tapekit.org). `rec.mjs` drives the DevTools screencast at 15 fps and pipes it to ffmpeg.
- **The terminal scenes:** real output captured on 2026-09-28 (`term1.txt`: live `LatchGate.check`; `term2.txt`: fork tests).
- **Narration:** synthetic, generated with Microsoft Edge TTS from the `text` fields in `scenes.json`.
- **Reproduce:** `node rec.mjs <dir>` after replacing `DOCS_VIDEO_DIR` in `scenes.json` with that directory and generating
  `n1.mp3`–`n9.mp3`.

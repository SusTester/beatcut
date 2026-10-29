# BeatCut

Turn the sounds in any video into a drum-beat music video, right in the browser.

1. **Capture sounds.** Record your surroundings with the camera and mic (rear camera by default on phones), or choose a video you already have.
2. **Drum hits.** BeatCut finds percussive hits in the audio and sorts them into seven rows: Kick, Snare, Hi-hat, Clap, Hi Tom, Lo Tom and Rim. They appear on a waveform; tap any marker or chip to hear and see that hit. Untick a hit to leave it out.
3. **Beat.** Use the 16-step grid (seven rows) with tempo, swing and length (1 to 16 bars). There are buttons for Default groove, Randomize and Clear, plus options for Vary hits, Fill on last bar (a hi-to-lo tom roll into a snare/clap pickup), Flash and zoom (a subtle per-hit flash and zoom punch, toned down in v3), and Punch EQ.
4. **Render.** BeatCut plays the beat in real time, draws the matching video slice for each hit onto a canvas, and records it with MediaRecorder. You can then preview it, download it, or share it on phones.

## Privacy

Everything runs on your device. There is **no backend, no uploads, no analytics, no CDN and no third-party code**. A Content-Security-Policy meta tag blocks the page from loading anything other than its own files.

## How detection works

The audio is decoded with Web Audio (`decodeAudioData`). If that fails, BeatCut plays the media once through a `MediaElementSource` and captures it instead. A band-balanced **spectral flux** onset function (2048-point FFT, 10 ms hop, with low, mid and high bands weighted equally) is peak-picked against an **adaptive median threshold** and a loudness gate. Each onset is moved back to the true attack sample. It is then classified from band energies (kick 40–150 Hz, snare 150–2500 Hz, hat 5–12 kHz), its spectral centroid and its spectral flatness, all judged relative to the other hits in the same recording. Extra cues separate the auxiliary sounds:

- **Clap:** several noise bursts in the first ~40 ms (counted on a high-passed envelope), noisy spectrum around 1–3 kHz. Onset refinement walks back over the earlier bursts so the clap starts on its first slap.
- **Tom:** a strong single partial (pitch measured 50 ms after the attack, 90–450 Hz), a tonal (non-noisy) spectrum and a long ring-out (noise-floor-corrected decay ratio). Kicks are told apart by their fast downward pitch sweep and very low settled pitch.
- **Rim/Perc:** very short decay, centroid ~1–4 kHz, low flatness.
- **Hi Tom / Lo Tom:** all tom-like hits in the same video are sorted by pitch and split relative to each other: at the largest pitch gap if it is at least 0.35 octave (and leaves at least 20% on each side), otherwise at the median. So both rows get hits even if all the toms sound alike. If only one tom is found, the other row reuses it pitch-shifted (×1.33 up or ×0.75 down).

Clap, tom and rim rows keep at most 4 hits each to save memory on phones. Any row with no matching hit borrows the closest-scoring hits (marked *).

Within each class, hits are ranked by strength, cleanness (how far the attack rises above the sound just before it) and how clearly the hit belongs to that class.

## Running it

It is a static site: `index.html`, `style.css`, `app.js` and `icon.svg`. There is no build step.

- **Phones need HTTPS** to use the camera. GitHub Pages, Netlify Drop, Cloudflare Pages or any other static HTTPS host works: upload these 4 files.
- **Desktop:** you can open `index.html` directly from disk (`file://`), or serve the folder locally with `python3 -m http.server`. `localhost` counts as secure, so the camera works there. Opening the file directly is fine for choosing a video. Camera support over `file://` depends on the browser.

## Output format

When the browser can record real H.264/AAC MP4 (Safari, and some Chrome builds), the output is MP4. Otherwise it is WebM (VP9 or VP8 with Opus).

## Video frame capture and debugging

Each hit's frames (2 to 4 at 12 fps) are captured once, before playback, and each frame is stored on its own canvas. BeatCut first seeks to each frame time and waits for `seeked` plus a presented frame (`requestVideoFrameCallback` if the browser has it, otherwise a double `requestAnimationFrame`). It then checks that each capture differs from the previous one using a 16×16 thumbnail, and retries or nudges the seek if they match. If captures still come back stale (iOS Safari can repaint an old frame after a seek, especially with sparse keyframes), BeatCut switches automatically to playback capture: it plays the video muted at 1× through each slice and grabs frames as they appear. While capturing, the source video is briefly shown in the preview area so Safari keeps decoding it.

Open the app with **`?debug=1`** (for example `https://…/beatcut/?debug=1`) to see a contact sheet of every hit's captured frames. It shows the requested time, the captured time, how different each thumbnail is from the previous one (red means identical) and which capture mode was used. It also has buttons to recapture automatically or force playback mode. `?capture=play` or `?capture=seek` forces a mode (for testing).

## Tests

`test/` holds a synthetic test video generator (`gen.py`) and Playwright scripts (`run.py`, `run2.py`, `run3.py`, `frames_test.py`) that drive headless Chrome end to end.

## Known limitations

- Rendering happens in real time, so a 10 s beat takes about 10 s. Keep the tab in the foreground while it renders.
- Video slices are pre-extracted at 12 fps (2 to 4 frames per hit, 640 px on the long side), so the motion looks deliberately choppy and stutter-cut.
- WebM files from Chrome's MediaRecorder have no duration in their header. Some players show the length only after playback.
- The whole file is decoded into memory. Very long or 4K videos can be slow or run out of memory on phones; clips under 1 minute work best. Only the first 3 minutes are analyzed.
- Classification is heuristic. Real-world sounds that don't resemble drums are assigned to the closest class. If a class finds nothing, it borrows the hit that best fits it (marked `*`).
- iOS needs Safari 14.5 or later for MediaRecorder and canvas capture.

## Accuracy (synthetic test clips, headless Chromium)

| Clip | Kick | Snare | Hi-hat | Clap | Hi Tom | Lo Tom | Rim | Total | False pos. |
|---|---|---|---|---|---|---|---|---|---|
| test7.mp4 (clean, distinct toms 210–260 / 110–140 Hz) | 10/10 | 6/6 | 5/5 | 5/5 | 9/9 | 10/10 | 10/10 | **55/55** | 0 |
| test7s.mp4 (clean, similar toms 165–190 / 150–175 Hz) | 7/7 | 7/7 | 7/7 | 8/9 | 5/7 | 5/7 | 12/12 | **51/56** (tom family 14/14) | 0 |
| test7n.mp4 (white noise ≈ −30 dBFS, random gains) | 15/15 | 4/5 | 0/8 | 0/6 | 6/6 | 9/9 | 5/7 | **39/56** (42 detected) | 0 |
| test.mp4 (original 3-class clip) | 12/12 | 15/15 | 11/11 | – | – | – | – | **38/38** | 0 |

Cells are correctly classified / true events. In the similar-tom clip the true pitch ranges overlap, so a median split cannot be perfect, but both tom rows still get hits. In heavy noise, quiet hats and claps fall under the loudness gate (raise Sensitivity).
Run: `python3 test/acc7.py test/test7.mp4 test/truth7.json` (clips come from `test/gen7.py`).

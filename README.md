# Darkroom

A browser photo lab for phone photos. Drop in the shots from a meal, a trip or a
product shoot; Darkroom measures each one, corrects what is actually wrong with
it, and exports at the exact size Xiaohongshu, Instagram or your own website
expects.

**Stage 1 (this repository, working today): improve a single photo.**
Stage 2 is the collage builder — combining nine dish photos into one or two
posts. The design for it is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## The one design decision worth knowing

**Photos never leave the device.** There is no server, no account, no upload and
no storage. The browser reads the file you pick, processes it on your GPU with
WebGL, and hands the result back as a download.

That is not only a privacy position — it is what makes the whole thing free to
run, instant, and impossible to get wrong. It is also why the answer to "should
this connect to Google Drive?" is no. That reasoning is set out in full in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#where-should-the-photos-live).

---

## Running it

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # type-checks, then writes the site to dist/
npm run preview  # serve the built site locally
```

The output in `dist/` is plain static files. Any static host will serve it.

## Publishing it

A GitHub Actions workflow is included at
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). To turn it on:

1. Push to `main`.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.

Every push to `main` then rebuilds and publishes the site. Nothing to pay for,
nothing else to sign up to.

If you later want a custom domain and faster global delivery, Cloudflare Pages
or Netlify will both build this repository with zero configuration — the build
command is `npm run build` and the output directory is `dist`. `vite.config.ts`
uses `base: './'` so the same build works on a root domain and on a GitHub Pages
subpath without changes.

---

## What it does to a photo

Auto is not a hidden filter. It measures the file and then writes real numbers
onto the same sliders you can move afterwards, so you can always see what it
decided and undo any single part of it.

| Measured | Used for |
| --- | --- |
| Luminance histogram (0.1% resolution) | Black and white points, contrast, how far to push exposure |
| Median linear luminance | Exposure, in stops |
| Mean linear channel values over the midtones | White balance, as a partial grey-world correction |
| Noise sigma, from a 512 px crop at native resolution | How much noise reduction, and how much sharpening to give up for it |
| Clipped highlight and shadow fractions | Whether to hold exposure back and recover highlights |

Then you have manual control over exposure, contrast, highlights, shadows,
whites, blacks, temperature, tint, vibrance, saturation, clarity, sharpening,
noise reduction, vignette and grain, plus rotate, mirror, straighten, eight crop
ratios, zoom and pan.

Seven presets sit on top of Auto rather than replacing it — Auto fixes what is
objectively wrong with the file, the preset applies the taste. So *Dish* behaves
sensibly whether the shot was taken in daylight or under restaurant tungsten.

### Working on a whole meal

- Load all nine photos at once.
- Get the first one right.
- **Apply to all** copies the sliders to every photo, while each one keeps its
  own measured black and white points — a consistent look without forcing one
  photo's levels onto a differently exposed shot.
- **All N as .zip** renders the set and downloads it as a single archive.

### Export

| Target | Output |
| --- | --- |
| Original framing | Same shape, full resolution |
| Xiaohongshu 3:4 | 1080 × 1440 |
| Instagram feed 4:5 | 1080 × 1350 |
| Square 1:1 | 1080 × 1080 |
| Story / Reels 9:16 | 1080 × 1920 |
| Website hero 16:9 | 1920 × 1080 |
| Web / app asset | Original shape, 2048 px long edge |

JPEG, WebP or PNG, with a quality control. Sources for these dimensions are
listed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#sources).

Because export re-encodes through a canvas, **EXIF metadata is dropped**: GPS
coordinates and camera serial numbers do not travel with a photo you post
publicly. If you need the metadata kept, this tool is the wrong one.

---

## Keyboard and gestures

| | |
| --- | --- |
| `↑` / `↓` | Previous / next photo |
| `Ctrl`/`Cmd` + `V` | Paste an image from the clipboard |
| Double-click a slider | Reset that one control |
| Drag on the image | Reposition the crop, when the crop is tighter than the frame |
| Drag the divider | Move the before/after wipe |

---

## Known limits

These are real and worth knowing before you rely on the tool.

- **WebGL 2 is required.** Every current desktop and mobile browser has it, but
  a machine with hardware acceleration switched off will show an error rather
  than a picture.
- **HEIC.** iPhones save HEIC by default. Safari opens it; Chrome, Edge and
  Firefox mostly do not. Darkroom detects the format and says so instead of
  failing silently. The fix is either to use Safari, or to set iPhone
  *Settings → Camera → Formats* to **Most Compatible** so new photos are JPEG.
- **The preview is not a 100% view.** It is rendered from a copy of the photo
  capped at 2200 px on the long edge. Grain and noise reduction are therefore
  approximations of the final file at very large export sizes. Exports below
  about 2000 px — which is every social target above — match the preview
  closely, because the export decodes at twice the target size for exactly that
  reason.
- **Very large files.** Exports are capped at 8192 px on the long edge and 40
  megapixels, because browsers cap canvas sizes and exceeding them fails
  silently rather than loudly.
- **No undo history yet.** Double-click resets one slider, *Reset framing*
  resets the crop, and the *Original* preset returns the whole photo to
  untouched. A proper undo stack is on the list.

## A note on photos taken from the internet

"No licence requirement" is rarer than it looks. Public-domain and CC0 material
does exist — Wikimedia Commons items marked public domain, works on
[Openverse](https://openverse.org) filtered to CC0 — and sites like Unsplash and
Pexels grant broad free use, but each still has terms, and neither guarantees
that the uploader had the right to grant them. If these images will appear
alongside a business, it is worth keeping a record of where each one came from
and under what terms. Stage 2's data model has a place for that; see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#stage-2-the-collage-builder).

---

## Layout of the code

```
src/
  engine/          no React, no DOM assumptions - takes an ImageBitmap, returns pixels
    types.ts       Adjustments, Geometry, Edit, Analysis
    decode.ts      File -> ImageBitmap: EXIF orientation, HEIC detection, downscaling
    analysis.ts    histogram, percentiles, grey-world means, Immerkaer noise estimate
    auto.ts        turns an Analysis into slider values
    presets.ts     the taste layer that sits on top of Auto
    geometry.ts    crop/rotate/straighten as one output-UV -> source-UV matrix
    shaders.ts     GLSL for the four passes
    renderer.ts    WebGL2 pipeline
    targets.ts     export sizes per platform
    export.ts      full-resolution render and encode
  state/
    photos.ts      loading, memory strategy, re-decoding for export
  components/      the interface
```

`src/engine` is deliberately free of any UI. Stage 2 renders every collage tile
through the same pipeline, so a photo looks identical on its own and inside a
grid.

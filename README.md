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
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**There is one setting you must change, and the site will not work until you
do.** In the repository, go to **Settings → Pages**, and under **Build and
deployment** set **Source** to **GitHub Actions** (not the default, "Deploy from
a branch").

Why it matters: "Deploy from a branch" serves the repository root exactly as it
is committed. The root `index.html` is the Vite *source* entry — it points at
`/src/main.tsx`, which is TypeScript that no browser can execute, at an absolute
path that is wrong for a project subpath. The result is a page that loads and
renders nothing: a white screen with no error. The site has to be built first,
and only the Actions source does that.

Changing the setting does not itself republish, so afterwards either push
again, or go to **Actions → Deploy to GitHub Pages → Run workflow**. From then
on every push to the default branch (or to `main`) rebuilds and republishes.
Nothing to pay for, nothing else to sign up to, and the URL does not change.

While the source is still set to a branch, GitHub runs its own *legacy* Jekyll
builder alongside this workflow. Both deploy, and the legacy one tends to finish
last and win — so the unbuilt page keeps reappearing until the source is
switched. Switching it stops the legacy builder entirely.

If a deployment ever does go out unbuilt, the page now says so rather than
showing a white screen: `index.html` carries a fallback notice that `main.tsx`
removes as its first act, so it is only ever visible when the JavaScript did not
run.

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
noise reduction, vignette and grain.

Seven presets sit on top of Auto rather than replacing it — Auto fixes what is
objectively wrong with the file, the preset applies the taste. So *Dish* behaves
sensibly whether the shot was taken in daylight or under restaurant tungsten.

## Framing: crop, straighten, and fixing the angle

Three tools share the stage, switched with the pill above the image or with the
keyboard.

**Crop** (`C`) draws the whole frame with a rectangle over it. Drag the edges,
the corners, or the middle. Nine shapes are available including **Free**, and
whichever you pick becomes the constraint while you drag. A thirds grid is
always on, and the live pixel size is shown under the box.

**Straighten** is a slider in the Frame panel, ±20°. The box stays square to the
screen and the photo tilts underneath it, so it feels like levelling a horizon
rather than rotating a picture. As in every editor, straightening eats a sliver
of the edges: the crop shrinks automatically rather than showing empty wedges.

**Perspective** (`P`) is the answer to "the photo was taken at an angle — can it
be made straight-on?" Yes. Drag the four corners onto something in the photo
that is *really* a rectangle:

- the rim of a plate seen from across the table
- the edge of a table or a tray
- a menu, a sign, a book cover, a painting on a wall

The engine maps that quadrilateral back to a rectangle, which flattens the whole
photo with it. A magnifier follows the handle you are dragging, because your own
cursor otherwise covers exactly the pixels you are aiming at. Arrow keys nudge a
selected corner; Shift makes them coarser.

While the tool is open the photo is shown **uncorrected** — otherwise the
handles would chase the correction they are creating. Press *Done* to see the
result.

For a gentle lean rather than a genuine off-axis shot, the **Vertical** and
**Horizontal** sliders in the Frame panel are quicker. They and the corner
handles are the same mechanism underneath, so they compose.

One honest limit: flattening a quadrilateral cannot recover the rectangle's true
proportions without knowing the camera's focal length, which a JPEG may not
carry. Darkroom takes the mean of the opposite edge lengths, which is close for
the angles people actually shoot at. If the result looks slightly stretched, set
the crop shape you actually want afterwards.

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
| `A` / `Esc` | Adjust tool |
| `C` | Crop tool |
| `P` | Perspective tool |
| `\` | Toggle the before/after wipe |
| `Ctrl`/`Cmd` + `Z` | Undo |
| `Ctrl`/`Cmd` + `Shift` + `Z` | Redo |
| `↑` / `↓` | Previous / next photo |
| `Ctrl`/`Cmd` + `V` | Paste an image from the clipboard |
| Arrow keys | Nudge a focused perspective corner (`Shift` for bigger steps) |
| Double-click a slider | Reset that one control |
| Drag on the image | Reposition the crop, when the crop is tighter than the frame |
| Drag the divider | Move the before/after wipe |

Undo is per photo and coalesces a slider drag into a single step, so one press
undoes the whole gesture rather than one pixel of travel.

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
    matrix.ts      3x3 maths, including the unit-square-to-quad homography
    geometry.ts    perspective, crop, rotate and straighten as one matrix
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

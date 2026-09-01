# Darkroom

A browser photo lab for phone photos. Drop in the shots from a meal, a trip or a
product shoot; Darkroom measures each one, corrects what is actually wrong with
it, and exports at the exact size Xiaohongshu, Instagram or your own website
expects.

Two modes, switched in the top bar:

- **Enhance** — fix one photo, then export it at the size a platform wants.
- **Collage** — arrange several photos into one composed image, add text, export
  that.

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

## AI review (optional, off by default)

Darkroom can ask Google's Gemini for a second opinion. It is off until you turn
it on, and it never changes anything by itself.

Press **Ask AI** and you get a written diagnosis plus a list of proposed slider
moves, each with the current value beside the suggested one and a one-line
reason. Tick the ones you agree with, ignore the rest, press Apply. It lands as
a single undo step, so one `Ctrl+Z` puts the photo back exactly as it was.

### What it does *not* do

It does not redraw your photo. The model proposes numbers; Darkroom's own GPU
pipeline does the work, at full resolution, from your original pixels.

That was a deliberate choice over handing the photo to an image-generation model
and getting a new picture back. Those models invent detail, mangle text on a
menu or a sign, and cap their output at around 1–2K — below the 1080&nbsp;px
Xiaohongshu actually wants. For photos representing a real meal at a real
restaurant, a picture of food that was never on the plate is a problem, not a
feature. Proposing slider values keeps every pixel yours and every change
reversible.

For the same reason it will *flag* that a photo looks shot off-axis but will not
guess the four corners: a wrong quadrilateral actively distorts the picture,
which is worse than no suggestion. You place them with the Perspective tool,
which is precise.

### What leaves your device

Only when you press Ask AI, and only this:

- a copy of the photo shrunk to 768&nbsp;px on the long edge, as a JPEG
- the numbers Darkroom measured from it (histogram percentiles, noise sigma,
  clipping)

The full-resolution file never leaves. Nothing is sent at any other time, and
with AI switched off nothing is sent at all. Once it reaches Google, Google's
terms govern what happens to it — so if a photo is confidential, leave this off.

### Setting it up

**The recommended way is the proxy**, for two reasons that are both real:

1. **A key in a static site is a public key.** This app has no server. Anything
   it holds, anyone can read out of the browser's network tab — and Google bills
   *you*. Google's own guidance is blunt: *"Never expose keys client-side in
   production... run a backend proxy server to make the actual API calls."*
2. **Browsers cannot reliably call the Gemini API directly.** It needs a CORS
   preflight that Google does not answer, so the request is often simply
   blocked.

[`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js) solves both. It is
about 60 lines, deploys by pasting it into the Cloudflare dashboard, holds the
key as a secret, and only accepts requests from the site you name. Cloudflare's
free plan covers 100,000 requests a day. The file starts with step-by-step
instructions.

**Direct mode** is offered for a quick try on your own machine. The key is kept
in this browser's local storage and never committed — but any script on the page
could read it, so use a key with billing off and restrict it to your site in
Google Cloud. Expect the browser to block the call.

Model ids are editable, because Google retires them on a schedule.

### Cost

Each review sends one small image and gets a few hundred tokens back. On the
free tier this is free but rate-limited to a handful of requests a minute; on a
paid key it is a fraction of a cent per photo. Reviewing nine dishes is nine
requests.

## Collage

Switch to **Collage** in the top bar. Every photo keeps the edit you gave it in
Enhance — exposure, colour, perspective, rotation — so a tile looks exactly the
way that photo looked on its own.

**Arrangements.** Twenty-odd hand-drawn layouts from one frame up to twelve,
sorted so the ones that fit your photo count come first: two-up, one big and
two, three by three, a wide banner over a row of four, and so on. **Auto**
generates an arrangement for any number by splitting the canvas recursively,
always cutting the longer way, which keeps the frames close to square whatever
shape the canvas is.

**Canvas shape** is labelled by where the picture is going rather than by its
ratio — Xiaohongshu, IG / FB post, Square post, Reel / Story, Classic, YouTube /
web — with the ratio underneath for anyone who thinks in ratios. Picking a shape
also sets the export menu: the middle size it offers is exactly what that
platform asks for, with half and double either side.

**Filling frames**, whichever suits you:

- drag a photo from the roll onto a frame
- click a frame, then click a photo
- **Fill in order** does the lot, **Shuffle** rearranges

**Adjusting a tile** — select one and a small toolbar appears on the image
itself, so the side panel is never in the way:

| | |
| --- | --- |
| Tap a frame | Choose it. It takes a ring and its own toolbar. |
| Drag inside the chosen frame | Move the photo within it. It keeps panning however far you drag — it never turns into something else halfway through. |
| − / + on that toolbar, or scroll over it | Zoom the photo in its frame. At 100% a tile can only slide along one axis, because the photo exactly fills the frame in the other; zoom in and it moves freely. |
| Reset on that toolbar | Put that tile back to how it started |
| Double-tap | Enlarge the whole collage on that spot; again to see all of it |
| Press and hold, then drag | Lift the photo out and drop it on another tile to swap the two |

Swapping is a deliberate long press rather than a drag-past-the-edge, because
the edge belongs to panning — and a touchscreen has no hover or right button to
hang a second meaning on.

**Style:** the gap between photos, the border around the whole thing, corner
rounding, and any background colour.

**Text:** add as many layers as you like. Drag them anywhere on the canvas.

- **Nine typefaces**, each button previewed in its own face: Fraunces, Playfair
  Display and DM Serif Display for something editorial; IBM Plex Sans and
  Archivo for something plain; Anton and Bebas Neue for a poster headline;
  Caveat for handwriting; IBM Plex Mono for a caption that looks typed.
- **Three treatments** — Solid, Hollow (outlined, so the photo shows through)
  and Plate (sitting on a colour block, for a price or a label).
- Italic, all capitals, letter spacing, weight, size, alignment, rotation, a
  drop shadow for light text over a busy photo, and twelve colours or your own.

Controls that a typeface cannot honour switch themselves off rather than lying:
Bebas Neue has only capitals, so its all-caps button greys out, and a
single-weight face shows *"Bebas comes in one weight"* instead of a dead slider.

The typefaces are **served from this site, not from Google's CDN**. That is a
deliberate choice: `fonts.googleapis.com` is blocked in mainland China, and a
blocked font stylesheet fails silently — all nine choices would quietly collapse
into the same fallback and look identical. Self-hosting also means the page
makes no third-party request at all. Each face carries its `unicode-range`, so
the browser fetches only what it needs — about 380 KiB for the nine upright
faces, and the italics only if you press the italic button. All nine are under
the SIL Open Font License 1.1; see [`src/fonts/LICENSE.md`](src/fonts/LICENSE.md).

Fonts are waited on before export, so what you download matches what you saw.

Undo covers all of it.

## On a phone

The layout turns into a single column with the picture at the top, the roll
under it within thumb reach, and the controls as a sheet at the bottom. The
sheet starts closed — just its tabs — and slides up *over* the canvas when you
open it rather than squeezing it, so the picture never changes size mid-edit.
Tap a tab or the chevron to open it, the chevron again to close.

**The picture gets the screen.** On a 390 × 844 phone the collage canvas is
378 × 504 — 58% of the display. It used to be 262 × 350, or 28%, with the rest
spent on chrome. What changed:

| Was | Now | |
| --- | --- | --- |
| Top bar 91px | 47px | one row; the app stops announcing its own name on every screen |
| Export block 210px, always there | 0px | it is a tab of the sheet now — a menu you touch once, at the end |
| Roll 118px | 81px | 56px thumbnails, with **Add** riding at the end instead of on a row of its own |
| Frame toolbar lane 58px | 0px | it floats over the picture, and only while a frame is selected |
| Status bar 29px | 0px | the roll already ticks the photos it has placed |

**Gestures**, on the collage:

| | |
| --- | --- |
| **Pinch** | Enlarge or shrink the whole collage. Always — it never means something else depending on what is selected. |
| **Double-tap** | Jump to 2× on the spot; again to go back to the whole thing. Anywhere, including on a photo. |
| **Drag** | Move the picture around. It stops at its own edges, so it cannot be flung out of sight. |
| **Tap a photo, then drag it** | Reframe that photo inside its cell |
| **Press and hold, then drag** | Lift a photo out and drop it on another to swap the two |
| **− / + / Reset on the frame toolbar** | Zoom a photo inside its frame, or put it back |

A chip in the corner shows the zoom and offers **Fit** whenever you are not
looking at the whole collage; at fit it is not there at all. Zooming redraws
the collage at a matching pixel count rather than magnifying what was already
drawn, so a photo inspected at 3× is genuinely sharp.

Double-tap used to mean two things — zoom on the background, put this photo
back on a photo. Testing showed the first one was unreachable: a filled collage
is photos edge to edge, so there is essentially no background left to tap.
Putting a photo back is the **Reset** button on the frame's own toolbar, which
was already there and says what it does.

One finger means one thing at every zoom level: **inside the frame you have
chosen it moves that photo, anywhere else it drags the whole picture.** The
choosing is what keeps it unambiguous, and it is on screen — the chosen frame
takes a ring and its own toolbar. It costs a tap before a photo can be moved,
and it is what stops zooming in from being a trap: at 3× the tiles fill the
screen, so if dragging a tile always moved its photo there would be nothing
left to grab to get back.

Reframing a photo *inside* its cell has no second pinch. An earlier build gave
the pinch to the selected frame when your fingers landed on it; it read well
written down and was unusable in the hand, because a frame is always selected
and the first finger selects whatever it touches — so the same gesture did
different things depending on state you could not see.

Crop handles, perspective corners and the frame toolbar all grow on
touchscreens, and the canvas swallows drags so the page never scrolls under
your finger.

## Light and dark

The appearance button in the top bar cycles **follow the device → light → dark**,
and the choice is remembered.

Dark is the default because a neutral dark surround is the honest way to judge a
photograph. Light mode is a warm paper rather than white, and the area
immediately around the image stays a neutral mid-grey in both — a bright
surround shifts how the eye reads the photo's own tone, which is why desktop
photo applications do the same.

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

The export menu is grouped by where the picture is going, not by ratio, and
each choice explains in one line what it is for:

| Group | Target | Output |
| --- | --- | --- |
| Keep as shot | Original framing | Same shape, full resolution |
| Xiaohongshu / RED | Xiaohongshu post | 3:4 · 1080 × 1440 |
| Instagram | Instagram post | 4:5 · 1080 × 1350 |
| | Instagram square | 1:1 · 1080 × 1080 |
| | Reel or Story cover | 9:16 · 1080 × 1920 |
| Facebook | Facebook post | 4:5 · 1080 × 1350 |
| | Facebook square | 1:1 · 1080 × 1080 |
| | Shared link preview | 1.91:1 · 1200 × 630 |
| TikTok | TikTok cover | 9:16 · 1080 × 1920 |
| Pinterest | Pinterest pin | 2:3 · 1000 × 1500 |
| YouTube | Video thumbnail | 16:9 · 1280 × 720 |
| Your own website | Wide banner | 16:9 · 1920 × 1080 |
| | Page image | Original shape, 2048 px long edge |

Several targets are the same pixel size — an Instagram post and a Facebook post
are both 1080 × 1350. They are listed separately anyway, because knowing you are
exporting *for Facebook* is more useful than remembering that Facebook wants
4:5.

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
| Double-tap a collage tile | Reset that tile's framing |
| Long-press a collage tile | Lift it out to swap with another |
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
    targets.ts     export sizes, grouped and named by platform
    export.ts      full-resolution render and encode
  ai/              optional Gemini review - proposes slider values, never pixels
    types.ts       the proposal shape, and which sliders the model may touch
    gemini.ts      request building, and hard validation of whatever comes back
    settings.ts    local-only configuration
    collage.ts     stage 2: layouts, the auto-split generator, per-tile framing
    collageRender.ts  composites tiles, background, gutters and text onto one canvas
  fonts.css        the nine self-hosted typefaces
  fonts/           their woff2 subsets, and the OFL licence
  state/
    photos.ts      loading, memory strategy, re-decoding for export
    theme.ts       light / dark / follow-the-device, stored locally
  components/      the interface
proxy/
  cloudflare-worker.js   keeps the API key off the page, and works around CORS
```

`src/engine` is deliberately free of any UI. Stage 2 renders every collage tile
through the same pipeline, so a photo looks identical on its own and inside a
grid.

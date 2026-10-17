# Architecture, and the decisions behind it

This document answers three questions:

1. [Where should the photos live?](#where-should-the-photos-live) — including
   whether GitHub connected to Google Drive is a good choice.
2. [How is stage 1 built?](#how-stage-1-is-built)
3. [How should stage 2, the collage builder, be structured?](#stage-2-the-collage-builder)

---

## Where should the photos live?

**Short answer: nowhere. Do not move them at all.**

Stage 1 as built has no server, no database and no storage bucket. The browser
reads the file you pick, processes it on the GPU, and gives it back. That is not
a compromise made to save effort — for this particular job it is genuinely the
better architecture, and it is the reason the tool is instant, free to run, and
has no privacy question to answer.

The rest of this section explains why the two options you asked about are the
wrong fit, and what to reach for *if and when* the requirements change.

### Why not GitHub as the photo store

GitHub is a version-control system built for text. Storing photos in a Git
repository fights the tool in five separate ways:

| | |
| --- | --- |
| **Hard file cap** | Any single file over **100 MiB** is rejected outright; over 50 MiB you get a warning ([GitHub Docs, Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)). |
| **Browser upload cap** | 25 MiB per file through the web interface, so you cannot simply drag photos into the repo page. |
| **Repository size** | GitHub asks you to stay well under 5 GB; a few hundred phone photos plus their edited versions gets there quickly. |
| **History is forever** | Git stores every version of every binary permanently. Re-export a photo five times and the repository carries five full copies, which you cannot reclaim without rewriting history and breaking every clone. |
| **Visibility is all-or-nothing** | A public repository makes every photo public, permanently, including in anyone's fork. A private repository makes them invisible to your own website. |

Git LFS exists for large media and gives 10 GiB of storage and 10 GiB/month of
bandwidth on the Free and Pro plans before you start paying — but LFS is
designed for build artefacts and game assets that change rarely, not for a photo
library you add to weekly. It also adds a setup step that must be repeated on
every machine.

**Use GitHub for the code. It is exactly right for that, and this repository
already depends on it for both source control and free hosting.** Just not for
the pictures.

### Why not Google Drive as the upload/download path

Drive is a perfectly good place for *you* to keep originals. It is a poor
transport layer for an application, because:

- It needs OAuth. That means a Google Cloud project, a consent screen, and — the
  moment more than a handful of people use it — Google's app verification
  process. That is a substantial amount of machinery for a tool whose entire job
  is "make this photo look better and give it back".
- The permission you would be asking for is broad. Users are granting an app
  access to files in their Drive, which is a much bigger ask than "choose a file
  from your computer", and a new place for private photos to be reachable.
- Drive is not an image CDN. Serving images to a website directly from Drive
  links is unreliable, rate-limited, and not what the service is for.
- It adds a hard dependency on a third party being available, for a feature the
  browser already provides for free with `<input type="file">`.

**Where Drive does make sense** is as an *optional import source* later: a "pick
from Drive" button using the Google Picker, so you can pull in a photo you
already have there. That is a small, contained feature, and it never makes Drive
the store of record. It is not needed for stage 1 or stage 2.

### What to use if you later do need storage

You would only need it once one of these becomes true:

- You want a library that survives closing the tab, or that syncs between your
  phone and your laptop.
- You want to save collage layouts as reusable templates.
- You want a permanent public URL per image, to embed in a website or app.

At that point the right shape is the standard one: **object storage for the
files, a small database for the metadata, and short-lived signed upload URLs so
the browser uploads directly to storage without the photos passing through your
own server.**

Two recommendations, both economical, both reliable, both manageable from a
single web dashboard:

**1. Supabase — the better fit if you want one thing to learn.**
Postgres, file storage, and user accounts in one product with one dashboard.
The free plan includes roughly 1 GB of file storage, 500 MB of database and
5 GB of egress. Two caveats to know up front: free projects are **paused after a
week of inactivity** (they restart, but not instantly), and you are limited to
two active projects. The paid tier starts around US$25/month.
See [Supabase pricing](https://supabase.com/pricing).

**2. Cloudflare R2 — the better fit if the images will be served publicly.**
R2 charges **no egress fees at all**, which is the cost that bites when images
are downloaded by visitors. The free tier is 10 GB-month of storage; beyond
that, storage is about US$0.015 per GB-month.
See [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

For a personal photo tool that mostly serves its own owner, Supabase is the
easier starting point. For anything where the images are embedded in a public
website, R2 for the files (optionally with Supabase for the metadata) is the
cheaper long-run answer.

**Do not build any of this until one of the three triggers above is actually
true.** Every one of them adds accounts, a bill, a privacy policy, and a thing
that can break at 11pm.

---

## How stage 1 is built

### Shape

A single static site. No backend, so there is no API surface, no deployment
topology and no state to synchronise.

```
File picked in the browser
        │
        ├─ decode.ts ......... EXIF orientation applied, HEIC detected, downscaled to a 2200 px preview
        ├─ analysis.ts ....... histogram + grey-world means (384 px copy)
        │                      noise sigma (512 px crop at NATIVE resolution)
        ├─ auto.ts ........... Analysis  ->  slider values
        │
        ├─ matrix.ts ......... 3x3 maths, incl. unit-square-to-quad homography
        ├─ geometry.ts ....... perspective + rotate + straighten + crop, as ONE matrix
        ├─ renderer.ts ....... WebGL2, four passes, live preview
        │
        └─ export.ts ......... re-decode the original, render again, encode, download
```

The engine (`src/engine/`) has no React and no DOM assumptions beyond a canvas.
That boundary is what makes stage 2 cheap.

### The render pipeline

Four GPU passes, defined in `src/engine/shaders.ts`:

| Pass | Input | Output | Purpose |
| --- | --- | --- | --- |
| 1 | source | `texClean` (mipmapped) | 5×5 bilateral denoise |
| 2 | `texClean` at mip 2 | quarter-res | Gaussian blur, horizontal |
| 3 | quarter-res | quarter-res | Gaussian blur, vertical |
| 4 | `texClean` + blur + source | canvas | geometry, tone, colour, detail, finish |

Four decisions inside that are worth recording, because they are the difference
between "applies filters" and "improves the photo":

**Exposure and white balance are computed in linear light.** The shader converts
out of sRGB, multiplies, and converts back. Doing it in gamma space — which is
what a naive implementation does — makes brightened photos look washed out and
grey rather than brighter.

**Chroma noise is suppressed far harder than luma noise.** On a phone sensor in
a dim restaurant, the objectionable artefact is coloured blotching; luma grain
still reads as texture. Smoothing both equally is what makes an image look like
plastic. The denoise pass takes the bilateral average, then reapplies most of
the original luminance and almost none of the original chroma.

**Sharpening is measured in output pixels, not source pixels.** The mip level is
chosen to match the export downscale, and the unsharp taps are one *output*
pixel apart. A 12 MP photo sharpened at native resolution and then shrunk to
1080 px loses all of that sharpening and gains aliasing. This way a photo
destined for a 1080 px post gets the amount of bite that size needs.

**Perspective, crop, rotate and straighten are one 3×3 matrix** mapping output
UV to source UV (`src/engine/geometry.ts`). There is no intermediate resample,
the export is pixel-identical to the preview, and — the reason it matters for
stage 2 — an arbitrary output rectangle of an arbitrary aspect costs nothing
extra.

The matrix is *projective*, not merely affine, which is what makes "the photo
was taken at an angle, make it straight-on" a free feature rather than a second
pipeline. The chain, applied right to left, is:

```
source UV  <-  H  <-  un-rotate  <-  flip  <-  straighten  <-  crop  <-  output UV
                |
                perspective: rectified frame -> source
```

Order matters and is fixed. The photo is rectified first and only then rotated,
straightened and cropped — otherwise the crop you drew would move the moment you
touched the perspective.

`H` comes from the closed-form unit-square-to-quadrilateral map (Heckbert 1989,
§2.2): four point correspondences determine a homography uniquely, so no
least-squares solve is needed. The corner handles and the keystone sliders both
produce a quadrilateral and compose by matrix multiplication, which is why they
are one mechanism rather than two parallel ones.

Two consequences the shader has to handle:

- **The mip level and the sharpening radius are computed per pixel**, from the
  analytic derivative of `p.xy / p.z`. Under perspective the minification is not
  uniform — the far edge of a rectified plate is squeezed harder than the near
  edge — so a single LOD uniform would over-blur one end and alias the other.
- **Flattening a quadrilateral cannot recover the rectangle's true aspect**
  without the camera's focal length, which a JPEG may not carry. We take the
  mean of the opposite edge lengths. For the angles people actually shoot at
  that is close, and it is predictable, which matters more than being
  theoretically optimal.

**One orientation for every pass.** Clip space is y-up, and the two kinds of
render target disagree about what that means: in a framebuffer texture NDC
y = −1 is row V = 0, but the browser presents NDC y = +1 at the *top* of the
HTML canvas. Flipping V in the vertex shader therefore corrects the screen while
silently inverting every intermediate texture. All four passes share one
orientation — V = 0 is the first uploaded row, the top of the photo — and only
the composite flips, once, when it turns `vUv` into the output coordinate it
feeds to the transform.

### Colour mix, areas and saved looks: still one pass

Both new kinds of edit were added inside the existing composite pass rather
than as passes of their own, because the property that matters most - the
export is pixel-identical to the preview, and the image is quantised to 8 bits
once - only survives if every adjustment happens in the same place. Measured
after the change: preview and a PNG export of the same edit differ by at most
1/255 per channel, which is the dither.

**The colour mix** runs after vibrance and saturation. A pixel's hue falls
between two of the eight band centres, and the settings of those two bands are
blended by where it sits between them; snapping to the nearest band instead
would put a visible seam through any gradient that crosses a boundary. Hue
turns are followed by restoring the pixel's luma, so moving yellow toward
orange does not quietly darken it, and brightness is applied as a per-colour
exposure in linear light. Near-greys are faded out of the mix by chroma: the
hue of a white plate is sensor noise, and a mix that tinted it by whichever
band the noise landed in would be the most visible flaw in the feature.

**Areas** are positioned on the rectified photo: after perspective correction,
before the quarter turns, mirroring, straightening and crop. That space is
reached from output pixels by an affine map - everything in the framing chain
except perspective, which sits on the far side of it - so the shader needs one
extra matrix, and an area stays on the dish through re-crops, rotation,
mirroring and collage tiles. Sizes are measured in fractions of the photo's
long edge, so a circle stays round on a portrait. The effect is a gain in
linear light at the same point as exposure, and overlapping areas are summed
in log space so two of them compose the way two exposure changes would,
regardless of order. The perspective tool draws the uncorrected photo, which
has no rectified frame, so areas sit that view out. Four is the limit because
beyond that the panel becomes a list nobody can manage on a phone.

All of this was checked with a pixel test against the real engine before any
interface existed: one band changes only its colour, greys are untouched, a
hue turn keeps luma, an area follows a crop, a quarter turn and a mirror, and
four areas apply at once.

**Saved looks** are stored the way the built-in presets are: as offsets from
the photo's Auto result, not as slider positions. Raw positions would carry
one photo's exposure fix onto a photo that never needed it. Measured: a look
saved on a photo Auto had corrected by -1 stop and applied to one Auto
corrected by +1.4 lands at +1.7, which is the look's own +0.3 riding on each
photo's correction. They live in localStorage, and whatever comes back from
there is validated and clamped like any other untrusted input.

### Memory strategy

Nine 12 MP bitmaps held at full resolution would be roughly half a gigabyte and
would fall over on a phone. So only a 2200 px preview is kept per photo. The
original `File` is retained — the browser already holds it, so this is free —
and re-decoded at export time.

At export, when the target is smaller than the original, the file is decoded at
**twice the target long edge** rather than full resolution. Beyond 2× the extra
detail is discarded by the downscale anyway, and it keeps denoise and sharpening
acting at the same relative scale they did in the preview, so the downloaded
file matches what was approved on screen.

---

## The AI review, and why it proposes numbers rather than pixels

The optional Gemini integration is built on one decision: **the model is an eye,
not a pair of hands.** It receives a 768&nbsp;px JPEG plus the measurements
Darkroom already took, and returns target slider values with reasons. The
existing GPU pipeline then does the work at full resolution.

The obvious alternative was to send the photo to an image-generation model and
display whatever came back. It was rejected for four reasons, in order of how
much they matter here:

1. **It invents.** Generation models redraw the frame. On a plate of food that
   means garnish that was never there; on a menu or a shopfront it means text
   that no longer says what it said. For photos representing a real meal at a
   real business, that is a misrepresentation risk, not a feature.
2. **Resolution.** Current image models cap output well below the
   1080&nbsp;px&nbsp;×&nbsp;1440&nbsp;px that Xiaohongshu wants, so the result
   would have to be upscaled — undoing the point of the exercise.
3. **Reviewability.** "Here is a different picture" cannot be approved
   line-by-line. A list of slider moves can, and it undoes in one step.
4. **Privacy.** The slider route needs one small copy of the photo, once, only
   when asked. It keeps the default "nothing leaves this device" property
   intact, with a single clearly-marked exception.

The same reasoning caps what it may suggest. It can move the thirteen tone,
colour and detail sliders, and it can suggest a straighten angle. It may
**flag** that a photo was shot off-axis, but it is explicitly forbidden from
returning perspective corner coordinates: a vision model's guess at four corner
pixels is rough, and a wrong quadrilateral actively distorts the photo, which is
worse than no suggestion at all.

### Treating the response as hostile

Everything that comes back is untrusted input, and is handled that way in
`src/ai/gemini.ts`:

- slider names not on the allowlist are dropped (including `__proto__` and
  `constructor`)
- values must be a real number or a numeric string. `null`, `''`, `[]` and
  `false` are rejected rather than coerced — `Number(null)` is `0`, which would
  otherwise read as a deliberate request for zero
- every value is clamped to that slider's actual range, and the overshoot is
  shown to the user rather than hidden
- duplicate keys collapse, arrays are capped, strings are stripped of control
  characters and truncated

This is also the whole answer to prompt injection. A photo of a sign reading
"ignore your instructions" can, at absolute worst, move a slider to a value it
was already allowed to take. There is no tool call, no file access and no
network reachable from the model's output. Text it returns is rendered by React
as text, never as markup.

### Why a proxy, and not just a key in the page

Two independent problems, one answer:

- **CORS.** A browser cannot reliably call `generativelanguage.googleapis.com`.
  The request is a cross-origin POST with a JSON content type, so it requires a
  preflight, and Google does not support one for this API.
- **Key exposure.** A static site has no secrets. Any key it holds is readable
  from the network tab, and Google bills the key's owner. Google's own guidance
  is to run a backend proxy.

`proxy/cloudflare-worker.js` is that proxy: about 60 lines, no build step, key
held as a Worker secret, origin allowlist, optional shared token, and a strict
`[a-zA-Z0-9._-]` check on the model id so it cannot be used to reach a different
path on Google's API. Direct mode remains available for local experimentation
and says plainly what it costs you.

---

## Stage 2: the collage builder

Built. The goal was to take the nine dish photos from one meal and compose them
into one image instead of posting nine.

### It cost almost no new image processing

Because the engine already renders any `Edit` into any output rectangle of any
aspect, a collage tile is *the same pipeline run again* — same photo, same
colour edit, same perspective correction, only cropped to the shape of its cell
and rendered at that cell's pixel size. `slotEdit()` is the whole adapter: it
takes the largest rectangle of the cell's aspect that fits the photo's framed
size, then narrows it by that tile's own zoom and pan.

Nothing in `matrix.ts`, `geometry.ts`, `shaders.ts` or `renderer.ts` changed.
That was the point of drawing the boundary where it was — and it means a photo
that was perspective-corrected on its own arrives in a tile already corrected.

### Compositing in 2D, not WebGL

Each tile is rendered through WebGL at exactly its final pixel size, then
blitted 1:1 onto a 2D canvas that carries the background, gutters, rounded
corners and text.

Doing the composite in WebGL would have meant scissored viewports, a
y-axis flip to reason about per tile, and rounded corners and text as shader
work. In 2D they are three lines each, and the quality is identical because
every tile is already at its final resolution — `drawImage` at 1:1 resamples
nothing.

Tiles are cached, keyed by a revision number taken from object identity. The app
replaces a `Photo` object whenever its edit changes, so a changed photo misses
the cache and an unchanged one hits it, with no deep comparison and no stale
tiles. Dragging a text layer therefore redraws at full speed without
re-rendering a single photo.

### Layouts

Twenty-odd arrangements are drawn by hand, from one frame to twelve, because a
good grid for nine dishes is a design decision rather than something a generic
algorithm arrives at. `layoutsFor(n)` sorts them so exact fits come first.

For counts the library does not cover, `autoLayout()` splits the canvas
recursively, halving the count each time and cutting whichever way the current
rectangle is longer *in real proportions* — the canvas aspect is folded into
that test, so the same code gives sensible frames on a 3:4 post and on a 16:9
banner.

### Spacing that behaves

Gutter, padding and radius are fractions of the canvas short edge, so a layout
looks the same at 1080 px and at 2048 px. `cellRects()` expands the working area
by half a gutter before inserting each cell by half a gutter, which makes the
outermost edges land exactly on the padding instead of at padding plus half a
gap — the small detail that otherwise makes a collage look subtly misaligned.

### Text

Layers carry position and size as fractions of the canvas, so they scale with
the export rather than drifting. Export awaits `document.fonts.ready` first: an
export that raced the web-font load would silently fall back to a system serif
and not match the screen.

`FONTS` in `collage.ts` is the single description of each typeface — its CSS
stack, its weight range (`null` for a single-weight family), whether it has a
real italic, and whether it is capitals-only. Both the picker and the renderer
read it, which is why the interface can refuse what a face cannot do rather than
faking it: Bebas Neue's all-caps button is disabled because the face has no
lowercase to switch away from, and a single-weight family shows a sentence in
place of a weight slider that would do nothing. `fontShorthand()` builds the
canvas `font` string from the same table, so the panel preview, the on-canvas
render and the export cannot disagree.

Drawing order inside `drawText()` matters: the plate is filled *before* the
shadow is turned on, so the shadow belongs to the letters and not to the block
behind them. Filling the plate with the shadow already set would put a smudge
behind a solid rectangle, which is visible at export resolution and not what
anyone means by a drop shadow.

#### The typefaces are self-hosted, and that is a correctness decision

`src/fonts.css` carries `@font-face` rules pointing at woff2 files in
`src/fonts/`, which Vite fingerprints into the build. Loading them from Google's
CDN instead would be less code and less repository weight, and it would be
wrong: `fonts.googleapis.com` and `fonts.gstatic.com` are blocked by the Great
Firewall, and a blocked font stylesheet does not raise an error — it times out.
The nine typefaces would all resolve to the same fallback, so a picker offering
nine visibly different choices would render nine identical ones, and the page
would stall for the browser's connect timeout first. For a tool whose main
target is Xiaohongshu, that is the wrong failure to ship.

Self-hosting also removes the only third-party request the page made. The cost
is about 1.1 MiB in the repository; the runtime cost is much smaller, because
each `@font-face` keeps the `unicode-range` Google published for it, so a
browser fetches a file only when a glyph actually needs it — roughly 380 KiB for
the nine upright latin faces, with italics and latin-ext arriving only on
demand. All nine are OFL 1.1, which permits exactly this redistribution;
`src/fonts/LICENSE.md` carries the licence and the copyright holders.

### The phone canvas, and what the chrome was costing it

The collage canvas on a 390 x 844 phone was 262 x 350 - 27.9% of the display.
Measuring where the other 72% went is what made the fix obvious, and the number
that stood out was not the one anybody would have guessed: the export block was
210px of permanently parked chrome, taller than the photo roll, holding a size
menu, a format menu, a quality slider and a button that are touched once, at the
very end of the work. It is now a tab of the sheet. The rest came from a top bar
that wrapped to two lines, a 58px lane reserved for a toolbar that only exists
while a frame is selected, a status line repeating what the roll already shows,
and 72px thumbnails with their own button row underneath. The canvas is now
378 x 504 - 57.9%, and 2.08x the area.

The export controls move between a permanent footer and a tab by breakpoint,
which is a change of *arrangement* rather than of styling, so it cannot be done
in CSS: rendering both and hiding one would put two copies of every form control
and every `id` in the document. `useMediaQuery` in `src/state/media.ts` reads the
one breakpoint the app has, exported from the same file so it cannot drift from
the stylesheet.

### Zooming the view

`view` is `{ s, x, y }` applied as a CSS transform on the frame, so a pinch is
instant and never waits on the collage being redrawn. That alone would only
magnify pixels that were already drawn, so `renderScale` follows the view once
the fingers stop moving and multiplies the canvas backing store, which redraws
the collage at a pixel count matching the zoom. A photo inspected at 3x is
genuinely rendered at 3x, up to the same `MAX_CANVAS_EDGE` cap that bounds every
other render.

Pinch means one thing: enlarge or shrink the whole collage. An earlier version
gave the pinch to the selected frame's own photo when the fingers landed inside
it, keeping both zooms on one gesture. It is worth recording why that failed,
because it reads perfectly well as a rule: a frame is *always* selected (entering
collage mode selects the first one), and the first finger down selects whatever
it touches - so by the time the second finger arrives, "the fingers are on the
selected frame" is true almost every time, and the gesture did different things
depending on state the user could not see. Reframing a photo inside its cell is
now the `-`/`+` pair on the frame's own toolbar, which says what it does.

Panning is clamped to the slack - the part of the scaled frame hanging off each
edge - so the picture cannot be flung out of sight, and at fit there is no slack
and it stays centred. Double-tap is counted from pointer timings rather than left
to `dblclick`, because a canvas with `touch-action: none` does not raise one
reliably on a phone.

Double-tap also means only one thing, for a reason the browser test found rather
than the design did: it was written to reset a photo when it landed on one and
zoom the view otherwise, and the zoom half turned out to be unreachable, because
a filled collage is photos edge to edge and has essentially no background left to
land on. Resetting a photo is the Reset button already on the frame's toolbar.

One cost only appears once both features exist together. Moving a photo inside
its frame redraws that tile every frame, and while the view is enlarged the tile
is being drawn at several times the pixel count - so the gesture that was cheap
at fit becomes the most expensive thing in the application at 3x. The drag
therefore drops `renderScale` back to 1 for its duration and restores it on
release: the picture is moving, so nobody is reading its detail, and only the
backing store changes, never the canvas's CSS size, so nothing on screen shifts.

### Where a contextual control can actually live on a phone

The chosen frame's controls floated over the picture, which is the obvious
place for them and the wrong one, for a reason that only a hit test finds. A
bottom sheet covers the bottom of the screen when it opens - that is what it is
for - and the bottom of the screen is exactly where a floating toolbar sits. A
probe that asks `document.elementFromPoint` at the centre of each button, rather
than merely checking that the button is on screen, reported all four covered by
`.panel-body` on every phone size tried. On a shorter phone there was a second
failure underneath the first: the canvas fills the stage there, so the bar was
drawn on the bottom of the photograph, dark buttons over a dark picture.

Anything below the fold of an open sheet is coverable, so the controls have to
be *part of* the sheet. They are now a fixed row above its tab bar, present in
both the open and closed states, and the row keeps its height when no frame is
chosen - otherwise choosing one would resize the canvas underneath, which is the
same jump the closed sheet's reserved space exists to prevent.

The row costs 42px of permanent chrome, which pushes the picture further above
the middle of the screen, so the roll gives back what the row takes: 56px
thumbnails to 48px, still clear of the 44px touch minimum. Finding that also
turned up a stale `@media (max-width: 560px)` rule still setting `.thumb` to
68px and quietly winning over the newer one - the roll had been 79px rather than
the 59px the later rule asked for.

The stage also had to start clipping. Enlarging the frame is a transform, which
does not affect layout, so at 3x the collage simply drew over the photo roll and
the controls beneath it until `.stage-canvas-wrap` was given `overflow: hidden`.

### What is deliberately not there

- **Stickers, frames and filters on top of the collage.** Stage 1 already
  handles the photography; decoration is a different product.
- **Free-floating photos.** Every photo lives in a frame. It keeps the result
  tidy and the interaction unambiguous, which is what the meal-grid case wants.

## Stage 3: video

The aim was the cheapest useful version: photos you have already edited, as a
short vertical video, made on the device. Not a timeline editor - Meta's free
Edits app and CapCut already do that well, and a weaker copy would not be a
reason to use this.

**Encoding: WebCodecs and Mediabunny, not ffmpeg.wasm.** Browsers now expose
the device's own video encoder (WebCodecs: Chrome 94, Safari 16.4, desktop
Firefox 130, per MDN's compatibility data). That leaves only the container to
write, which Mediabunny does in pure TypeScript under MPL-2.0; imported
through one small module so the bundler keeps only the five pieces used, it
is 51 kB gzipped and is downloaded only when video mode opens. The usual
alternative, ffmpeg.wasm, is about 64 MB unpacked, GPL-licensed, and its fast
multi-threaded build needs cross-origin isolation headers that GitHub Pages
cannot send.

**H.264 only.** It is what Instagram, TikTok and Xiaohongshu ask for. A browser
without an H.264 encoder gets a plain explanation before anything is rendered,
rather than a WebM file the platforms may not take.

**No audio.** Safari only gained audio encoding in WebCodecs in version 26, so
a soundtrack would exclude most iPhones in use, and every target platform has
its own music library for adding sound at posting time.

**One drawing function.** The live preview and every encoded frame are painted
by the same `drawReelFrame`, so the preview cannot drift from the file. Photos
are rendered through the normal pipeline from the original file, at the size
the frame needs at full zoom, and only the photos on screen are held in
memory: twenty full-size bitmaps would be several hundred megabytes on a
phone, two is a few dozen. The "whole photo" backdrop is a 24-pixel copy
stretched back up, a blur that works everywhere - canvas `filter` would be
simpler, but Safari still ships it only behind a developer flag.

**Testing an encoder the test browser does not have.** Open-source Chromium,
which this project's local tests use, ships without H.264; it reports so, and
the app shows its "cannot make video" message, which is itself worth having
tested. Everything else was tested locally by forcing VP9 through the same
pipeline and decoding the result with ffmpeg: 1080 x 1350, 135 frames at 30
fps, fast start, each photo prepared and released exactly once, the right
photo at each moment, a half-and-half mix mid-crossfade, the slow zoom
growing a test disc by 10% (5% for whole-photo), and cancel stopping cleanly.
The real H.264 path is tested by a workflow in the Google Chrome on GitHub's
Ubuntu image, which decodes its frames with ffmpeg too. Its first versions
had two holes worth recording. An all-black sample counted as "red", because
the strongest channel of (0, 0, 0) is the first one listed; a colour now only
counts when one channel clearly leads, and frames are decoded by ffmpeg rather
than read back from Chrome's player. And a playback check that waited for
`requestVideoFrameCallback` on a paused video - which headless Chrome never
fires - hung the job until GitHub cancelled it. On that GPU-less runner the
encode itself takes about two and a half minutes in software, with steady
progress, so the test allows eight.

## Monitoring

Healthchecks.io was the requirement, and it is a dead man's switch rather than
an uptime prober: it waits for pings and alerts when one reports failure or
when they stop. Its own documentation lists *"monitoring website uptime by
probing it with HTTP requests"* as something it is not for. So something else
has to visit the site and send the pings. A scheduled GitHub Actions workflow
does that, because it costs nothing on a public repository and needs no new
account or server.

**What gets checked** (`scripts/healthcheck.sh`) is chosen by how this site
actually fails, which is never "the server is down". GitHub Pages essentially
always answers. The failures that have happened, or that the code already
guards against, all answer 200 on the front page: the unbuilt source page
served by "Deploy from a branch", hashed assets missing after a deploy, and a
bundle that loads and throws. So the script checks the page is the build,
fetches every asset it names, and opens it in the headless Chrome that GitHub
preinstalls on its Ubuntu image to confirm that `main.tsx` ran. The fallback
notice in `index.html` is removed as its first act, so its absence is a precise
signal that costs nothing to add.

**The GitHub run stays green when it has reported a failure.** GitHub emails
on every failed run, which during a day-long outage is 24 emails, where
Healthchecks.io sends one for down and one for up. So Healthchecks.io owns the
alerting, and a red run means only that the report itself could not be
delivered. Before the secret is configured there is nobody to report to, so
then a broken site does turn the run red.

**Timing, and why GitHub's scheduler is not enough on its own.** The schedule
is minute 17 of each hour, because GitHub documents that scheduled runs are
delayed, and can be dropped, at the start of the hour. That turned out to be
the least of it: in its first fourteen hours GitHub ran 3 of the 14 hourly
checks it was due, each 15 to 38 minutes late, and the Healthchecks.io check -
set to a 2-hour grace on the assumption of occasional skips - went "down"
with the site perfectly healthy. A monitor that cries wolf gets ignored, which is worse than
none.

The fix keeps everything above and changes only what starts a run. A free
outside timer (cron-job.org, whose source is public) calls GitHub's
`workflow_dispatch` API on the hour with a fine-grained token that has one
permission, **Actions: write**, on one repository - the documented minimum
for that endpoint. GitHub's own schedule stays as a backup. Without the timer
the README recommends a 12-hour grace, so the alerts stay honest about what
the scheduler can actually do; with it, 1 hour.

A broken site sends an explicit `/fail` at the next visit regardless of the
grace time - the grace only governs how long a *missing* ping is tolerated.
Each failure is re-checked once after 60 seconds before it is reported, so a
CDN blip or a deploy landing mid-check does not page anyone.

**The ping URL is a secret** even though the check only ever reports *about* a
public site: whoever holds it can send "all is well" pings, which would hide a
real outage.

## Sources

Export dimensions:

- Xiaohongshu / RED 3:4 covers at 1080 × 1440 —
  [LinkBloom, Xiaohongshu image size guide](https://indiefount.cloud/resources/xiaohongshu-image-size-guide),
  [insMind, Xiaohongshu template size guide](https://www.insmind.com/blog/xiaohongshu-template-size-guide)
- Instagram portrait feed 4:5 at 1080 × 1350, Stories and Reels 9:16 at
  1080 × 1920 —
  [Buffer, Instagram image size guide](https://buffer.com/resources/instagram-image-size/),
  [Hootsuite, social media image sizes](https://blog.hootsuite.com/social-media-image-sizes-guide/)
- Facebook feed 4:5 at 1080 × 1350 and shared-link previews 1.91:1 at
  1200 × 630, TikTok 9:16 at 1080 × 1920, Pinterest pins 2:3 at 1000 × 1500,
  YouTube thumbnails 16:9 at 1280 × 720 —
  [Hootsuite, social media image sizes](https://blog.hootsuite.com/social-media-image-sizes-guide/),
  [Sprout Social, social media image sizes](https://sproutsocial.com/insights/social-media-image-sizes-guide/)

Typefaces:

- Google Fonts is unreachable from mainland China, and the failure is a timeout
  rather than an error —
  [AppInChina, "Does Google Fonts API work in China?"](https://appinchina.co/does-google-fonts-api-work-in-china/),
  [mkdocs issue #1138, "Unable to access fonts.googleapis.com in China"](https://github.com/mkdocs/mkdocs/issues/1138)
- [SIL Open Font License 1.1](https://openfontlicense.org/) — permits bundling
  and redistributing the nine faces with this site

Storage and hosting:

- [GitHub Docs — Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- [GitHub Docs — About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
- [Supabase pricing](https://supabase.com/pricing)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)

AI:

- [Google AI for Developers — Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)
  ("Never expose keys client-side in production... run a backend proxy server")
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Google AI Studio — get an API key](https://aistudio.google.com/apikey)

Monitoring:

- Healthchecks.io's own documentation, read from its source repository:
  [introduction](https://github.com/healthchecks/healthchecks/blob/master/templates/docs/introduction.md)
  (what it is and is not for),
  [Pinging API](https://github.com/healthchecks/healthchecks/blob/master/templates/docs/http_api.md)
  (`/fail`, request bodies, rate limits),
  [Shell scripts](https://github.com/healthchecks/healthchecks/blob/master/templates/docs/bash.md)
  (the `curl -fsS -m 10 --retry 5` pattern),
  [Configuring checks](https://github.com/healthchecks/healthchecks/blob/master/templates/docs/configuring_checks.md)
  (period and grace time)
- [Healthchecks.io pricing](https://healthchecks.io/pricing/): the free
  Hobbyist plan covers 20 checks
- [GitHub Docs — Events that trigger workflows, `schedule`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
  (default branch only, delays and drops at the start of the hour, disabled
  after 60 days without activity in a public repository)
- [GitHub Docs — GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
  (free for public repositories on standard runners)
- [GitHub runner images — Ubuntu 24.04](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
  (Google Chrome preinstalled)
- [GitHub Docs — Create a workflow dispatch event](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
  and the [fine-grained token permission data](https://github.com/github/docs/blob/main/src/github-apps/data/fpt-2022-11-28/fine-grained-pat-permissions.json)
  behind it (Actions, write); [pre-filling a token by URL](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters);
  [GitHub changelog, February 2026](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids)
  (204 unless run details are asked for)
- [cron-job.org source code](https://github.com/pschlan/cron-job.org) (custom
  method, body and headers in the job editor)

Video:

- WebCodecs support - [MDN compatibility data for `VideoEncoder`](https://github.com/mdn/browser-compat-data/blob/main/api/VideoEncoder.json)
  (Chrome 94, Safari 16.4, Firefox 130, not Firefox for Android) and
  [`AudioEncoder`](https://github.com/mdn/browser-compat-data/blob/main/api/AudioEncoder.json)
  (Safari 26)
- [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0); ffmpeg.wasm
  core size and licence from the [npm registry](https://www.npmjs.com/package/@ffmpeg/core)
  (GPL-2.0-or-later, about 64 MB unpacked)
- Cross-origin isolation needs response headers - [web.dev guide](https://web.dev/articles/cross-origin-isolation-guide);
  GitHub Pages cannot set them - [GitHub community discussion #13309](https://github.com/orgs/community/discussions/13309)
- Reels specifications, which agree on 1080 x 1920, 9:16, H.264 MP4, 30 fps
  but vary on bitrate (3.5-12 Mbit/s): [SocialPilot](https://www.socialpilot.co/instagram-marketing/instagram-video-size),
  [ContentStudio](https://contentstudio.io/blog/instagram-reel-size)
- Canvas `filter` in Safari only behind a flag - [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/CanvasRenderingContext2D.json)
- [Meta's Edits app](https://later.com/blog/instagram-edits-app/) - free,
  watermark-free video editing

Image processing:

- J. Immerkær, "Fast Noise Variance Estimation", *Computer Vision and Image
  Understanding* 64(2), 1996 — the noise estimator used in `analysis.ts`.

Figures for third-party pricing and platform dimensions were correct when
checked in August 2026 and are worth re-checking before you rely on them.

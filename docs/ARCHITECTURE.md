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

The goal: take the nine dish photos from one meal and compose them into one or
two images, instead of posting nine.

### Why it is a small addition

Because the engine already renders any `Edit` into any output rectangle of any
aspect, a collage is *the same pipeline run N times into sub-rectangles of one
larger canvas*. Each cell of the grid simply becomes that tile's target aspect,
and the existing crop maths fills it correctly. No new image processing is
needed at all.

### Data model

```ts
/** One photo placed in one cell, with framing on top of that photo's own edit. */
interface CollageSlot {
  photoId: string
  zoom: number
  offsetX: number
  offsetY: number
}

/** Cells are normalised: x, y, w, h in 0..1 of the canvas. */
interface CollageLayout {
  id: string
  name: string
  cells: { x: number; y: number; w: number; h: number }[]
}

interface Collage {
  layoutId: string
  slots: (CollageSlot | null)[]
  canvasAspect: AspectKey      // reuses stage 1's crop ratios, 'free' included
  longEdge: number             // reuses stage 1's export targets
  gutter: number               // gap between cells, % of the canvas short edge
  padding: number              // outer margin
  radius: number               // corner rounding
  background: { kind: 'colour'; value: string } | { kind: 'blur'; photoId: string }
  caption?: { text: string; position: 'top' | 'bottom'; size: number }
}
```

Note what is *not* here: no copy of the photo, no duplicated adjustments. A
collage references photos by id, and each photo keeps the single `Edit` it
already has. Change a photo's exposure and every collage it appears in updates.

### Layouts

A hand-authored library keyed by photo count, because a good arrangement for
nine dishes is a design decision, not something a generic algorithm gets right:

| Photos | Layouts worth having |
| --- | --- |
| 2 | side by side, stacked, 2:1 hero |
| 3 | one large + two small, three-strip, T |
| 4 | 2×2, one hero + three |
| 5 | hero + four, 2 over 3 |
| 6 | 2×3, 3×2, hero + five |
| 9 | 3×3 — the classic Xiaohongshu grid |

Plus one generator for arbitrary counts: recursive binary splitting of the
canvas, choosing each split's direction and position from the aspect ratios of
the photos going into each half. That is how the automatic collages in Google
Photos and Apple Photos work, and it degrades gracefully to 7, 8, 11 photos.

### Rendering

One WebGL context. For each slot, set the viewport to that cell's pixel
rectangle inside the output framebuffer and run the existing composite pass with
that cell's aspect as the target. Then one final pass paints gutters, padding,
rounded corners, background and caption.

Two consequences worth stating: the tiles are rendered at final output
resolution rather than scaled up from thumbnails, and a photo looks *exactly*
the same inside a collage as it does on its own, because it is the same code.

### Interactions

- Drag a photo from the filmstrip into a cell.
- Drag between cells to swap.
- Drag inside a cell to reposition that photo within its frame.
- Shuffle, to re-run the assignment.
- A layout picker showing only layouts that fit the current photo count.

### Files this would add

```
src/engine/collage.ts         layout types, the recursive-split generator
src/engine/layouts.ts         hand-authored presets by count
src/engine/collageRender.ts   N tiles into one canvas, gutters, background
src/components/CollageStage.tsx
src/components/LayoutPicker.tsx
src/App.tsx                   a mode switch: Enhance | Combine
```

Nothing in `src/engine/matrix.ts`, `renderer.ts`, `geometry.ts` or `shaders.ts`
needs to change. That was the point of drawing the boundary where it is — and
it now also means a photo that was perspective-corrected on its own arrives in a
collage tile already corrected, for free.

### Honest estimate

The rendering is the easy part — a day. The layout library and the drag
interactions are the bulk of the work, and the fiddly part is making the drag
behaviour feel right on a touchscreen. Budget the majority of the effort there,
not on the image processing.

---

## Sources

Export dimensions:

- Xiaohongshu / RED 3:4 covers at 1080 × 1440 —
  [LinkBloom, Xiaohongshu image size guide](https://indiefount.cloud/resources/xiaohongshu-image-size-guide),
  [insMind, Xiaohongshu template size guide](https://www.insmind.com/blog/xiaohongshu-template-size-guide)
- Instagram portrait feed 4:5 at 1080 × 1350 —
  [Buffer, Instagram image size guide](https://buffer.com/resources/instagram-image-size/),
  [Hootsuite, social media image sizes](https://blog.hootsuite.com/social-media-image-sizes-guide/)

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

Image processing:

- J. Immerkær, "Fast Noise Variance Estimation", *Computer Vision and Image
  Understanding* 64(2), 1996 — the noise estimator used in `analysis.ts`.

Figures for third-party pricing and platform dimensions were correct when
checked in August 2026 and are worth re-checking before you rely on them.

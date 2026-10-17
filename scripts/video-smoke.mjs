// End-to-end check of the video maker in real Google Chrome.
//
// Open-source Chromium, which most test setups use, ships without an H.264
// encoder, so it cannot test the one thing that matters here: that a real
// browser produces an H.264 MP4 that plays. GitHub's Ubuntu runners have Google
// Chrome installed, which does. This script drives the built site in it, makes
// a short video from three generated photos, and checks the file two ways:
//   - the container, read back with Mediabunny: codec, size, frame count;
//   - the pictures, decoded by ffmpeg at known times, so a video that is the
//     right shape but shows the wrong photos, or nothing at all, still fails;
//   - that Chrome can play its own file back.
//
// Run by .github/workflows/video-smoke.yml after `npm run build`. Needs the
// `playwright` package (installed there with --no-save), Google Chrome and
// ffmpeg. The video is written to video-smoke.mp4 for the workflow to attach.
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'

const PORT = 4173
const OUT_FILE = process.env.SMOKE_OUT || 'video-smoke.mp4'
const URL = `http://127.0.0.1:${PORT}/`
const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  stdio: 'ignore',
})
let browser
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(URL)).ok) break
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }

  browser = await chromium.launch({
    // SMOKE_CHROME points at another browser for a local dry run.
    ...(process.env.SMOKE_CHROME ? { executablePath: process.env.SMOKE_CHROME } : { channel: 'chrome' }),
    // No GPU on the runner: WebGL has to come from SwiftShader.
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  })
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL)
  console.log('browser:', await page.evaluate(() => navigator.userAgent))

  // Three solid photos of different shapes: red, green, blue.
  const files = []
  for (const [name, w, h, colour] of [
    ['red.png', 1200, 900, '#c03030'],
    ['green.png', 900, 1200, '#30a040'],
    ['blue.png', 1000, 1000, '#3050c0'],
  ]) {
    const b64 = await page.evaluate(
      ([w, h, colour]) => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const g = c.getContext('2d')
        g.fillStyle = colour
        g.fillRect(0, 0, w, h)
        return c.toDataURL('image/png').split(',')[1]
      },
      [w, h, colour],
    )
    files.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') })
  }
  await page.setInputFiles('input[type=file]', files)
  await page.waitForSelector('.stage canvas')

  await page.click('.mode-btn:text-is("Video")')
  await page.click('.panel .tab:text-is("Style")')
  await page.click('.aspect-btn:has(.aspect-ratio:text-is("4:5"))')
  await page.click('.seg-btn:text-is("1.5 s")')

  // Either the button becomes usable, or the app explains that this browser
  // cannot encode H.264. Wait for whichever comes first.
  const outcome = await page.waitForFunction(
    () => {
      if (document.querySelector('.reel-warn')) return 'unsupported'
      const b = [...document.querySelectorAll('.panel-foot .btn-primary')].find((x) => /Make video/.test(x.textContent))
      return b && !b.disabled ? 'ready' : null
    },
    null,
    { timeout: 30000 },
  ).then((h) => h.jsonValue(), () => 'timed out')
  check(outcome === 'ready', `Chrome can encode H.264 at 1080 x 1350 (app says: ${outcome})`)
  if (outcome !== 'ready') throw new Error('cannot continue without an encoder')
  const make = page.locator('.panel-foot .btn-primary', { hasText: 'Make video' })

  // GitHub's runners have no GPU and encode H.264 in software, so this is far
  // slower than on a phone: 99 s on the first run here. Allow plenty, and say
  // how far it got, so a slow run and a stuck one look different in the log.
  const started = Date.now()
  await make.click()
  const ticker = setInterval(async () => {
    const pct = await page.locator('.busy-card span').first().textContent().catch(() => null)
    if (pct) console.log(`  ${Math.round((Date.now() - started) / 1000)} s: ${pct.trim()}`)
  }, 30000)
  try {
    await page.waitForSelector('.reel-video', { timeout: 480000 })
  } finally {
    clearInterval(ticker)
  }
  console.log(`encoded in ${((Date.now() - started) / 1000).toFixed(1)} s`)

  // The file, straight from the page.
  const b64 = await page.evaluate(async () => {
    const src = document.querySelector('.reel-video').src
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(bin)
  })
  const bytes = Buffer.from(b64, 'base64')
  console.log(`file: ${(bytes.length / 1024).toFixed(0)} KB`)

  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  const stats = await track.computePacketStats()
  const duration = await input.computeDuration()
  console.log(`container: ${(await input.getMimeType())}, codec ${track.codec}, ${track.displayWidth} x ${track.displayHeight}, ${stats.packetCount} frames, ${duration.toFixed(2)} s`)
  check(track.codec === 'avc', 'video track is H.264')
  check(track.displayWidth === 1080 && track.displayHeight === 1350, 'frame is 1080 x 1350')
  check(stats.packetCount === 135, '135 frames: 3 photos x 1.5 s x 30 fps')
  check(Math.abs(duration - 4.5) < 0.05, 'lasts 4.5 s')
  check(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')), 'index before media (fast start)')

  // Kept for the workflow to attach, so the actual output can be watched.
  writeFileSync(OUT_FILE, bytes)

  // The pictures, decoded by ffmpeg rather than by the browser that made them,
  // so the check does not depend on Chrome's own player. Each sample is the
  // average of the middle of the frame.
  const colourAt = (t) => {
    const raw = execFileSync('ffmpeg', [
      '-v', 'error', '-ss', String(t), '-i', OUT_FILE, '-frames:v', '1',
      '-vf', 'crop=iw*0.3:ih*0.3:iw*0.35:ih*0.35,scale=1:1:flags=area',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ])
    return [raw[0], raw[1], raw[2]]
  }
  // A colour only counts if one channel clearly leads: a black frame must not
  // pass as "red" just because red is listed first.
  const dominant = (p) => {
    const max = Math.max(...p)
    const rest = p.filter((_, i) => i !== p.indexOf(max))
    return max > 90 && rest.every((c) => max - c > 50) ? ['red', 'green', 'blue'][p.indexOf(max)] : `none (${p})`
  }
  const frames = { t03: colourAt(0.3), t125: colourAt(1.25), t22: colourAt(2.2), t42: colourAt(4.2) }
  console.log('frames (ffmpeg):', JSON.stringify(frames))
  check(dominant(frames.t03) === 'red', 'frame at 0.3 s shows the first photo')
  // Halfway through the crossfade, both photos are in it.
  check(frames.t125[0] > 60 && frames.t125[1] > 60, 'frame at 1.25 s is a mix of the first two')
  check(dominant(frames.t22) === 'green', 'frame at 2.2 s shows the second photo')
  check(dominant(frames.t42) === 'blue', 'frame at 4.2 s shows the third photo')

  // And Chrome itself can open and play the file. The pictures were checked
  // above; this only asks whether its own player accepts it. (An earlier
  // version waited for requestVideoFrameCallback on a paused video, which
  // headless Chrome never fires, and hung the job until GitHub cancelled it.)
  const played = await Promise.race([
    page.evaluate(async () => {
      const v = document.createElement('video')
      v.muted = true
      v.src = document.querySelector('.reel-video').src
      await new Promise((res, rej) => {
        v.onloadeddata = res
        v.onerror = () => rej(new Error('Chrome could not play the file'))
      })
      return { size: [v.videoWidth, v.videoHeight], duration: v.duration }
    }),
    sleep(30000).then(() => ({ size: [0, 0], duration: 0, timedOut: true })),
  ])
  console.log('opened in Chrome:', JSON.stringify(played))
  check(played.size[0] === 1080 && played.size[1] === 1350, 'Chrome opens it at 1080 x 1350')
  check(Math.abs(played.duration - 4.5) < 0.05, 'Chrome reports 4.5 s')
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} catch (err) {
  failures.push(err.message)
  console.log('FAIL', err.message)
} finally {
  await browser?.close()
  server.kill()
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
// Explicitly: the preview server's child processes must not keep the job alive.
process.exit(0)

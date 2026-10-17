// End-to-end check of the video maker in real Google Chrome.
//
// Open-source Chromium, which most test setups use, ships without an H.264
// encoder, so it cannot test the one thing that matters here: that a real
// browser produces an H.264 MP4 that plays. GitHub's Ubuntu runners have Google
// Chrome installed, which does. This script drives the built site in it, makes
// a short video from three generated photos, and checks the file two ways:
//   - the container, read back with Mediabunny: codec, size, frame count;
//   - the pictures, by playing the file in Chrome and sampling frames at known
//     times, so a video that is the right shape but shows the wrong photos, or
//     nothing at all, still fails.
//
// Run by .github/workflows/video-smoke.yml after `npm run build`. Needs the
// `playwright` package (installed there with --no-save) and Google Chrome.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'

const PORT = 4173
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

  const started = Date.now()
  await make.click()
  await page.waitForSelector('.reel-video', { timeout: 180000 })
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

  // The pictures, by playing the file in Chrome.
  const samples = await page.evaluate(async () => {
    const v = document.createElement('video')
    v.muted = true
    v.src = document.querySelector('.reel-video').src
    await new Promise((res, rej) => {
      v.onloadeddata = res
      v.onerror = () => rej(new Error('Chrome could not play the file'))
    })
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const g = c.getContext('2d')
    const at = async (t) => {
      v.currentTime = t
      await new Promise((res) => (v.onseeked = res))
      g.drawImage(v, 0, 0)
      const d = g.getImageData(c.width / 2, c.height / 2, 1, 1).data
      return [d[0], d[1], d[2]]
    }
    return { t03: await at(0.3), t22: await at(2.2), t42: await at(4.2) }
  })
  const dominant = (p) => ['red', 'green', 'blue'][p.indexOf(Math.max(...p))]
  console.log('frames:', JSON.stringify(samples))
  check(dominant(samples.t03) === 'red', 'frame at 0.3 s shows the first photo')
  check(dominant(samples.t22) === 'green', 'frame at 2.2 s shows the second photo')
  check(dominant(samples.t42) === 'blue', 'frame at 4.2 s shows the third photo')
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

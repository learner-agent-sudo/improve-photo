/**
 * Darkroom -> Gemini proxy, as a Cloudflare Worker.
 *
 * It exists for two reasons, and the second is the important one:
 *
 *  1. A browser cannot reliably call generativelanguage.googleapis.com
 *     directly. The call is a cross-origin POST with a JSON content type, so it
 *     needs a CORS preflight, and Google does not support one for this API.
 *
 *  2. An API key shipped to a browser is a public key. Anyone who opens the
 *     network tab can read it and spend your quota. Here the key lives as a
 *     Worker secret and never leaves Cloudflare.
 *
 * The Worker is deliberately dumb: it forwards one specific kind of request and
 * nothing else. It does not read, store or log the photo.
 *
 * ---------------------------------------------------------------------------
 * Deploying it (about five minutes, no command line needed)
 *
 *  1. Get a Gemini API key from https://aistudio.google.com/apikey
 *  2. Sign in at https://dash.cloudflare.com -> Workers & Pages -> Create ->
 *     Start with Hello World -> Deploy.
 *  3. Open the Worker -> Edit code. Delete what is there, paste this file, Deploy.
 *  4. Worker -> Settings -> Variables and Secrets:
 *       GEMINI_API_KEY   (type: Secret)  your key
 *       ALLOWED_ORIGIN   (type: Text)    https://YOURNAME.github.io
 *       ACCESS_TOKEN     (type: Secret)  optional, any long random string
 *  5. Copy the Worker's address (https://something.workers.dev) and paste it
 *     into Darkroom under AI settings.
 *
 * The free plan covers 100,000 requests a day, which is far more than a photo
 * editor will ever use.
 * ---------------------------------------------------------------------------
 */

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Model ids are put into a URL path, so allow only characters that belong there. */
const MODEL_RE = /^[a-zA-Z0-9._-]{1,64}$/

/** Generous for a 768px JPEG plus prompt, tight enough to refuse nonsense. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean)
  const origin = request.headers.get('Origin') || ''
  // With no allowlist configured, echo the origin so local development works.
  // Set ALLOWED_ORIGIN in production so a stranger's page cannot use your quota.
  const allow = allowed.length === 0 ? origin || '*' : allowed.includes(origin) ? origin : ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Darkroom-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') {
      return json({ error: { message: 'Send a POST request.' } }, 405, cors)
    }
    if (!cors['Access-Control-Allow-Origin']) {
      return json({ error: { message: 'This origin is not allowed.' } }, 403, cors)
    }
    if (!env.GEMINI_API_KEY) {
      return json(
        { error: { message: 'The Worker has no GEMINI_API_KEY secret set.' } },
        500,
        cors,
      )
    }
    // Optional shared secret. Only enforced when you have set one.
    if (env.ACCESS_TOKEN && request.headers.get('X-Darkroom-Token') !== env.ACCESS_TOKEN) {
      return json({ error: { message: 'Bad or missing access token.' } }, 401, cors)
    }

    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: { message: 'Request too large.' } }, 413, cors)
    }

    let envelope
    try {
      envelope = JSON.parse(raw)
    } catch {
      return json({ error: { message: 'Body was not valid JSON.' } }, 400, cors)
    }

    const model = String(envelope?.model || '')
    if (!MODEL_RE.test(model)) {
      return json({ error: { message: 'Missing or malformed model name.' } }, 400, cors)
    }
    if (!envelope?.body || typeof envelope.body !== 'object') {
      return json({ error: { message: 'Missing request body.' } }, 400, cors)
    }

    let upstream
    try {
      upstream = await fetch(`${GEMINI}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(envelope.body),
      })
    } catch (err) {
      return json({ error: { message: `Could not reach Gemini: ${err.message}` } }, 502, cors)
    }

    // Pass Google's response straight through, including its error bodies, so
    // Darkroom can show the real reason rather than a generic failure.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...cors },
    })
  },
}

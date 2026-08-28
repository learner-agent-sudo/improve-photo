import { useState } from 'react'
import { KNOWN_MODELS, type AiSettings } from '../ai/types'

/**
 * AI configuration.
 *
 * The two transports are not equivalent and the dialog says so. Proxy mode is
 * the one that actually works reliably and keeps the key private; direct mode
 * is offered because for a quick try on your own machine it is one less thing
 * to set up.
 */
export function AiSettingsDialog({
  settings,
  onChange,
  onClose,
}: {
  settings: AiSettings
  onChange: (patch: Partial<AiSettings>) => void
  onClose: () => void
}) {
  const [showKey, setShowKey] = useState(false)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>AI review</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            <span>Let me ask Gemini to review a photo</span>
          </label>

          <p className="modal-note">
            <b>What leaves this device when you press Ask AI:</b> a copy of the photo shrunk to
            768&nbsp;px, as a JPEG, plus the numbers Darkroom measured from it. Nothing is sent
            at any other time, and the full-resolution file never leaves. Google&rsquo;s terms
            govern what happens to it after that.
          </p>

          <div className="group">
            <h3 className="group-title">Connection</h3>
            <div className="seg">
              <button
                className="seg-btn"
                aria-pressed={settings.transport === 'proxy'}
                onClick={() => onChange({ transport: 'proxy' })}
              >
                Via proxy
              </button>
              <button
                className="seg-btn"
                aria-pressed={settings.transport === 'direct'}
                onClick={() => onChange({ transport: 'direct' })}
              >
                Direct
              </button>
            </div>

            {settings.transport === 'proxy' ? (
              <>
                <div className="field">
                  <label htmlFor="ai-proxy">Worker address</label>
                  <input
                    id="ai-proxy"
                    className="text-input"
                    type="url"
                    inputMode="url"
                    placeholder="https://darkroom-ai.yourname.workers.dev"
                    value={settings.proxyUrl}
                    onChange={(e) => onChange({ proxyUrl: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ai-token">Access token (only if you set one)</label>
                  <input
                    id="ai-token"
                    className="text-input"
                    type="password"
                    autoComplete="off"
                    value={settings.accessToken}
                    onChange={(e) => onChange({ accessToken: e.target.value })}
                  />
                </div>
                <p className="modal-note ok">
                  Recommended. Your API key stays on Cloudflare and never reaches this page.
                  Deploy <code>proxy/cloudflare-worker.js</code> from the repository — the file
                  begins with step-by-step instructions, and the free plan covers far more than
                  this will ever use.
                </p>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="ai-key">Gemini API key</label>
                  <div className="input-row">
                    <input
                      id="ai-key"
                      className="text-input"
                      type={showKey ? 'text' : 'password'}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="AIza..."
                      value={settings.apiKey}
                      onChange={(e) => onChange({ apiKey: e.target.value })}
                    />
                    <button className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                <p className="modal-note warn">
                  <b>Two things to know.</b> The key is kept in this browser only, never
                  committed — but any script running on this page could read it, so use a key
                  with billing off and restrict it to this site in Google Cloud. And Google does
                  not officially support calling the API from a web page: the browser may simply
                  block the request, in which case use proxy mode.
                </p>
              </>
            )}
          </div>

          <div className="group">
            <h3 className="group-title">Model</h3>
            <div className="field">
              <input
                className="text-input"
                value={settings.model}
                onChange={(e) => onChange({ model: e.target.value })}
                list="ai-models"
                spellCheck={false}
                aria-label="Gemini model id"
              />
              <datalist id="ai-models">
                {KNOWN_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <p className="modal-note">
              Editable because Google retires model names on a schedule. If a request comes back
              complaining about the model, pick a newer one from the list or paste the id from
              Google AI Studio.
            </p>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}

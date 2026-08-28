import { Dropzone } from './Dropzone'

export function Hero({ onFiles }: { onFiles: (files: File[]) => void }) {
  return (
    <div className="hero">
      <div className="hero-inner">
        <h2>
          Phone photos,
          <br />
          made <em>publishable</em>.
        </h2>
        <p>
          Drop in the shots from tonight&rsquo;s dinner. Darkroom measures each one, corrects
          exposure, colour cast and noise, then exports at exactly the size Xiaohongshu,
          Instagram or your own website is asking for.
        </p>

        <Dropzone onFiles={onFiles} />

        <p style={{ marginTop: 14, fontSize: 12, color: 'var(--paper-4)' }}>
          You can also paste an image straight from the clipboard.
        </p>

        <dl className="hero-facts">
          <div>
            <dt>Private by construction</dt>
            <dd>
              Everything runs on your GPU, in this tab. No account, no upload, no server that
              could keep a copy.
            </dd>
          </div>
          <div>
            <dt>Measured, not guessed</dt>
            <dd>
              Auto reads the histogram and the real noise level, then writes its decision onto
              sliders you can see and override.
            </dd>
          </div>
          <div>
            <dt>Whole meals at once</dt>
            <dd>
              Match one photo, apply it to all nine, download the set as a single zip.
            </dd>
          </div>
          <div>
            <dt>Metadata left behind</dt>
            <dd>
              Exports are re-encoded, so GPS coordinates and camera serial numbers do not
              travel with the picture.
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

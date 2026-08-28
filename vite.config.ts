import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `base: './'` emits relative asset URLs so the same build works on a root
// domain (Cloudflare Pages / Netlify / Vercel) and on a GitHub Pages
// project subpath (…/improve-photo/) without reconfiguring.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', outDir: 'dist' },
})

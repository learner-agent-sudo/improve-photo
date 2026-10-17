/**
 * The only parts of Mediabunny the video maker uses, named here so the bundler
 * can leave the rest of the library out. Loaded with a dynamic import, so none
 * of it is downloaded until someone opens the video mode.
 */
export { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, Quality } from 'mediabunny'

/**
 * Web has no need for the WebView page: the browser is already the renderer,
 * and ImageViewer.web's <img> + CSS transform re-rasterises an SVG at the zoom
 * level (measured at 6x: 1.0 px edge spread, versus 4.0 px for the PNG of the
 * same picture). So the SVG viewer on web IS the image viewer.
 */
export { ImageViewer as SvgViewer } from '@/components/ImageViewer';

import { classColor, classInk } from '../lib/colors'

/**
 * The image with its YOLO boxes drawn on top, each one carrying its class name.
 *
 * The frame keeps the image's own aspect ratio so a box at (xc, yc, w, h) in
 * normalised coordinates lands exactly where the label says it does. Tags are
 * skipped on boxes too small to hold the text — a chip cropped to "barc…" costs
 * space and says nothing.
 */
export default function BoxOverlay({
  src, alt, dim, boxes = [], classes = [], tagMin = [0.2, 0.08], big = false,
}) {
  return (
    <div
      className="relative max-h-full max-w-full"
      style={{ aspectRatio: dim ? `${dim[0]} / ${dim[1]}` : '4 / 3' }}
    >
      <img src={src} alt={alt} loading="lazy" className="block size-full" />
      {boxes.map(([c, x, y, w, h], i) => (
        <div
          key={i}
          className="pointer-events-none absolute rounded-[2px] border-2"
          style={{
            borderColor: classColor(c),
            left: `${(x - w / 2) * 100}%`,
            top: `${(y - h / 2) * 100}%`,
            width: `${w * 100}%`,
            height: `${h * 100}%`,
            // A white relief ring keeps the frame legible on any photo.
            boxShadow: '0 0 0 1px rgba(255,255,255,.65)',
          }}
        >
          {w >= tagMin[0] && h >= tagMin[1] && (
            <span
              className="absolute -left-0.5 -top-0.5 rounded-[2px] px-1 font-semibold whitespace-nowrap"
              style={{
                background: classColor(c),
                color: classInk(c),
                fontSize: big ? 11 : 9.5,
                lineHeight: 1.35,
              }}
            >
              {classes[c] ?? c}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

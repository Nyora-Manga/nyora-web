// screens/reader/viewport-priority.js — how important is this page right now?
//
// The colorizer can only work on a few pages at a time, so the order matters far
// more than the throughput: a page the user is looking at must jump ahead of one
// being warmed two screens away. These are the measurements that decide it, kept
// free of reader state so they can be reasoned about (and tested) on their own.

/**
 * The rectangle the reader actually shows, in client coordinates.
 *
 * Measured against the reader's content root rather than the window, because the
 * top and bottom bars clip it — pixels hidden under the chrome must not make a
 * page look more important than the one the user can really see. Falls back to
 * the visual viewport (which accounts for pinch-zoom) when the root is absent.
 */
export function viewportRect(contentRoot) {
  const vv = window.visualViewport;
  const visual = {
    top: vv ? vv.offsetTop : 0,
    left: vv ? vv.offsetLeft : 0,
    bottom: (vv ? vv.offsetTop + vv.height : window.innerHeight) || 1,
    right: (vv ? vv.offsetLeft + vv.width : window.innerWidth) || 1,
  };
  if (!contentRoot || !contentRoot.isConnected) return visual;
  const rect = contentRoot.getBoundingClientRect();
  return {
    top: Math.max(visual.top, rect.top),
    left: Math.max(visual.left, rect.left),
    bottom: Math.min(visual.bottom, rect.bottom),
    right: Math.min(visual.right, rect.right),
  };
}

/**
 * How much of the viewport a page occupies, and how far away it is otherwise.
 *
 * Measures the enclosing slide when there is one: in paged mode the image has no
 * intrinsic height until its lazy load starts, while its slide is already the
 * exact size the page will be, making it a reliable visibility proxy.
 */
export function pageMetrics(img, contentRoot) {
  const rect = (img.closest('.reader-slide') || img).getBoundingClientRect();
  const viewport = viewportRect(contentRoot);
  const viewportWidth = Math.max(1, viewport.right - viewport.left);
  const viewportHeight = Math.max(1, viewport.bottom - viewport.top);

  const visibleWidth = overlap(rect.left, rect.right, viewport.left, viewport.right);
  const visibleHeight = overlap(rect.top, rect.bottom, viewport.top, viewport.bottom);
  const visible = visibleWidth > 0 && visibleHeight > 0;

  const centerDx = ((rect.left + rect.right) - (viewport.left + viewport.right)) / 2;
  const centerDy = ((rect.top + rect.bottom) - (viewport.top + viewport.bottom)) / 2;

  return {
    visible,
    coverage: visible
      ? (visibleWidth * visibleHeight) / Math.max(1, viewportWidth * viewportHeight)
      : 0,
    distance: Math.hypot(
      gap(rect.left, rect.right, viewport.left, viewport.right),
      gap(rect.top, rect.bottom, viewport.top, viewport.bottom),
    ),
    centerDistance: Math.hypot(centerDx / viewportWidth, centerDy / viewportHeight),
  };
}

/**
 * Turns [pageMetrics] into a queue priority (higher runs first).
 *
 * Two bands that cannot overlap: every visible page outranks every prefetch page.
 * Inside the visible band, prefer the page filling most of the reader and then
 * the one nearest the centre; outside it, nearer pages win.
 */
export function pagePriority(metrics, visibleBand) {
  if (visibleBand && metrics.visible) {
    return 10_000
      + Math.round(metrics.coverage * 1_000)
      - Math.min(500, Math.round(metrics.centerDistance * 100));
  }
  return Math.max(1, 1_000 - Math.round(metrics.distance));
}

/** Length of the shared span of two 1-D ranges; 0 when they miss each other. */
function overlap(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

/** Distance between two 1-D ranges; 0 when they touch or overlap. */
function gap(startA, endA, startB, endB) {
  if (endA < startB) return startB - endA;
  if (startA > endB) return startA - endB;
  return 0;
}

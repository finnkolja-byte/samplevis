// generic media pool item normalization and 2d canvas drawing helpers
(function (global) {
  'use strict';

  function svgToDataUrl(svg) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(svg || '').trim())}`;
  }

  function normalizePoolItem(raw, index = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || `item_${index}_${Math.random().toString(36).slice(2, 6)}`);
    const name = String(raw.name || raw.label || id);
    let src = typeof raw.src === 'string' ? raw.src.trim() : '';
    if (!src && typeof raw.svg === 'string' && raw.svg.trim()) {
      src = svgToDataUrl(raw.svg);
    }
    if (!src) return null;
    const kind = raw.kind === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(src) || src.startsWith('data:video/')
      ? 'video'
      : 'image';
    const isSvg = src.startsWith('data:image/svg+xml') || /\.svg(\?|$)/i.test(src);
    return {
      id,
      name,
      kind,
      src,
      enabled: raw.enabled !== false,
      mimeType: raw.mimeType || (kind === 'video' ? 'video/mp4' : (isSvg ? 'image/svg+xml' : 'image/png'))
    };
  }

  function normalizePoolItems(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const item = normalizePoolItem(list[i], i);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  let tintScratchCanvas = null;
  let tintScratchCtx = null;

  function ensureTintScratch(w, h) {
    if (!tintScratchCanvas) {
      tintScratchCanvas = document.createElement('canvas');
      tintScratchCtx = tintScratchCanvas.getContext('2d');
    }
    const tw = Math.max(1, Math.ceil(w));
    const th = Math.max(1, Math.ceil(h));
    if (tintScratchCanvas.width < tw) tintScratchCanvas.width = tw;
    if (tintScratchCanvas.height < th) tintScratchCanvas.height = th;
    return { canvas: tintScratchCanvas, ctx: tintScratchCtx };
  }

  // draws an image or video frame with optional contain/cover fit, rotation, flip, opacity, and palette tinting
  function drawElement(destCtx, mediaEl, x, y, w, h, opts = {}) {
    if (!destCtx || !mediaEl) return;
    const nw = mediaEl.naturalWidth || mediaEl.videoWidth || mediaEl.width || 0;
    const nh = mediaEl.naturalHeight || mediaEl.videoHeight || mediaEl.height || 0;
    if (nw <= 0 || nh <= 0 || w <= 0 || h <= 0) return;

    const fit = opts.fit === 'cover' ? 'cover' : 'contain';
    const k = fit === 'cover' ? Math.max(w / nw, h / nh) : Math.min(w / nw, h / nh);
    const drawW = nw * k;
    const drawH = nh * k;

    const cx = x + w * 0.5;
    const cy = y + h * 0.5;
    const rot = Number(opts.rotation) || 0;
    const fx = opts.flipX ? -1 : 1;
    const fy = opts.flipY ? -1 : 1;
    const opacity = opts.opacity !== undefined ? Math.max(0, Math.min(1, Number(opts.opacity))) : 1;

    destCtx.save();
    if (fit === 'cover') {
      destCtx.beginPath();
      destCtx.rect(x, y, w, h);
      destCtx.clip();
    }
    if (opacity < 1) destCtx.globalAlpha *= opacity;
    destCtx.translate(cx, cy);
    if (rot !== 0) destCtx.rotate(rot);
    if (fx !== 1 || fy !== 1) destCtx.scale(fx, fy);

    if (opts.tint && typeof opts.tint === 'string') {
      const scratch = ensureTintScratch(drawW, drawH);
      const sctx = scratch.ctx;
      sctx.clearRect(0, 0, drawW, drawH);
      sctx.globalCompositeOperation = 'source-over';
      sctx.drawImage(mediaEl, 0, 0, drawW, drawH);
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = opts.tint;
      sctx.fillRect(0, 0, drawW, drawH);
      sctx.globalCompositeOperation = 'source-over';
      destCtx.drawImage(scratch.canvas, 0, 0, drawW, drawH, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    } else {
      destCtx.drawImage(mediaEl, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    }

    destCtx.restore();
  }

  const api = {
    svgToDataUrl,
    normalizePoolItem,
    normalizePoolItems,
    drawElement
  };

  global.MediaPoolHelper = api;
  global.ElementLibrary = api;
})(window);

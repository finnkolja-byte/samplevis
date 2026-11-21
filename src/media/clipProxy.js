const https = require('https');

const ALLOWED_STREAM_HOSTS = new Set([
  'www.sakugabooru.com',
  'sakugabooru.com',
  'upload.wikimedia.org',
  'commons.wikimedia.org',
  'cdn.coverr.co'
]);

/**
 * Validates that a stream proxy URL targets HTTPS on an allowlisted media host.
 */
function validateStreamUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (
    ALLOWED_STREAM_HOSTS.has(host) ||
    host.endsWith('.sakugabooru.com') ||
    host.endsWith('.wikimedia.org')
  ) {
    return parsed;
  }
  return null;
}

/**
 * Streams an allowlisted remote clip response to a Node/Express HTTP response.
 */
function pipeAllowlistedStream(targetUrl, req, res, redirectsRemaining = 3) {
  const parsed = validateStreamUrl(targetUrl);
  if (!parsed) {
    if (!res.headersSent) res.status(403).json({ error: 'stream host not allowlisted' });
    return;
  }

  const headers = {
    'User-Agent': 'SampleVis/0.1.1 (https://samplevis.local; creative-visualizer) node-https'
  };
  if (parsed.hostname.endsWith('sakugabooru.com')) {
    headers.Referer = 'https://www.sakugabooru.com/';
  }
  const isHead = req.method === 'HEAD';
  const probeCoverrWithGet = isHead && parsed.hostname === 'cdn.coverr.co';
  if (typeof req.headers.range === 'string' && req.headers.range.length < 64) {
    headers.Range = req.headers.range;
  } else if (probeCoverrWithGet) {
    headers.Range = 'bytes=0-0';
  }

  const upstream = https.request(parsed.href, {
    method: isHead && !probeCoverrWithGet ? 'HEAD' : 'GET',
    headers
  }, (upRes) => {
    if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && redirectsRemaining > 0) {
      let nextUrl;
      try {
        nextUrl = new URL(upRes.headers.location, parsed.href).href;
      } catch {
        upRes.resume();
        if (!res.headersSent) res.status(502).json({ error: 'invalid redirect url' });
        return;
      }
      upRes.resume();
      pipeAllowlistedStream(nextUrl, req, res, redirectsRemaining - 1);
      return;
    }

    if (upRes.statusCode < 200 || upRes.statusCode >= 400) {
      upRes.resume();
      if (!res.headersSent) res.status(502).json({ error: `upstream responded ${upRes.statusCode}` });
      return;
    }

    const outHeaders = {
      'Content-Type': upRes.headers['content-type'] || 'video/mp4',
      'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    };
    if (isHead) {
      const rangeHeader = upRes.headers['content-range'] || '';
      const totalMatch = /\/(\d+)$/.exec(rangeHeader);
      if (totalMatch) {
        outHeaders['Content-Length'] = totalMatch[1];
      } else if (upRes.headers['content-length'] && !probeCoverrWithGet) {
        outHeaders['Content-Length'] = upRes.headers['content-length'];
      }
      res.writeHead(200, outHeaders);
      upRes.resume();
      res.end();
      return;
    }
    if (upRes.headers['content-length']) outHeaders['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];

    res.writeHead(upRes.statusCode, outHeaders);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });
  req.on('close', () => {
    upstream.destroy();
  });
  upstream.end();
}

module.exports = {
  ALLOWED_STREAM_HOSTS,
  validateStreamUrl,
  pipeAllowlistedStream
};

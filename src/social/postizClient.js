const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const QUEUE_FILE = path.join(__dirname, '..', '..', 'data', 'exports', 'queue.json');

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveQueue(items) {
  const dir = path.dirname(QUEUE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function getPostizConfig() {
  return {
    baseUrl: (process.env.POSTIZ_API_URL || 'http://postiz:5000/api/public/v1').replace(/\/+$/, ''),
    apiKey: process.env.POSTIZ_API_KEY || ''
  };
}

function jsonRequest(urlStr, method, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === 'https:' ? https : http;
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;

    const req = client.request(
      parsed,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
              }
            : {}),
          ...headers
        },
        timeout: 20000
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsedData = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsedData);
            } else {
              reject(new Error(parsedData.message || `Postiz HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(`Invalid JSON from Postiz (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Postiz request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// multipart upload of rendered mp4 to postiz /upload endpoint
function uploadMediaToPostiz(baseUrl, apiKey, filePath) {
  return new Promise((resolve, reject) => {
    const boundary = `----SampleVisBoundary${Date.now().toString(16)}`;
    const filename = path.basename(filePath);
    const fileBuf = fs.readFileSync(filePath);

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`,
      'utf8'
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([header, fileBuf, footer]);

    const parsed = new URL(`${baseUrl}/upload`);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request(
      parsed,
      {
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        },
        timeout: 60000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(json.message || `Upload HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(`Postiz upload failed (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getPostizStatus() {
  const { baseUrl, apiKey } = getPostizConfig();
  if (!apiKey) {
    return {
      configured: false,
      connected: false,
      baseUrl,
      integrations: [],
      queue: loadQueue()
    };
  }
  try {
    const integrations = await jsonRequest(`${baseUrl}/integrations`, 'GET', {
      Authorization: apiKey
    });
    return {
      configured: true,
      connected: true,
      baseUrl,
      integrations: Array.isArray(integrations) ? integrations : [],
      queue: loadQueue()
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      baseUrl,
      error: err.message,
      integrations: [],
      queue: loadQueue()
    };
  }
}

async function schedulePost({
  mp4Path,
  filename,
  caption,
  platforms = ['instagram', 'youtube', 'tiktok'],
  scheduledAt,
  integrationIds = [],
  sampleMeta = {}
}) {
  const { baseUrl, apiKey } = getPostizConfig();
  const queue = loadQueue();

  const record = {
    id: `post_${Date.now()}`,
    filename,
    caption,
    platforms,
    scheduledAt: scheduledAt || new Date(Date.now() + 3600_000).toISOString(),
    sampleMeta,
    status: 'queued_locally',
    createdAt: new Date().toISOString()
  };

  if (apiKey && mp4Path && fs.existsSync(mp4Path)) {
    try {
      const uploaded = await uploadMediaToPostiz(baseUrl, apiKey, mp4Path);
      const postPayload = {
        type: scheduledAt ? 'schedule' : 'now',
        date: record.scheduledAt,
        posts: (integrationIds.length ? integrationIds : platforms).map((targetId) => ({
          integration: { id: targetId },
          value: [
            {
              content: caption,
              image: uploaded?.id ? [{ id: uploaded.id, path: uploaded.path }] : []
            }
          ]
        }))
      };
      const remoteRes = await jsonRequest(`${baseUrl}/posts`, 'POST', { Authorization: apiKey }, postPayload);
      record.status = 'scheduled_in_postiz';
      record.remoteResponse = remoteRes;
    } catch (err) {
      record.status = 'queued_locally_postiz_offline';
      record.postizNote = err.message;
    }
  }

  queue.unshift(record);
  saveQueue(queue);
  return record;
}

module.exports = {
  getPostizStatus,
  schedulePost,
  loadQueue
};


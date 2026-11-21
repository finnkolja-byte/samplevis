const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');

const APP_TITLE = 'SampleVis 0.1.1 (Beta)';
const APP_SCHEME = 'app';
const APP_HOST = 'samplevis';
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PRESETS_MEADOWS_DIR = path.join(ROOT_DIR, 'data', 'presets', 'meadows');
const PRESETS_DEMOS_DIR = path.join(ROOT_DIR, 'data', 'presets', 'demos');

// set app name before resolving userData so runtime cache lives under SampleVis/
app.setName('SampleVis');
process.env.SAMPLEVIS_DATA_DIR = path.join(app.getPath('userData'), 'data');

const {
  loadCatalog,
  fetchAnimeClips,
  fetchRealLifeClips,
  CLIPS_DIR
} = require('../src/media/animeFetcher');
const { validateStreamUrl } = require('../src/media/clipProxy');
const { createStarterService } = require('../src/starter/starterService');
const { createDiskPresetStore } = require('./presetStore');

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.als': 'application/octet-stream',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.wasm': 'application/wasm'
};

const SUPPORTED_OPEN_EXTS = new Set([
  '.wav', '.mp3', '.flac', '.ogg', '.m4a',
  '.mid', '.midi', '.als',
  '.json', '.zip'
]);
const MAX_OPEN_FILE_BYTES = 250 * 1024 * 1024;

let mainWindow = null;
let presetStore = null;
let starterService = null;
const pendingFilePaths = [];

function isSupportedOpenFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const lower = filePath.toLowerCase();
  const ext = path.extname(lower);
  if (!SUPPORTED_OPEN_EXTS.has(ext)) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_OPEN_FILE_BYTES;
  } catch {
    return false;
  }
}

function collectArgvFiles(argv) {
  if (!Array.isArray(argv)) return [];
  const found = [];
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue;
    const resolved = path.resolve(arg);
    if (isSupportedOpenFile(resolved)) {
      found.push(resolved);
    }
  }
  return found;
}

function readOpenFilePayload(filePath) {
  const bytes = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  return {
    name,
    mimeType,
    ext,
    bytes: new Uint8Array(bytes)
  };
}

const STUDIO_ONLY_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.mid', '.midi', '.als']);

function queueOrDispatchOpenFiles(filePaths) {
  let needsStudioNavigation = false;
  const currentUrl = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
  const isOnGallery = !currentUrl || currentUrl.endsWith('/gallery.html') || (currentUrl.endsWith('/') && !currentUrl.includes('?preset='));

  for (const fp of filePaths) {
    if (!isSupportedOpenFile(fp)) continue;
    const ext = path.extname(fp).toLowerCase();
    if (isOnGallery && STUDIO_ONLY_EXTS.has(ext)) {
      if (!pendingFilePaths.includes(fp)) pendingFilePaths.push(fp);
      needsStudioNavigation = true;
      continue;
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      try {
        mainWindow.webContents.send('samplevis:open-file', readOpenFilePayload(fp));
        continue;
      } catch { }
    }
    if (!pendingFilePaths.includes(fp)) {
      pendingFilePaths.push(fp);
    }
  }

  if (needsStudioNavigation && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/?preset=constellations`);
  }
}

function safeResolveUnder(baseDir, relPath) {
  const cleanRel = String(relPath || '').replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, cleanRel);
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
  if (resolved !== baseDir && !resolved.startsWith(baseWithSep)) {
    return null;
  }
  return resolved;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function serveFileResponse(filePath, request) {
  if (!filePath || !fs.existsSync(filePath)) {
    return new Response('Not found', { status: 404 });
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return new Response('Not found', { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });

  if (ext === '.html') {
    headers.set(
      'Content-Security-Policy',
      // 'unsafe-inline' is for the sandboxed renderer: its srcdoc document inherits this policy, and
      // its inline runtime would be blocked without it. The frame itself is opaque-origin.
      "default-src 'self' app:; script-src 'self' app: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' app: 'unsafe-inline'; font-src 'self' app: data:; img-src 'self' app: data: blob:; media-src 'self' app: data: blob:; connect-src 'self' app: blob: https:; worker-src 'self' app: blob:;"
    );
  }

  const rangeHeader = request.headers.get('range');
  if (rangeHeader && stat.size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (match) {
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (!match[1] && match[2]) {
        const suffixLen = parseInt(match[2], 10);
        start = Math.max(0, stat.size - suffixLen);
        end = stat.size - 1;
      }
      if (start >= stat.size || start > end || end >= stat.size) {
        headers.set('Content-Range', `bytes */${stat.size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      headers.set('Content-Length', String(end - start + 1));
      const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
      return new Response(stream, { status: 206, headers });
    }
  }

  headers.set('Content-Length', String(stat.size));
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  const stream = Readable.toWeb(fs.createReadStream(filePath));
  return new Response(stream, { status: 200, headers });
}

async function handleAllowlistedStream(targetUrl, request, redirectsRemaining = 3) {
  const parsed = validateStreamUrl(targetUrl);
  if (!parsed) {
    return jsonResponse({ error: 'stream host not allowlisted' }, 403);
  }

  const reqHeaders = new Headers({
    'User-Agent': 'SampleVis/0.1.1 (https://samplevis.local; creative-visualizer) electron-net'
  });
  if (parsed.hostname.endsWith('sakugabooru.com')) {
    reqHeaders.set('Referer', 'https://www.sakugabooru.com/');
  }
  const range = request.headers.get('range');
  if (range && range.length < 64) {
    reqHeaders.set('Range', range);
  }

  const upstream = await net.fetch(parsed.href, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: reqHeaders,
    redirect: 'manual'
  });

  if (upstream.status >= 300 && upstream.status < 400 && redirectsRemaining > 0) {
    const location = upstream.headers.get('location');
    if (location) {
      let nextUrl;
      try {
        nextUrl = new URL(location, parsed.href).href;
      } catch {
        return jsonResponse({ error: 'invalid redirect url' }, 502);
      }
      return handleAllowlistedStream(nextUrl, request, redirectsRemaining - 1);
    }
  }

  if (upstream.status < 200 || upstream.status >= 400) {
    return jsonResponse({ error: `upstream responded ${upstream.status}` }, 502);
  }

  const outHeaders = new Headers({
    'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
    'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  });
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  if (contentLength) outHeaders.set('Content-Length', contentLength);
  if (contentRange) outHeaders.set('Content-Range', contentRange);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders
  });
}

async function handleAppProtocol(request) {
  try {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/' || pathname === '') {
      const targetHtml = url.searchParams.has('preset') ? 'index.html' : 'gallery.html';
      return serveFileResponse(path.join(PUBLIC_DIR, targetHtml), request);
    }

    if (pathname === '/api/starter') {
      const { status, body } = starterService.getStarterPayload(url.searchParams.get('preset'));
      return jsonResponse(body, status);
    }

    if (pathname === '/api/clips') {
      return jsonResponse({ clips: loadCatalog() });
    }

    if (pathname === '/api/clips/fetch' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { category = 'all', customQuery = '', count = 4, mode = 'best', source = 'anime', excludeIds = [] } = body || {};
      const cleanSource = source === 'real_life' ? 'real_life' : 'anime';
      const params = {
        category: String(category),
        customQuery: String(customQuery).slice(0, 80),
        count: Math.min(16, Math.max(1, parseInt(count, 10) || 4)),
        mode: mode === 'random' ? 'random' : 'best',
        streamOnly: true,
        excludeIds: Array.isArray(excludeIds) ? excludeIds.slice(0, 200).map(String) : []
      };
      const result = cleanSource === 'real_life'
        ? await fetchRealLifeClips(params)
        : await fetchAnimeClips(params);
      return jsonResponse(result);
    }

    if (pathname === '/api/clips/stream') {
      return await handleAllowlistedStream(url.searchParams.get('url'), request, 3);
    }

    if (pathname.startsWith('/presets/meadows/')) {
      const filePath = safeResolveUnder(PRESETS_MEADOWS_DIR, pathname.slice('/presets/meadows/'.length));
      return serveFileResponse(filePath, request);
    }

    if (pathname.startsWith('/presets/demos/')) {
      const filePath = safeResolveUnder(PRESETS_DEMOS_DIR, pathname.slice('/presets/demos/'.length));
      return serveFileResponse(filePath, request);
    }

    if (pathname.startsWith('/anime-clips/')) {
      const rel = pathname.slice('/anime-clips/'.length);
      let filePath = safeResolveUnder(CLIPS_DIR, rel);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        filePath = safeResolveUnder(path.join(ROOT_DIR, 'data', 'anime-clips'), rel);
      }
      return serveFileResponse(filePath, request);
    }

    const staticPath = safeResolveUnder(PUBLIC_DIR, pathname);
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      return serveFileResponse(staticPath, request);
    }

    return new Response('Not found', { status: 404 });
  } catch (err) {
    console.error('[ElectronProtocol] Request failed:', err);
    return jsonResponse({ error: err.message || 'Internal error' }, 500);
  }
}

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'SampleVis',
      submenu: [
        { role: 'about', label: `About ${APP_TITLE}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Preset Gallery',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/gallery.html`);
            }
          }
        },
        {
          label: 'Open Presets Folder',
          click: () => {
            if (presetStore) shell.openPath(presetStore.getPresetsDir());
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.navigationHistory.canGoBack()) {
              mainWindow.webContents.navigationHistory.goBack();
            }
          }
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.navigationHistory.canGoForward()) {
              mainWindow.webContents.navigationHistory.goForward();
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${APP_TITLE}`,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: APP_TITLE,
              message: APP_TITLE,
              detail: `Standalone audio & MIDI reel studio.\n\nPresets folder:\n${presetStore ? presetStore.getPresetsDir() : ''}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers() {
  ipcMain.handle('samplevis:presets:list', async () => {
    return await presetStore.listPresets();
  });

  ipcMain.handle('samplevis:presets:get', async (_event, id) => {
    return await presetStore.getPreset(id);
  });

  ipcMain.handle('samplevis:presets:save', async (_event, preset) => {
    return await presetStore.savePreset(preset);
  });

  ipcMain.handle('samplevis:presets:delete', async (_event, id) => {
    return await presetStore.deletePreset(id);
  });

  ipcMain.handle('samplevis:presets:dir', () => {
    return presetStore.getPresetsDir();
  });

  ipcMain.handle('samplevis:presets:open-folder', async () => {
    return await shell.openPath(presetStore.getPresetsDir());
  });

  ipcMain.handle('samplevis:files:consume-pending', (_event, extensions) => {
    if (!pendingFilePaths.length) return [];
    const extFilter = Array.isArray(extensions) && extensions.length > 0
      ? new Set(extensions.map((e) => String(e).toLowerCase()))
      : null;

    const consumed = [];
    const remaining = [];
    for (const fp of pendingFilePaths) {
      const ext = path.extname(fp).toLowerCase();
      if (!extFilter || extFilter.has(ext)) {
        try {
          consumed.push(readOpenFilePayload(fp));
        } catch (err) {
          console.warn('[Electron] Failed to read opened file:', err.message);
        }
      } else {
        remaining.push(fp);
      }
    }
    pendingFilePaths.length = 0;
    pendingFilePaths.push(...remaining);
    return consumed;
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 390,
    minHeight: 540,
    title: APP_TITLE,
    backgroundColor: '#f2f7f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on('app-command', (_event, cmd) => {
    if (cmd === 'browser-backward' && mainWindow.webContents.navigationHistory.canGoBack()) {
      mainWindow.webContents.navigationHistory.goBack();
    } else if (cmd === 'browser-forward' && mainWindow.webContents.navigationHistory.canGoForward()) {
      mainWindow.webContents.navigationHistory.goForward();
    }
  });

  mainWindow.on('page-title-updated', (event, pageTitle) => {
    // keep desktop window bar clearly branded as SampleVis 0.1.1 (Beta)
    if (!/0\.1\.1/.test(pageTitle)) {
      event.preventDefault();
      mainWindow.setTitle(APP_TITLE);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        shell.openExternal(parsed.href);
      }
    } catch { }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol === `${APP_SCHEME}:` && parsed.hostname === APP_HOST) {
        return;
      }
    } catch { }
    event.preventDefault();
  });

  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Leave', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: APP_TITLE,
      message: 'You have unsaved changes.',
      detail: 'Leave without saving?'
    });
    if (choice === 0) {
      event.preventDefault();
    }
  });

  const hasPendingStudioFile = pendingFilePaths.some((fp) =>
    STUDIO_ONLY_EXTS.has(path.extname(fp).toLowerCase())
  );
  const startUrl = hasPendingStudioFile
    ? `${APP_SCHEME}://${APP_HOST}/?preset=constellations`
    : `${APP_SCHEME}://${APP_HOST}/`;
  mainWindow.loadURL(startUrl);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingFilePaths.push(...collectArgvFiles(process.argv.slice(1)));

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    queueOrDispatchOpenFiles(collectArgvFiles(argv.slice(1)));
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOrDispatchOpenFiles([filePath]);
  });

  app.whenReady().then(() => {
    presetStore = createDiskPresetStore(app);
    starterService = createStarterService({
      presetsDir: PRESETS_MEADOWS_DIR,
      demosDir: PRESETS_DEMOS_DIR
    });

    protocol.handle(APP_SCHEME, handleAppProtocol);
    registerIpcHandlers();
    buildApplicationMenu();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

const { app, BrowserWindow, ipcMain, screen, net, globalShortcut, powerMonitor } = require('electron');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');

// Keep the transparent always-on-top widget rendering and receiving input. On
// Windows, Chromium's native occlusion tracking eventually marks it "occluded"
// (covered or idle) and throttles its input + paint pipeline — which is why
// clicks/expand/drag stop working after a while. Must run before app ready.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// On Windows, transparent frameless windows render their transparent regions
// (rounded-corner exterior, edges) WHITE when the window is unfocused — a DWM/GPU
// compositing bug. Disabling GPU compositing makes those regions stay transparent.
app.disableHardwareAcceleration();

const CREDS       = path.join(os.homedir(), '.claude', '.credentials.json');
const SETTINGS    = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const PREFS       = path.join(os.homedir(), '.claude', 'widget-prefs.json');
const LOG_FILE    = path.join(os.homedir(), '.claude', 'widget-error.log');

// Fallback versions if usage history has no resolved id for a family yet.
// Update when a new model generation ships.
const FALLBACK_VERSION = { opus: '4.8', sonnet: '4.6', haiku: '4.5' };
// Claude Code's "default" model resolves to this family — so the widget shows the
// real model (e.g. "Sonnet 4.6") instead of just "Default". Update if the default changes.
const DEFAULT_FAMILY = 'sonnet';
const API_BASE   = 'https://api.anthropic.com';
const COMPACT_H  = 52;
const EXPANDED_H = 450;
const WIDGET_W   = 290;

let win = null;

// Desired always-on-top state. Windows can silently drop the always-on-top flag
// (after sleep/wake, fullscreen apps, display changes), which sends the widget
// behind other windows and makes it look unclickable. We re-assert it on a timer.
let desiredOnTop = true;

// winX / winY always track the compact bar's top-left corner on screen.
// In compact mode the window IS that 290×52 rect.
// In expanded mode the window extends upward: top-left = (winX, winY - (EXPANDED_H - COMPACT_H)).
let winX = 0;
let winY = 0;

// ── Logging ───────────────────────────────────────────────────────────────────

function logError(ctx, msg) {
  const line = `[${new Date().toISOString()}] ${ctx}: ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch {}
  console.error(line.trim());
}

// ── Preferences ───────────────────────────────────────────────────────────────

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')); } catch { return {}; }
}
function savePrefs(data) {
  try { fs.writeFileSync(PREFS, JSON.stringify(data), 'utf8'); } catch {}
}

// ── Credentials ───────────────────────────────────────────────────────────────

function readCredentials() {
  try {
    const raw   = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const oauth = raw.claudeAiOauth || {};
    return { token: oauth.accessToken || null, sub: oauth.subscriptionType || '' };
  } catch {
    return { token: null, sub: '' };
  }
}

// Highest resolved version (e.g. "4.8") seen for a model family across Claude Code's
// per-project usage history, so an alias like "opus" can be shown with its real
// version. Returns null if the family never appears in the history.
function resolveModelVersion(family) {
  try {
    const projects = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')).projects || {};
    const re = new RegExp(`claude-${family}-(\\d+)-(\\d+)`);
    let best = null;
    for (const proj of Object.values(projects)) {
      for (const id of Object.keys(proj?.lastModelUsage || {})) {
        const m = id.match(re);
        if (!m) continue;
        const v = [parseInt(m[1], 10), parseInt(m[2], 10)];
        if (!best || v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) best = v;
      }
    }
    return best ? `${best[0]}.${best[1]}` : null;
  } catch {
    return null;
  }
}

// Friendly label for the model configured in Claude Code (set via /model).
// Resolves aliases ("opus") to a versioned label ("Opus 4.8"); full ids carry
// their own version; "1m" context and the opusplan variant are annotated. When the
// setting is the default (unset or "default"), resolves to the real default model
// (e.g. "Sonnet 4.6 · Auto") instead of just showing "Default".
function readModelLabel() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).model || null; }
  catch { raw = null; }

  const key       = (raw || 'default').toLowerCase();
  const isDefault = !raw || key === 'default';

  let fam = key.includes('opus')   ? 'opus'
          : key.includes('sonnet') ? 'sonnet'
          : key.includes('haiku')  ? 'haiku'
          : null;
  if (isDefault) fam = DEFAULT_FAMILY;
  if (!fam) return raw;   // unknown explicit value — show it as-is

  const Fam  = fam.charAt(0).toUpperCase() + fam.slice(1);
  const oneM = key.includes('[1m]')     ? ' 1M'   : '';
  const plan = key.includes('opusplan') ? ' · Plan' : '';

  const inline = key.match(/(\d+)-(\d+)/);
  const ver = inline ? `${inline[1]}.${inline[2]}`
                     : resolveModelVersion(fam) || FALLBACK_VERSION[fam] || null;

  const base = ver ? `${Fam} ${ver}${oneM}${plan}` : `${Fam}${oneM}${plan}`;
  return isDefault ? `${base} · Auto` : base;
}

// ── HTTPS helper ──────────────────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req   = net.request({ url, method: 'GET' });
    const timer = setTimeout(() => { req.abort(); reject(new Error('timeout')); }, 12000);

    Object.entries({ ...headers, Accept: 'application/json' })
      .forEach(([k, v]) => req.setHeader(k, v));

    req.on('response', (res) => {
      let body = '';
      res.on('data',  (c) => body += c.toString());
      res.on('end',   ()  => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode, ok: res.statusCode < 300, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, ok: false, body: null }); }
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchAll() {
  const creds = readCredentials();
  const model = readModelLabel();
  if (!creds.token) return { error: 'no_token', creds, model };

  const hdrs = {
    Authorization:       `Bearer ${creds.token}`,
    'anthropic-version': '2023-06-01',
  };

  const result = { creds, model };
  const errs   = [];

  const [profileRes, usageRes] = await Promise.allSettled([
    httpsGet(`${API_BASE}/api/oauth/profile`, hdrs),
    httpsGet(`${API_BASE}/api/oauth/usage`,   hdrs),
  ]);

  if (profileRes.status === 'fulfilled' && profileRes.value.ok) {
    result.profile = profileRes.value.body;
  } else {
    const e = profileRes.status === 'rejected'
      ? profileRes.reason?.message
      : `${profileRes.value?.status}`;
    errs.push(`profile:${e}`);
    logError('API profile', e);
  }

  if (usageRes.status === 'fulfilled' && usageRes.value.ok) {
    result.usage = usageRes.value.body;
  } else {
    const e = usageRes.status === 'rejected'
      ? usageRes.reason?.message
      : `${usageRes.value?.status}`;
    errs.push(`usage:${e}`);
    logError('API usage', e);
  }

  if (errs.length) result.errs = errs;
  return result;
}

// ── Window bounds helper ──────────────────────────────────────────────────────
// The window is resized to match visible content so there is never an invisible
// transparent area capturing mouse events.
//   Compact:  290 × 52  at (winX, winY)
//   Expanded: 290 × 410 at (winX, winY - 358)  — grows upward from the bar

let isPanelExpanded = false;

// Actual expanded height; the renderer measures its content and reports it so the
// window fits exactly — no empty transparent strip (which renders as a white bar)
// when optional rows are hidden. EXPANDED_H is only the initial fallback.
let expandedH = EXPANDED_H;

function getBounds() {
  if (isPanelExpanded) {
    return { x: winX, y: winY - (expandedH - COMPACT_H), width: WIDGET_W, height: expandedH };
  }
  return { x: winX, y: winY, width: WIDGET_W, height: COMPACT_H };
}

function applyBounds() {
  if (win && !win.isDestroyed()) win.setBounds(getBounds(), false);
}

// ── Bounds sync ───────────────────────────────────────────────────────────────
// Re-syncs winX/winY from actual OS bounds after sleep/wake or display changes
// so the drag handler doesn't jump on the next move.

function syncBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  winX = b.x;
  winY = isPanelExpanded ? b.y + (expandedH - COMPACT_H) : b.y;
}

// ── Restart / quit ────────────────────────────────────────────────────────────

function restartWidget() {
  if (win && !win.isDestroyed()) win.close();
  setTimeout(createWindow, 600);
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const prefs = loadPrefs();

  winX = prefs.x        ?? (width  - WIDGET_W  - 20);
  winY = prefs.compact_y ?? (height - COMPACT_H - 20);
  winY = Math.max(0, Math.min(height - COMPACT_H, winY));

  win = new BrowserWindow({
    icon:            path.join(__dirname, 'icon.ico'),
    width:           WIDGET_W,
    height:          COMPACT_H,   // start compact; resized on panel open/close
    x:               winX,
    y:               winY,
    frame:           false,
    thickFrame:      false,
    transparent:     true,
    alwaysOnTop:     true,
    focusable:       true,
    resizable:       false,
    skipTaskbar:     true,
    hasShadow:       false,
    backgroundColor: '#00000000',
    show:            false,
    webPreferences: {
      preload:               path.join(__dirname, 'preload.js'),
      nodeIntegration:       false,
      contextIsolation:      true,
      backgroundThrottling:  false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(desiredOnTop, 'screen-saver');
  });

  win.webContents.on('did-fail-load', (e, code, desc) => {
    logError('Load failed', `${code} ${desc}`);
  });

  win.webContents.on('render-process-gone', (e, details) => {
    logError('Renderer gone', JSON.stringify(details));
    if (win && !win.isDestroyed()) {
      isPanelExpanded = false;
      setTimeout(() => { if (win && !win.isDestroyed()) { applyBounds(); win.loadFile('index.html'); } }, 1500);
    }
  });

  win.webContents.on('unresponsive', () => {
    logError('Renderer unresponsive', 'reloading');
    if (win && !win.isDestroyed()) {
      isPanelExpanded = false;
      applyBounds();
      win.webContents.reload();
    }
  });

  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => win.setTitle(''));
  win.on('closed', () => { win = null; });
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('fetch-data', async () => {
  try { return await fetchAll(); }
  catch (e) { logError('fetch-data', e.message); return { error: e.message }; }
});

ipcMain.on('close-window',    () => { if (win) win.close(); });
ipcMain.on('restart-widget',  restartWidget);
ipcMain.on('quit-app',        () => app.quit());

ipcMain.handle('toggle-pin', () => {
  if (!win) return false;
  desiredOnTop = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(desiredOnTop, 'screen-saver');
  return desiredOnTop;
});

// Drag
let dragActive  = false;
let safetyTimer = null;

function stopDrag() {
  dragActive = false;
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  savePrefs({ x: winX, compact_y: winY });
}

ipcMain.on('drag-start', () => {
  if (!win) return;
  stopDrag();
  dragActive  = true;
  safetyTimer = setTimeout(stopDrag, 10_000);
});

ipcMain.on('drag-move', (_, { dx, dy }) => {
  if (!dragActive || !win) return;
  winX = Math.round(winX + dx);
  winY = Math.round(winY + dy);
  win.setBounds(getBounds(), false);
});

ipcMain.on('drag-end', stopDrag);

// Panel expand / collapse — resize the window to match visible content.
let collapseTimer = null;

ipcMain.on('panel-state', (_, payload) => {
  const expanded = typeof payload === 'object' ? payload.expanded : payload;
  if (typeof payload === 'object' && payload.height > 0) {
    // Clamp to a sane range so a bad measurement can't produce a giant/zero window.
    expandedH = Math.max(COMPACT_H, Math.min(900, Math.round(payload.height)));
  }
  isPanelExpanded = expanded;
  if (expanded) {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    applyBounds();  // grow to 290×410
  } else {
    // Wait for CSS collapse animation (480 ms) before shrinking.
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (!isPanelExpanded) applyBounds();  // shrink back to 290×52
    }, 500);
  }
});

// ── App ───────────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    winX = width  - WIDGET_W  - 20;
    winY = height - COMPACT_H - 20;
    win.setBounds(getBounds(), false);
    savePrefs({ x: winX, compact_y: winY });
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });

    globalShortcut.register('CommandOrControl+Alt+W', () => app.quit());
    globalShortcut.register('CommandOrControl+Alt+R', restartWidget);

    setInterval(() => {
      if (win && !win.isDestroyed()) win.webContents.send('auto-refresh');
    }, 120_000);

    // Keep Chromium's input pipeline alive for a focusable:false window.
    // Without periodic input events, Chromium puts the pipeline in a dormant
    // state after extended inactivity and stops delivering real mouse events.
    // Runs in the main Node.js process so Chromium can never throttle it.
    function warmInputPipeline() {
      if (win && !win.isDestroyed()) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
      }
    }
    setInterval(warmInputPipeline, 1000);

    // Re-assert always-on-top if Windows silently dropped it, so the widget can't
    // get stuck behind other windows (which makes it look frozen / unclickable).
    setInterval(() => {
      if (win && !win.isDestroyed() && desiredOnTop && !win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 2000);

    // After sleep/wake and display changes: sync bounds and re-warm the input
    // pipeline in case Chromium's internal state was reset by the OS event.
    function recoverAfterOsEvent() {
      syncBounds();
      warmInputPipeline();
      if (win && !win.isDestroyed() && desiredOnTop) {
        win.setAlwaysOnTop(true, 'screen-saver');
      }
    }

    powerMonitor.on('resume',            () => { setTimeout(recoverAfterOsEvent, 1000); setTimeout(recoverAfterOsEvent, 4000); });
    powerMonitor.on('unlock-screen',     () => { setTimeout(recoverAfterOsEvent,  500); setTimeout(recoverAfterOsEvent, 2000); });
    screen.on('display-metrics-changed', () => setTimeout(recoverAfterOsEvent,  800));
    screen.on('display-added',           () => setTimeout(recoverAfterOsEvent,  800));
    screen.on('display-removed',         () => setTimeout(recoverAfterOsEvent,  800));
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

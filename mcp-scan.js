// Escaneo de los servidores MCP declarados en el sistema. Modulo puro de Node
// (no importa Electron) para poder ejercitarlo desde la linea de comandos y
// desde tests, igual que skills-scan.js.
//
// Tres fuentes:
//   plugin   ~/.claude/plugins/cache/<mkt>/<plugin>/<version>/  (via plugin.json o .mcp.json)
//   user     ~/.claude.json -> mcpServers
//   project  <ruta>/.mcp.json y ~/.claude.json -> projects[<ruta>].mcpServers
//
// IMPORTANTE: los registros que devuelve este modulo NUNCA llevan valores de
// env ni de headers, solo los nombres de las claves. Los .mcp.json de plugin
// usan placeholders (${GITHUB_PERSONAL_ACCESS_TOKEN}), pero uno de usuario o de
// proyecto puede traer un token literal y esto termina pintado en pantalla.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Un .mcp.json aparece de dos formas en el propio marketplace oficial: como mapa
// pelado ({"github": {...}}) o envuelto ({"mcpServers": {"vercel": {...}}}).
// Regla unica: si hay una clave mcpServers que es objeto, esa es el mapa; si no,
// el objeto entero lo es. El caso raro (mcpServers con un string de ruta) se
// descarta de la mezcla en vez de acabar como un servidor fantasma.
function normalizeServers(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};

  const inner = obj.mcpServers;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;

  if ('mcpServers' in obj) {
    const rest = { ...obj };
    delete rest.mcpServers;
    return rest;
  }
  return obj;
}

// Devuelve el JSON, undefined si el archivo no existe, o null si esta corrupto.
// Los tres casos se tratan distinto: ausente es normal, corrupto se reporta.
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
             .filter((e) => e.isDirectory())
             .map((e) => e.name);
  } catch {
    return [];
  }
}

// Una URL de MCP puede llevar la credencial en el query string, asi que se
// recorta: lo que identifica al servidor es el host y el path.
function cleanUrl(url) {
  return String(url).split(/[?#]/)[0];
}

function keysOf(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [];
}

// Convierte una entrada cruda del mapa en el registro que consume la ventana.
// Devuelve null si la entrada no es un objeto: un .mcp.json a mano puede tener
// cualquier cosa adentro y no vale la pena tumbar el escaneo por eso.
function toRecord(name, cfg, { source, group, version, enabled, file }) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;

  const transport = cfg.type || (cfg.command ? 'stdio' : cfg.url ? 'http' : '');
  const detail = cfg.command
    ? [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].join(' ')
    : cfg.url ? cleanUrl(cfg.url) : '';

  return {
    name,
    source,
    group,
    version,
    transport,
    detail,
    enabled,
    note:       typeof cfg.note === 'string' ? cfg.note : '',
    envKeys:    keysOf(cfg.env),
    headerKeys: keysOf(cfg.headers),
    path:       file,
    parsed:     true,
  };
}

// Fila de relleno para una declaracion que existe pero no se pudo leer. Se
// muestra igual que una skill sin frontmatter legible: mejor un aviso visible
// que un plugin que desaparece del listado sin explicacion.
function brokenRecord(name, { source, group, version, enabled, file }) {
  return {
    name, source, group, version,
    transport: '', detail: '', enabled,
    note: '', envKeys: [], headerKeys: [],
    path: file, parsed: false,
  };
}

function addServers(map, meta, out) {
  for (const [name, cfg] of Object.entries(map)) {
    const rec = toRecord(name, cfg, meta);
    if (rec) out.push(rec);
  }
}

// ── Fuentes ───────────────────────────────────────────────────────────────────

// Resuelve donde declara sus MCP un plugin. plugin.json manda: su clave
// mcpServers puede ser una ruta relativa (supabase usa ./agents/claude/.mcp.json,
// asi que no se puede asumir la raiz) o el mapa inline. Sin plugin.json, se cae
// al .mcp.json de la raiz.
function pluginServers(root) {
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  const decl     = manifest && manifest.mcpServers;

  if (decl && typeof decl === 'object') {
    return { servers: normalizeServers(decl), file: path.join(root, '.claude-plugin', 'plugin.json') };
  }

  const file = typeof decl === 'string'
    ? path.resolve(root, decl)
    : path.join(root, '.mcp.json');

  const json = readJson(file);
  if (json === undefined) return null;              // no declara MCP
  if (json === null)      return { broken: true, file };
  return { servers: normalizeServers(json), file };
}

function scanPlugins(home, settings, out) {
  const cache    = path.join(home, '.claude', 'plugins', 'cache');
  const enabledP = (settings && settings.enabledPlugins) || {};

  for (const mkt of subdirs(cache)) {
    for (const plugin of subdirs(path.join(cache, mkt))) {
      for (const version of subdirs(path.join(cache, mkt, plugin))) {
        const root = path.join(cache, mkt, plugin, version);
        const res  = pluginServers(root);
        if (!res) continue;

        const meta = {
          source:  'plugin',
          group:   plugin,
          version: version === 'unknown' ? '' : version,
          enabled: enabledP[`${plugin}@${mkt}`] === true,
          file:    res.file,
        };

        if (res.broken) out.push(brokenRecord(plugin, meta));
        else            addServers(res.servers, meta, out);
      }
    }
  }
}

function scanUser(claudeJson, file, out) {
  addServers(normalizeServers(claudeJson.mcpServers), {
    source: 'user', group: '', version: '', enabled: true, file,
  }, out);
}

// Un .mcp.json de proyecto no se carga hasta que el usuario lo aprueba, asi que
// arranca deshabilitado. Lo declarado en projects[ruta].mcpServers, en cambio,
// lo escribio el propio usuario: ya esta activo.
function scanProjects(claudeJson, settings, out) {
  const projects = claudeJson.projects || {};
  const allOn    = settings && settings.enableAllProjectMcpServers === true;

  for (const [proj, cfg = {}] of Object.entries(projects)) {
    const group = path.basename(proj) || proj;

    addServers(normalizeServers(cfg.mcpServers), {
      source: 'project', group, version: '', enabled: true, file: proj,
    }, out);

    const file = path.join(proj, '.mcp.json');
    const json = readJson(file);
    if (json === undefined) continue;             // repos borrados o movidos

    const on  = cfg.enabledMcpjsonServers  || [];
    const off = cfg.disabledMcpjsonServers || [];

    if (json === null) {
      out.push(brokenRecord(group, { source: 'project', group, version: '', enabled: false, file }));
      continue;
    }

    for (const [name, srv] of Object.entries(normalizeServers(json))) {
      const enabled = !off.includes(name) && (allOn || on.includes(name));
      const rec = toRecord(name, srv, { source: 'project', group, version: '', enabled, file });
      if (rec) out.push(rec);
    }
  }
}

// ── Entrada ───────────────────────────────────────────────────────────────────

// Cada fuente va en su propio try/catch: una fuente rota deja las demas intactas
// y se reporta por onError. user y project comparten archivo, asi que un
// ~/.claude.json ilegible se reporta una sola vez.
function scanMcps({ home = os.homedir(), onError = () => {} } = {}) {
  const out = [];

  const settings = readJson(path.join(home, '.claude', 'settings.json')) || {};

  try {
    scanPlugins(home, settings, out);
  } catch (e) { onError('plugins', e.message); }

  const claudeFile = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeFile);

  if (claudeJson === null) {
    onError('user', `no se pudo parsear ${claudeFile}`);
  } else if (claudeJson) {
    try {
      scanUser(claudeJson, claudeFile, out);
    } catch (e) { onError('user', e.message); }

    try {
      scanProjects(claudeJson, settings, out);
    } catch (e) { onError('projects', e.message); }
  }

  return out;
}

module.exports = { scanMcps, normalizeServers };

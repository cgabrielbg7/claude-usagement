const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanMcps, normalizeServers } = require('../mcp-scan');

// ── Helpers de fixtures ────────────────────────────────────────────────

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// Crea un plugin en la cache. manifest es lo que va en .claude-plugin/plugin.json
// (omitido si es null); files son rutas relativas a la raiz del plugin.
function writePlugin(home, name, version, { manifest = null, files = {} } = {}) {
  const root = path.join(home, '.claude', 'plugins', 'cache', 'mkt', name, version);
  fs.mkdirSync(root, { recursive: true });
  if (manifest) writeJson(path.join(root, '.claude-plugin', 'plugin.json'), manifest);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return root;
}

// Por defecto todo plugin cuenta como habilitado, para que los tests que no van
// de eso no tengan que escribir settings.json.
function enableAll(home, names) {
  const enabledPlugins = {};
  for (const n of names) enabledPlugins[`${n}@mkt`] = true;
  writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins });
}

function scan(home) {
  return scanMcps({ home, onError: () => {} });
}

function byName(list, name) {
  return list.find((s) => s.name === name);
}

// ── normalizeServers: las dos formas de archivo ────────────────────────

test('normalizeServers acepta el mapa pelado', () => {
  const out = normalizeServers({ github: { url: 'https://x' } });
  assert.deepStrictEqual(Object.keys(out), ['github']);
});

test('normalizeServers desenvuelve la clave mcpServers', () => {
  const out = normalizeServers({ mcpServers: { vercel: { url: 'https://x' } } });
  assert.deepStrictEqual(Object.keys(out), ['vercel']);
});

test('normalizeServers no confunde un servidor llamado mcpServers con el envoltorio', () => {
  // Un mapa pelado cuyo unico servidor se llamara "mcpServers" tendria adentro
  // command/url, no otros servidores. Se trata como envoltorio solo si su valor
  // es un objeto de objetos... el caso real es que el envoltorio gana.
  const out = normalizeServers({ mcpServers: 'ruta/relativa.json' });
  assert.deepStrictEqual(out, {});
});

// ── Fuente plugin ──────────────────────────────────────────────────────

test('lee un .mcp.json de la raiz cuando no hay plugin.json', () => {
  const home = tmpHome();
  writePlugin(home, 'context7', 'unknown', {
    files: { '.mcp.json': { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } },
  });
  enableAll(home, ['context7']);

  const out = scan(home);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'context7');
  assert.strictEqual(out[0].source, 'plugin');
  assert.strictEqual(out[0].group, 'context7');
  assert.strictEqual(out[0].parsed, true);
});

test('omite la version cuando es "unknown"', () => {
  const home = tmpHome();
  writePlugin(home, 'github', 'unknown', { files: { '.mcp.json': { github: { url: 'https://x' } } } });
  enableAll(home, ['github']);
  assert.strictEqual(scan(home)[0].version, '');
});

test('conserva la version real del plugin', () => {
  const home = tmpHome();
  writePlugin(home, 'vercel', '0.44.0', {
    files: { '.mcp.json': { mcpServers: { vercel: { url: 'https://mcp.vercel.com' } } } },
  });
  enableAll(home, ['vercel']);
  assert.strictEqual(scan(home)[0].version, '0.44.0');
});

test('sigue la ruta relativa que declara plugin.json', () => {
  const home = tmpHome();
  writePlugin(home, 'supabase', '0.1.12', {
    manifest: { name: 'supabase', mcpServers: './agents/claude/.mcp.json' },
    files: { 'agents/claude/.mcp.json': { supabase: { command: 'npx', args: ['-y', 'supabase-mcp'] } } },
  });
  enableAll(home, ['supabase']);

  const out = scan(home);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'supabase');
});

test('acepta mcpServers inline en plugin.json', () => {
  const home = tmpHome();
  writePlugin(home, 'inline', '1.0.0', {
    manifest: { name: 'inline', mcpServers: { foo: { command: 'foo-server' } } },
  });
  enableAll(home, ['inline']);

  const out = scan(home);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'foo');
});

test('ignora un plugin sin ninguna declaracion de MCP', () => {
  const home = tmpHome();
  writePlugin(home, 'solo-skills', '1.0.0', { manifest: { name: 'solo-skills', skills: './skills/' } });
  enableAll(home, ['solo-skills']);
  assert.deepStrictEqual(scan(home), []);
});

// ── transport y detail ─────────────────────────────────────────────────

test('infiere stdio cuando hay command', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', { files: { '.mcp.json': { a: { command: 'npx', args: ['-y', 'x'] } } } });
  enableAll(home, ['p']);

  const s = scan(home)[0];
  assert.strictEqual(s.transport, 'stdio');
  assert.strictEqual(s.detail, 'npx -y x');
});

test('infiere http cuando hay url', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', { files: { '.mcp.json': { a: { url: 'https://mcp.vercel.com' } } } });
  enableAll(home, ['p']);

  const s = scan(home)[0];
  assert.strictEqual(s.transport, 'http');
  assert.strictEqual(s.detail, 'https://mcp.vercel.com');
});

test('el type explicito gana sobre la inferencia', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', { files: { '.mcp.json': { a: { type: 'sse', url: 'https://x' } } } });
  enableAll(home, ['p']);
  assert.strictEqual(scan(home)[0].transport, 'sse');
});

test('recorta el query string de la url: puede llevar el token', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', {
    files: { '.mcp.json': { a: { url: 'https://mcp.example.com/sse?api_key=SECRETO123' } } },
  });
  enableAll(home, ['p']);

  const s = scan(home)[0];
  assert.strictEqual(s.detail, 'https://mcp.example.com/sse');
  assert.ok(!JSON.stringify(s).includes('SECRETO123'));
});

test('conserva el note del servidor', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', {
    files: { '.mcp.json': { a: { url: 'https://x', note: 'Usa OAuth' } } },
  });
  enableAll(home, ['p']);
  assert.strictEqual(scan(home)[0].note, 'Usa OAuth');
});

// ── Secretos ───────────────────────────────────────────────────────────

test('expone los nombres de env y headers pero nunca sus valores', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', {
    files: {
      '.mcp.json': {
        a: {
          command: 'srv',
          env: { AZURE_TENANT_ID: 'tenant-secreto', PATH: '/usr/bin' },
          headers: { Authorization: 'Bearer token-literal-filtrado' },
        },
      },
    },
  });
  enableAll(home, ['p']);

  const s = scan(home)[0];
  assert.deepStrictEqual(s.envKeys, ['AZURE_TENANT_ID', 'PATH']);
  assert.deepStrictEqual(s.headerKeys, ['Authorization']);

  const dump = JSON.stringify(s);
  assert.ok(!dump.includes('tenant-secreto'), 'se filtro un valor de env');
  assert.ok(!dump.includes('token-literal-filtrado'), 'se filtro un valor de header');
  assert.ok(!dump.includes('/usr/bin'), 'se filtro un valor de env');
});

test('los args si se muestran: son publicos y son lo que identifica al servidor', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', {
    files: { '.mcp.json': { a: { command: 'npx', args: ['-y', '@azure/mcp@latest', 'server', 'start'] } } },
  });
  enableAll(home, ['p']);
  assert.strictEqual(scan(home)[0].detail, 'npx -y @azure/mcp@latest server start');
});

// ── enabled ────────────────────────────────────────────────────────────

test('marca enabled false cuando el plugin esta deshabilitado en settings.json', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', { files: { '.mcp.json': { a: { command: 'x' } } } });
  writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'p@mkt': false } });
  assert.strictEqual(scan(home)[0].enabled, false);
});

test('marca enabled false cuando el plugin no figura en enabledPlugins', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', { files: { '.mcp.json': { a: { command: 'x' } } } });
  writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: {} });
  assert.strictEqual(scan(home)[0].enabled, false);
});

test('marca enabled true cuando el plugin esta habilitado', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', { files: { '.mcp.json': { a: { command: 'x' } } } });
  enableAll(home, ['p']);
  assert.strictEqual(scan(home)[0].enabled, true);
});

// ── Fuente user ────────────────────────────────────────────────────────

test('lee los MCP de usuario de ~/.claude.json', () => {
  const home = tmpHome();
  writeJson(path.join(home, '.claude.json'), {
    mcpServers: { mio: { command: 'mi-server' } },
    projects: {},
  });

  const out = scan(home);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'mio');
  assert.strictEqual(out[0].source, 'user');
  assert.strictEqual(out[0].enabled, true);
});

// ── Fuente project ─────────────────────────────────────────────────────

test('lee el .mcp.json de un proyecto registrado', () => {
  const home = tmpHome();
  const proj = path.join(home, 'repo');
  fs.mkdirSync(proj, { recursive: true });
  writeJson(path.join(proj, '.mcp.json'), { deproyecto: { command: 'x' } });
  writeJson(path.join(home, '.claude.json'), { projects: { [proj]: {} } });

  const out = scan(home);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'deproyecto');
  assert.strictEqual(out[0].source, 'project');
  assert.strictEqual(out[0].group, 'repo');
});

test('un .mcp.json de proyecto arranca deshabilitado hasta que se apruebe', () => {
  const home = tmpHome();
  const proj = path.join(home, 'repo');
  fs.mkdirSync(proj, { recursive: true });
  writeJson(path.join(proj, '.mcp.json'), { pendiente: { command: 'x' } });
  writeJson(path.join(home, '.claude.json'), { projects: { [proj]: {} } });

  assert.strictEqual(scan(home)[0].enabled, false);
});

test('enabledMcpjsonServers habilita un MCP de proyecto', () => {
  const home = tmpHome();
  const proj = path.join(home, 'repo');
  fs.mkdirSync(proj, { recursive: true });
  writeJson(path.join(proj, '.mcp.json'), { aprobado: { command: 'x' } });
  writeJson(path.join(home, '.claude.json'), {
    projects: { [proj]: { enabledMcpjsonServers: ['aprobado'] } },
  });

  assert.strictEqual(scan(home)[0].enabled, true);
});

test('lee los MCP locales declarados en projects[ruta].mcpServers', () => {
  const home = tmpHome();
  const proj = path.join(home, 'repo');
  fs.mkdirSync(proj, { recursive: true });
  writeJson(path.join(home, '.claude.json'), {
    projects: { [proj]: { mcpServers: { local: { command: 'x' } } } },
  });

  const out = scan(home);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'local');
  assert.strictEqual(out[0].source, 'project');
  assert.strictEqual(out[0].enabled, true);
});

test('ignora proyectos borrados o movidos', () => {
  const home = tmpHome();
  writeJson(path.join(home, '.claude.json'), {
    projects: { [path.join(home, 'no-existe')]: {} },
  });
  assert.deepStrictEqual(scan(home), []);
});

// ── Robustez ───────────────────────────────────────────────────────────

test('un .mcp.json corrupto marca parsed false sin tumbar las demas fuentes', () => {
  const home = tmpHome();
  writePlugin(home, 'roto', '1.0.0', { files: { '.mcp.json': '{ esto no es json' } });
  writePlugin(home, 'sano', '1.0.0', { files: { '.mcp.json': { ok: { command: 'x' } } } });
  enableAll(home, ['roto', 'sano']);

  const out = scan(home);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(byName(out, 'ok').parsed, true);

  const roto = out.find((s) => s.parsed === false);
  assert.ok(roto, 'falta el registro del plugin roto');
  assert.strictEqual(roto.group, 'roto');
});

test('reporta la fuente rota por onError sin lanzar', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '{ roto', 'utf8');

  const errores = [];
  const out = scanMcps({ home, onError: (src, msg) => errores.push([src, msg]) });

  assert.deepStrictEqual(out, []);
  assert.strictEqual(errores.length, 1);
});

test('un home sin nada devuelve lista vacia', () => {
  assert.deepStrictEqual(scan(tmpHome()), []);
});

test('no revienta si un servidor no es un objeto', () => {
  const home = tmpHome();
  writePlugin(home, 'p', '1.0.0', { files: { '.mcp.json': { a: 'no-soy-objeto', b: { command: 'x' } } } });
  enableAll(home, ['p']);

  const out = scan(home);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'b');
});

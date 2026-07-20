# Catálogo de Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar al widget una ventana nueva que lista, solo para consulta, las 78 skills instaladas en el sistema, agrupadas por origen y con buscador.

**Architecture:** Un módulo puro de Node (`skills-scan.js`) recorre tres fuentes del sistema de archivos y devuelve un array de skills; el proceso main de Electron lo expone por IPC a una ventana nueva (`skills.html`) que renderiza la lista agrupada. El widget existente solo gana un botón y una línea de preload.

**Tech Stack:** Electron 35, JavaScript sin transpilar, cero dependencias nuevas. Tests con el runner integrado `node:test` (Node v24).

**Spec:** `docs/superpowers/specs/2026-07-20-catalogo-skills-design.md`

## Global Constraints

- **Cero dependencias nuevas.** No agregar paquetes a `package.json`. El parser de frontmatter se escribe a mano.
- **Solo consulta.** Ninguna ruta de código escribe, borra ni modifica archivos del sistema. `skills-scan.js` solo lee.
- **De `~/.claude.json` se extraen únicamente las claves de `projects`** (rutas). Ningún otro contenido de ese archivo se lee ni se expone al renderer.
- **Contexto de aislamiento:** todas las ventanas usan `nodeIntegration: false` y `contextIsolation: true`. El renderer nunca importa `fs` ni `path`.
- **Preload separado:** la ventana de skills usa `skills-preload.js`, que expone únicamente `scan()` y `close()`. No debe exponer `quit`, `togglePin` ni `fetchData`.
- **Idioma de la UI:** español, igual que el widget ("Reiniciar widget", "Salir").
- **No tocar** la lógica de bounds, drag, tray, always-on-top ni `window-all-closed` de `main.js`. El widget está en un punto estable (tag `estable-2026-07-17`).
- **Estilo:** reutilizar las variables CSS del widget (`--gbg`, `--text`, `--sub`, `--blue`, `--sep`, `--r`, `--btn-hover`) y soportar los dos temas vía `[data-theme="light"]`.

---

### Task 1: Módulo de escaneo `skills-scan.js`

Módulo puro de Node, sin Electron. Es la única pieza con lógica no trivial, así que va con tests reales.

**Files:**
- Create: `skills-scan.js`
- Test: `test/skills-scan.test.js`

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces:
  - `parseFrontmatter(text: string) -> object | null` — objeto con las claves del frontmatter, o `null` si el texto no empieza con un bloque `---`.
  - `scanSkills(opts?: { home?: string, onError?: (source: string, message: string) => void }) -> Skill[]`
  - `Skill = { name: string, description: string, source: 'personal'|'plugin'|'project', group: string, version: string, path: string, parsed: boolean }`
  - `opts.home` por defecto `os.homedir()`; existe para que los tests apunten a un directorio de fixtures.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/skills-scan.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseFrontmatter, scanSkills } = require('../skills-scan');

// ── Helpers de fixtures ────────────────────────────────────────────────

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
}

function writeSkill(skillsDir, name, body) {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  return dir;
}

function fm(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

// ── parseFrontmatter ───────────────────────────────────────────────────

test('parseFrontmatter extrae name y description', () => {
  const out = parseFrontmatter('---\nname: foo\ndescription: hace algo\n---\n\n# Foo');
  assert.strictEqual(out.name, 'foo');
  assert.strictEqual(out.description, 'hace algo');
});

test('parseFrontmatter une descripciones envueltas en varias lineas', () => {
  const out = parseFrontmatter('---\nname: foo\ndescription: primera parte\n  segunda parte\n---\n');
  assert.strictEqual(out.description, 'primera parte segunda parte');
});

test('parseFrontmatter devuelve null sin bloque frontmatter', () => {
  assert.strictEqual(parseFrontmatter('# Solo un titulo\n'), null);
});

// ── scanSkills: fuente personal ────────────────────────────────────────

test('scanSkills encuentra skills personales', () => {
  const home = tmpHome();
  const skills = path.join(home, '.claude', 'skills');
  writeSkill(skills, 'mi-skill', fm('mi-skill', 'descripcion de prueba'));

  const out = scanSkills({ home });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'mi-skill');
  assert.strictEqual(out[0].description, 'descripcion de prueba');
  assert.strictEqual(out[0].source, 'personal');
  assert.strictEqual(out[0].parsed, true);
});

test('scanSkills ignora carpetas sin SKILL.md', () => {
  const home = tmpHome();
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'carpeta-vacia'), { recursive: true });

  assert.strictEqual(scanSkills({ home }).length, 0);
});

test('scanSkills marca parsed:false y usa el nombre de carpeta si no hay frontmatter', () => {
  const home = tmpHome();
  const skills = path.join(home, '.claude', 'skills');
  writeSkill(skills, 'rota', '# Sin frontmatter\n');

  const out = scanSkills({ home });

  assert.strictEqual(out[0].name, 'rota');
  assert.strictEqual(out[0].description, '');
  assert.strictEqual(out[0].parsed, false);
});

// ── scanSkills: fuente plugins ─────────────────────────────────────────

test('scanSkills encuentra skills de plugins con plugin y version', () => {
  const home = tmpHome();
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'miplugin', '1.2.3', 'skills');
  writeSkill(dir, 'skill-plugin', fm('skill-plugin', 'del plugin'));

  const out = scanSkills({ home });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'plugin');
  assert.strictEqual(out[0].group, 'miplugin');
  assert.strictEqual(out[0].version, '1.2.3');
});

test('scanSkills deja version vacia cuando el plugin reporta "unknown"', () => {
  const home = tmpHome();
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'otro', 'unknown', 'skills');
  writeSkill(dir, 'x', fm('x', 'y'));

  assert.strictEqual(scanSkills({ home })[0].version, '');
});

// ── scanSkills: fuente proyectos + dedup ───────────────────────────────

test('scanSkills encuentra skills de proyecto y salta rutas inexistentes', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  writeSkill(path.join(proj, '.claude', 'skills'), 'de-proyecto', fm('de-proyecto', 'local'));

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ projects: { [proj]: {}, 'C:\\\\ruta\\\\que\\\\no\\\\existe': {} } }),
    'utf8',
  );

  const out = scanSkills({ home });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'project');
  assert.strictEqual(out[0].name, 'de-proyecto');
});

test('scanSkills no duplica cuando un proyecto apunta a la carpeta de skills personal', () => {
  const home = tmpHome();
  writeSkill(path.join(home, '.claude', 'skills'), 'compartida', fm('compartida', 'una sola vez'));

  // El home registrado como proyecto: su .claude/skills ES la carpeta personal.
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ projects: { [home]: {} } }),
    'utf8',
  );

  const out = scanSkills({ home });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'personal');
});

// ── Robustez ───────────────────────────────────────────────────────────

test('scanSkills devuelve [] si no existe nada', () => {
  assert.deepStrictEqual(scanSkills({ home: tmpHome() }), []);
});

test('scanSkills reporta el error de proyectos sin lanzar si ~/.claude.json esta corrupto', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeSkill(path.join(home, '.claude', 'skills'), 'ok', fm('ok', 'sigue funcionando'));
  fs.writeFileSync(path.join(home, '.claude.json'), '{ esto no es json', 'utf8');

  const errs = [];
  const out = scanSkills({ home, onError: (src, msg) => errs.push(src) });

  assert.strictEqual(out.length, 1);       // la fuente personal sobrevive
  assert.deepStrictEqual(errs, ['projects']);
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
node --test test/
```

Esperado: FAIL — `Cannot find module '../skills-scan'`.

- [ ] **Step 3: Escribir la implementación**

Crear `skills-scan.js`:

```js
// Escaneo de las skills instaladas en el sistema. Modulo puro de Node (no importa
// Electron) para poder ejercitarlo desde la linea de comandos y desde tests.
//
// Tres fuentes:
//   personal  ~/.claude/skills/<skill>/SKILL.md
//   plugin    ~/.claude/plugins/cache/<mkt>/<plugin>/<version>/skills/<skill>/SKILL.md
//   project   <ruta>/.claude/skills/<skill>/SKILL.md   (rutas: claves de projects en ~/.claude.json)

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// El frontmatter siempre esta al inicio del archivo: leyendo solo la cabecera
// evitamos cargar SKILL.md largos completos (algunos pasan de 20 KB).
const FRONTMATTER_BYTES = 8192;

// Parsea un bloque YAML frontmatter plano (clave: valor). Soporta valores
// envueltos en varias lineas, que es como quedan las descripciones largas.
// Devuelve null si el texto no empieza con un bloque ---.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;

  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].trim();
    } else if (key && line.trim()) {
      out[key] += ' ' + line.trim();
    }
  }
  return out;
}

function readFrontmatter(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf   = Buffer.alloc(FRONTMATTER_BYTES);
    const bytes = fs.readSync(fd, buf, 0, FRONTMATTER_BYTES, 0);
    return parseFrontmatter(buf.subarray(0, bytes).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Subcarpetas de dir. Devuelve [] si dir no existe o no se puede leer: una fuente
// ausente o sin permisos nunca debe tumbar el escaneo completo.
function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
             .filter((e) => e.isDirectory())
             .map((e) => e.name);
  } catch {
    return [];
  }
}

// Agrega al array out todas las skills de skillsDir. seen deduplica por ruta real:
// la carpeta de usuario suele estar registrada como proyecto y su .claude/skills
// ES la carpeta personal, que si no apareceria dos veces.
function collect(skillsDir, source, group, version, seen, out) {
  for (const name of subdirs(skillsDir)) {
    const dir  = path.join(skillsDir, name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;

    let real;
    try { real = fs.realpathSync(dir); } catch { real = dir; }
    const key = real.toLowerCase();          // Windows: rutas case-insensitive
    if (seen.has(key)) continue;
    seen.add(key);

    const fm = readFrontmatter(file);
    out.push({
      name:        (fm && fm.name)        || name,
      description: (fm && fm.description) || '',
      source,
      group,
      version,
      path:        dir,
      parsed:      fm !== null,
    });
  }
}

// Escanea las tres fuentes. Cada una va en su propio try/catch: una fuente rota
// deja las demas intactas y se reporta por onError.
function scanSkills({ home = os.homedir(), onError = () => {} } = {}) {
  const skills = [];
  const seen   = new Set();

  // 1. Personales — primero, para que ganen la deduplicacion frente a proyectos.
  try {
    collect(path.join(home, '.claude', 'skills'), 'personal', '', '', seen, skills);
  } catch (e) { onError('personal', e.message); }

  // 2. Plugins.
  try {
    const cache = path.join(home, '.claude', 'plugins', 'cache');
    for (const mkt of subdirs(cache)) {
      for (const plugin of subdirs(path.join(cache, mkt))) {
        for (const version of subdirs(path.join(cache, mkt, plugin))) {
          collect(
            path.join(cache, mkt, plugin, version, 'skills'),
            'plugin',
            plugin,
            version === 'unknown' ? '' : version,
            seen,
            skills,
          );
        }
      }
    }
  } catch (e) { onError('plugins', e.message); }

  // 3. Proyectos. De ~/.claude.json solo se usan las CLAVES de projects (rutas).
  try {
    const raw      = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    const projects = Object.keys(JSON.parse(raw).projects || {});
    for (const proj of projects) {
      const dir = path.join(proj, '.claude', 'skills');
      if (!fs.existsSync(dir)) continue;    // repos borrados o movidos
      collect(dir, 'project', path.basename(proj) || proj, '', seen, skills);
    }
  } catch (e) { onError('projects', e.message); }

  return skills;
}

module.exports = { scanSkills, parseFrontmatter };
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
node --test test/
```

Esperado: `# pass 12` / `# fail 0`.

- [ ] **Step 5: Verificar contra el sistema real**

```bash
node -e "const {scanSkills}=require('./skills-scan');const s=scanSkills();console.log('TOTAL:',s.length);const g={};s.forEach(x=>{const k=x.source==='personal'?'(personales)':x.group;g[k]=(g[k]||0)+1});Object.entries(g).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(' ',v,k));console.log('sin parsear:',s.filter(x=>!x.parsed).length)"
```

Esperado: `TOTAL: 78`, `sin parsear: 0`, y el desglose `azure 28`, `vercel 28`, `superpowers 14`, `(personales) 2`, `supabase 2`, y cuatro plugins con 1. Las skills personales deben salir **una sola vez**.

- [ ] **Step 6: Commit**

```bash
git add skills-scan.js test/skills-scan.test.js
git commit -m "feat: modulo de escaneo de skills instaladas

Recorre skills personales, de plugins y de proyecto; deduplica por ruta
real y aisla errores por fuente. Tests con node:test, sin dependencias.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Ventana del catálogo, cableada de punta a punta

Al terminar esta tarea el botón del widget abre una ventana glass que muestra el conteo real de skills. La UI rica viene en la Task 3; aquí lo que se valida es el cableado y que la ventana se comporte bien.

**Files:**
- Create: `skills-preload.js`
- Create: `skills.html` (versión mínima; se completa en Task 3)
- Modify: `main.js` (require al inicio, bloque de ventana, handlers IPC)
- Modify: `preload.js` (una línea)
- Modify: `index.html` (botón en `#pf` + CSS + listener)
- Modify: `package.json` (`build.files`)

**Interfaces:**
- Consumes: `scanSkills(opts)` de Task 1.
- Produces:
  - IPC `open-skills` (send) — abre o enfoca la ventana.
  - IPC `close-skills` (send) — cierra la ventana.
  - IPC `scan-skills` (invoke) → `{ skills: Skill[], error?: string }`.
  - `window.skills.scan()` y `window.skills.close()` en el renderer de `skills.html`.
  - `window.claude.openSkills()` en el renderer del widget.

- [ ] **Step 1: Crear `skills-preload.js`**

```js
// Puente IPC de la ventana del catalogo. Expone solo lo que esa ventana necesita:
// nada de quit, togglePin ni fetchData.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skills', {
  scan:  () => ipcRenderer.invoke('scan-skills'),
  close: () => ipcRenderer.send('close-skills'),
});
```

- [ ] **Step 2: Crear `skills.html` mínimo**

```html
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"/>
<title>Skills instaladas</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  height: 100vh; background: transparent; overflow: hidden;
  font-family: 'Segoe UI', system-ui, sans-serif; color: #ebebeb;
}
#wrap {
  height: 100vh; border-radius: 14px;
  background: rgba(14,14,20,.94); border: 1px solid rgba(255,255,255,.10);
  display: flex; flex-direction: column;
}
#hdr {
  padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.06);
  display: flex; align-items: center; gap: 8px;
  -webkit-app-region: drag;
}
#hdr-title { font-size: 13px; font-weight: 700; flex: 1; }
#hdr-close {
  -webkit-app-region: no-drag; cursor: pointer; color: #f87171;
  padding: 4px 6px; border-radius: 5px; line-height: 1;
}
#body { flex: 1; padding: 16px; font-size: 13px; }
</style>
</head>
<body>
<div id="wrap">
  <div id="hdr">
    <span id="hdr-title">Skills instaladas</span>
    <span id="hdr-close">✕</span>
  </div>
  <div id="body">Cargando…</div>
</div>
<script>
document.getElementById('hdr-close').addEventListener('click', () => window.skills.close());

(async () => {
  const res = await window.skills.scan();
  document.getElementById('body').textContent =
    res.error ? ('Error: ' + res.error) : (res.skills.length + ' skills encontradas');
})();
</script>
</body>
</html>
```

- [ ] **Step 3: Cablear `main.js`**

Agregar el require junto a los otros, después de la línea `const fs = require('fs');` (`main.js:4`):

```js
const { scanSkills } = require('./skills-scan');
```

Agregar las constantes junto a `WIDGET_W` (`main.js:36`):

```js
const SKILLS_W = 720;
const SKILLS_H = 560;
```

Agregar `skillsWin` junto a `let tray = null;` (`main.js:39`):

```js
let skillsWin = null;
```

Agregar el bloque completo justo antes de la sección `// ── Tray ──` (`main.js:408`):

```js
// ── Ventana del catalogo de skills ────────────────────────────────────────────
// A diferencia del widget: redimensionable, sin always-on-top y visible en la
// barra de tareas. Es una ventana para leer, no un overlay.

function openSkillsWindow() {
  if (skillsWin && !skillsWin.isDestroyed()) {
    if (skillsWin.isMinimized()) skillsWin.restore();
    skillsWin.focus();
    return;
  }

  skillsWin = new BrowserWindow({
    icon:            path.join(__dirname, 'icon.ico'),
    width:           SKILLS_W,
    height:          SKILLS_H,
    minWidth:        480,
    minHeight:       360,
    title:           'Skills instaladas',
    frame:           false,
    transparent:     true,
    resizable:       true,
    hasShadow:       false,
    backgroundColor: '#00000000',
    show:            false,
    webPreferences: {
      preload:              path.join(__dirname, 'skills-preload.js'),
      nodeIntegration:      false,
      contextIsolation:     true,
      backgroundThrottling: false,
    },
  });

  skillsWin.once('ready-to-show', () => skillsWin.show());
  skillsWin.webContents.on('did-fail-load', (e, code, desc) => {
    logError('Skills load failed', `${code} ${desc}`);
  });
  skillsWin.loadFile('skills.html');
  skillsWin.on('closed', () => { skillsWin = null; });
}

ipcMain.on('open-skills',  openSkillsWindow);
ipcMain.on('close-skills', () => {
  if (skillsWin && !skillsWin.isDestroyed()) skillsWin.close();
});

ipcMain.handle('scan-skills', () => {
  try {
    return { skills: scanSkills({ onError: (src, msg) => logError(`scan-skills:${src}`, msg) }) };
  } catch (e) {
    logError('scan-skills', e.message);
    return { skills: [], error: e.message };
  }
});
```

- [ ] **Step 4: Cablear `preload.js`**

Agregar una línea al objeto expuesto, después de `quit:` (`preload.js:12`):

```js
  openSkills:    ()          => ipcRenderer.send('open-skills'),
```

- [ ] **Step 5: Agregar el botón en `index.html`**

Reemplazar el footer completo (`index.html:371-374`):

```html
  <!-- Footer -->
  <div id="pf">
    <span id="pf-s">–</span>
    <span id="pf-a">
      <svg id="pf-sk" viewBox="0 0 16 16">
        <title>Catálogo de skills</title>
        <rect x="2" y="3"    width="12" height="2.1" rx="1.05" fill="currentColor"/>
        <rect x="2" y="6.95" width="12" height="2.1" rx="1.05" fill="currentColor"/>
        <rect x="2" y="10.9" width="8"  height="2.1" rx="1.05" fill="currentColor"/>
      </svg>
      <span id="pf-r">⟳</span>
    </span>
  </div>
```

Agregar el CSS después de la regla `#pf-r:hover` (`index.html:196`):

```css
#pf-a { display: flex; align-items: center; gap: 3px; }
#pf-sk { width: 13px; height: 13px; cursor: pointer; color: var(--blue);
         padding: 2px; border-radius: 4px; transition: background .15s; }
#pf-sk:hover { background: rgba(77,157,224,.12); }
```

Agregar el listener junto al de `pf-r` (`index.html:911`):

```js
document.getElementById('pf-sk').addEventListener('click', () => window.claude.openSkills());
```

- [ ] **Step 6: Incluir los archivos nuevos en el build**

En `package.json`, el array `build.files` lista qué entra al ejecutable portable. Sin esto el build sale roto aunque en desarrollo funcione. Reemplazar el array:

```json
    "files": [
      "main.js",
      "preload.js",
      "index.html",
      "skills-scan.js",
      "skills-preload.js",
      "skills.html",
      "icon.ico"
    ],
```

- [ ] **Step 7: Ejercitar el widget de verdad**

El widget debe arrancar desde cero: `Ctrl+Alt+R` solo recrea la ventana en el MISMO proceso y cargaría código viejo.

```bash
powershell -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

Esperar ~2 s, confirmar que no quedan procesos, y arrancar:

```bash
npm start
```

Verificar en pantalla:
1. Clic en la barra del widget → se expande el panel.
2. El ícono de lista aparece en el footer, a la izquierda del `⟳`.
3. Clic en el ícono → abre la ventana con **"78 skills encontradas"**.
4. Clic en el ícono otra vez → **enfoca** la ventana existente, no abre una segunda.
5. El header de la ventana la arrastra; se puede redimensionar desde los bordes.
6. `✕` cierra la ventana **y el widget sigue vivo y funcional**.

- [ ] **Step 8: Commit**

```bash
git add main.js preload.js index.html package.json skills-preload.js skills.html
git commit -m "feat: ventana del catalogo de skills cableada de punta a punta

Boton en el footer del panel, ventana frameless glass redimensionable,
IPC open/close/scan y preload propio con superficie minima.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: UI del catálogo — grupos, buscador y estados

**Files:**
- Modify: `skills.html` (reemplazo completo del archivo creado en Task 2)

**Interfaces:**
- Consumes: `window.skills.scan()` → `{ skills: Skill[], error?: string }` y `window.skills.close()` de Task 2; el tipo `Skill` de Task 1.
- Produces: nada que consuman tareas posteriores.

- [ ] **Step 1: Reemplazar `skills.html` completo**

```html
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"/>
<title>Skills instaladas</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --gbg:   rgba(14, 14, 20, 0.94);
  --gbord: rgba(255,255,255,.10);
  --text:  #ebebeb;
  --sub:   #8a8a96;
  --muted: #44444c;
  --blue:  #4d9de0;
  --sep:   rgba(255,255,255,.06);
  --hov:   rgba(255,255,255,.05);
  --field: rgba(255,255,255,.06);
  --r:     14px;
}

[data-theme="light"] {
  --gbg:   rgba(250, 250, 255, 0.96);
  --gbord: rgba(0,0,0,.09);
  --text:  #16161e;
  --sub:   #6b6b7e;
  --muted: #6e6e80;
  --sep:   rgba(0,0,0,.07);
  --hov:   rgba(0,0,0,.04);
  --field: rgba(0,0,0,.05);
}

html, body {
  height: 100vh; overflow: hidden; background: transparent;
  font-family: 'Segoe UI', system-ui, sans-serif;
  color: var(--text); user-select: none; -webkit-font-smoothing: antialiased;
}

#wrap {
  height: 100vh; border-radius: var(--r);
  background: var(--gbg); border: 1px solid var(--gbord);
  display: flex; flex-direction: column; overflow: hidden;
}

/* ── Header ─────────────────────────────────────── */
#hdr {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 12px 10px 14px; border-bottom: 1px solid var(--sep);
  flex-shrink: 0; -webkit-app-region: drag;
}
#hdr-title {
  font-size: 12.5px; font-weight: 700; letter-spacing: .06em;
  background: linear-gradient(90deg, #818cf8, #38bdf8);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
#hdr-count { font-size: 10.5px; color: var(--muted); flex: 1; }
#hdr-refresh, #hdr-close {
  -webkit-app-region: no-drag; cursor: pointer;
  padding: 3px 6px; border-radius: 5px; line-height: 1;
  transition: background .15s, color .15s;
}
#hdr-refresh { color: var(--blue); font-size: 14px; }
#hdr-refresh:hover { background: rgba(77,157,224,.12); }
#hdr-refresh.spin { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#hdr-close { color: #f87171; font-size: 11px; }
#hdr-close:hover { color: #ef4444; background: rgba(239,68,68,.12); }

/* ── Buscador ───────────────────────────────────── */
#search-row { padding: 10px 14px; border-bottom: 1px solid var(--sep); flex-shrink: 0; }
#q {
  width: 100%; padding: 7px 10px; font-size: 12px;
  font-family: inherit; color: var(--text);
  background: var(--field); border: 1px solid transparent; border-radius: 7px;
  outline: none; user-select: text;
}
#q::placeholder { color: var(--muted); }
#q:focus { border-color: rgba(77,157,224,.45); }

/* ── Lista ──────────────────────────────────────── */
#list { flex: 1; overflow-y: auto; padding: 6px 0 10px; }
#list::-webkit-scrollbar { width: 8px; }
#list::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,.12); border-radius: 4px;
}
[data-theme="light"] #list::-webkit-scrollbar-thumb { background: rgba(0,0,0,.16); }

.sec-h, .grp-h {
  display: flex; align-items: center; gap: 6px;
  cursor: pointer; transition: background .12s;
}
.sec-h { padding: 8px 14px 6px; }
.sec-h:hover, .grp-h:hover { background: var(--hov); }
.sec-t { font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.sec-n { font-size: 10px; color: var(--muted); flex: 1; }
.sec-p { font-size: 9.5px; color: var(--muted); }

.grp-h { padding: 5px 14px 5px 24px; }
.grp-t { font-size: 11px; font-weight: 600; color: var(--sub); }
.grp-v {
  font-size: 9px; color: var(--muted); padding: 1px 5px;
  border: 1px solid var(--sep); border-radius: 4px;
}
.grp-n { font-size: 10px; color: var(--muted); flex: 1; text-align: right; }

.caret {
  font-size: 8px; color: var(--muted); width: 8px;
  transition: transform .15s; flex-shrink: 0;
}
.closed > .caret { transform: rotate(-90deg); }

.sk { padding: 5px 14px 6px 34px; }
.sk:hover { background: var(--hov); }
.sk-n { font-size: 11.5px; font-weight: 600; }
.sk-d {
  font-size: 10.5px; color: var(--sub); line-height: 1.35; margin-top: 1px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.sk-warn { font-size: 10px; color: #f59e0b; margin-top: 1px; }
.hidden { display: none; }

#msg {
  padding: 40px 24px; text-align: center;
  font-size: 12px; color: var(--muted); line-height: 1.5;
}
</style>
</head>
<body>
<div id="wrap">

  <div id="hdr">
    <span id="hdr-title">Skills instaladas</span>
    <span id="hdr-count">–</span>
    <span id="hdr-refresh" title="Volver a escanear">⟳</span>
    <span id="hdr-close" title="Cerrar">✕</span>
  </div>

  <div id="search-row">
    <input id="q" type="text" placeholder="Buscar skill por nombre o descripción…" autocomplete="off"/>
  </div>

  <div id="list"><div id="msg">Escaneando…</div></div>

</div>

<script>
// El widget guarda el tema en localStorage; ambas ventanas comparten el origen
// file://, asi que el catalogo abre con el mismo tema. Si no hay valor, oscuro.
document.documentElement.setAttribute(
  'data-theme', localStorage.getItem('theme') === 'light' ? 'light' : 'dark');

let ALL      = [];
let query    = '';
const closed = new Set();   // claves de secciones/grupos colapsados

const listEl  = document.getElementById('list');
const countEl = document.getElementById('hdr-count');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function matches(s) {
  if (!query) return true;
  const t = query.toLowerCase();
  return s.name.toLowerCase().includes(t) || s.description.toLowerCase().includes(t);
}

function skillRow(s) {
  const desc = s.parsed
    ? `<div class="sk-d">${esc(s.description)}</div>`
    : '<div class="sk-warn">sin frontmatter legible</div>';
  return `<div class="sk"><div class="sk-n">${esc(s.name)}</div>${desc}</div>`;
}

// Al buscar, todo se muestra abierto: colapsar escondería coincidencias.
function isClosed(key) { return !query && closed.has(key); }

function section(key, title, count, note, inner) {
  const cls = isClosed(key) ? ' closed' : '';
  return `<div class="sec">
    <div class="sec-h${cls}" data-key="${esc(key)}">
      <span class="caret">▼</span>
      <span class="sec-t">${esc(title)}</span>
      <span class="sec-n">(${count})</span>
      <span class="sec-p">${esc(note)}</span>
    </div>
    <div class="sec-b${isClosed(key) ? ' hidden' : ''}">${inner}</div>
  </div>`;
}

function group(key, title, version, skills) {
  const cls = isClosed(key) ? ' closed' : '';
  const ver = version ? `<span class="grp-v">v${esc(version)}</span>` : '';
  return `<div class="grp">
    <div class="grp-h${cls}" data-key="${esc(key)}">
      <span class="caret">▼</span>
      <span class="grp-t">${esc(title)}</span>${ver}
      <span class="grp-n">(${skills.length})</span>
    </div>
    <div class="grp-b${isClosed(key) ? ' hidden' : ''}">${skills.map(skillRow).join('')}</div>
  </div>`;
}

function byName(a, b) { return a.name.localeCompare(b.name); }

function groupBy(skills) {
  const map = new Map();
  for (const s of skills) {
    if (!map.has(s.group)) map.set(s.group, []);
    map.get(s.group).push(s);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function render() {
  const shown = ALL.filter(matches);

  countEl.textContent = query
    ? `${shown.length} de ${ALL.length}`
    : `${ALL.length} skill${ALL.length === 1 ? '' : 's'}`;

  if (!ALL.length) {
    listEl.innerHTML = '<div id="msg">No se encontraron skills instaladas.<br/>' +
      'Se buscó en ~/.claude/skills, los plugins instalados y los proyectos registrados.</div>';
    return;
  }
  if (!shown.length) {
    listEl.innerHTML = `<div id="msg">Sin coincidencias para «${esc(query)}».</div>`;
    return;
  }

  const personal = shown.filter((s) => s.source === 'personal').sort(byName);
  const plugins  = groupBy(shown.filter((s) => s.source === 'plugin'));
  const projects = groupBy(shown.filter((s) => s.source === 'project'));

  let html = '';

  if (personal.length) {
    html += section('sec:personal', 'Personales', personal.length,
                    '~/.claude/skills', personal.map(skillRow).join(''));
  }

  if (plugins.length) {
    const total = plugins.reduce((n, [, arr]) => n + arr.length, 0);
    const inner = plugins.map(([name, arr]) =>
      group('plg:' + name, name, arr[0].version, arr.slice().sort(byName))).join('');
    html += section('sec:plugins', 'Plugins', total, '', inner);
  }

  if (projects.length) {
    const total = projects.reduce((n, [, arr]) => n + arr.length, 0);
    const inner = projects.map(([name, arr]) =>
      group('prj:' + name, name, '', arr.slice().sort(byName))).join('');
    html += section('sec:projects', 'Proyectos', total, '', inner);
  }

  listEl.innerHTML = html;
}

// Colapsar / expandir por delegacion: el HTML se regenera en cada render.
listEl.addEventListener('click', (e) => {
  const head = e.target.closest('.sec-h, .grp-h');
  if (!head || query) return;          // durante una busqueda no se colapsa
  const key = head.dataset.key;
  if (closed.has(key)) closed.delete(key); else closed.add(key);
  render();
});

document.getElementById('q').addEventListener('input', (e) => {
  query = e.target.value.trim();
  render();
});

document.getElementById('hdr-close').addEventListener('click', () => window.skills.close());

async function load() {
  const btn = document.getElementById('hdr-refresh');
  btn.classList.add('spin');
  try {
    const res = await window.skills.scan();
    if (res.error) {
      listEl.innerHTML = `<div id="msg">No se pudo escanear.<br/>${esc(res.error)}</div>`;
      countEl.textContent = '–';
      return;
    }
    ALL = res.skills;
    render();
  } catch (e) {
    listEl.innerHTML = `<div id="msg">No se pudo escanear.<br/>${esc(e.message)}</div>`;
  } finally {
    btn.classList.remove('spin');
  }
}

document.getElementById('hdr-refresh').addEventListener('click', load);
load();
</script>
</body>
</html>
```

- [ ] **Step 2: Ejercitar la UI**

Reiniciar el proceso completo (el renderer cachea el HTML):

```bash
powershell -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

Esperar ~2 s y:

```bash
npm start
```

Abrir el catálogo desde el widget y verificar:
1. Header muestra **"78 skills"**.
2. Sección **Personales (2)**: `paridad-ambientes` y `requirements-doc`, cada una **una sola vez**.
3. Sección **Plugins (76)** con subgrupos: `azure v1.1.75 (28)`, `vercel v0.44.0 (28)`, `superpowers v6.1.1 (14)`, `supabase v0.1.12 (2)`.
4. `frontend-design` y `skill-creator` aparecen **sin badge de versión** (reportan "unknown").
5. Sección **Proyectos** no aparece (0 skills de proyecto hoy) — es lo esperado.
6. Clic en un encabezado colapsa y expande; el caret rota.
7. Escribir `git` en el buscador filtra, el contador pasa a `N de 78`, y los grupos se muestran expandidos.
8. Borrar la búsqueda restaura el estado de colapso previo.
9. Buscar `zzzz` muestra "Sin coincidencias para «zzzz»".
10. El botón ⟳ del header re-escanea y mantiene el conteo.

- [ ] **Step 3: Commit**

```bash
git add skills.html
git commit -m "feat: UI del catalogo con grupos colapsables y buscador

Agrupa por origen (personales / plugins / proyectos), filtra por nombre
y descripcion, y cubre los estados vacio, sin coincidencias y de error.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Verificación final y checkpoint

Cierra los 6 puntos de verificación del spec, incluido el que ya costó varias rondas en este proyecto.

**Files:**
- Modify: ninguno (salvo que la verificación encuentre defectos).

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: tag de checkpoint `catalogo-skills-v1`.

- [ ] **Step 1: Verificar la ventana DESENFOCADA (bug de barra blanca)**

En este proyecto, las regiones transparentes de una ventana frameless se pintan **blancas** cuando la ventana pierde el foco — bug de compositing DWM. Ya está mitigado por `app.disableHardwareAcceleration()` (`main.js:19`), que aplica a todas las ventanas del proceso, pero hay que confirmarlo.

Crítico: **una captura con la ventana enfocada se ve falsamente limpia.** Hay que quitarle el foco primero.

Con el catálogo abierto, dar foco a otra app (por ejemplo Notepad) y observar los bordes redondeados y el borde superior de la ventana del catálogo. No debe aparecer ninguna barra ni halo blanco.

Si aparece: cambiar en `main.js` la creación de `skillsWin` a `transparent: false` y `backgroundColor: '#0e0e14'`. La ventana pierde la translucidez pero conserva el resto del estilo. Anotarlo en el spec si se toma esa salida.

- [ ] **Step 2: Verificar que el widget sobrevive**

1. Con el catálogo abierto, cerrarlo con `✕`. El widget sigue visible y responde al clic.
2. Reabrir el catálogo desde el botón. Abre bien.
3. Cerrar el catálogo y colapsar/expandir el widget varias veces. Sin cambios de comportamiento.
4. Con el catálogo abierto, arrastrar el widget. Se mueve normal.
5. Confirmar que el ícono del tray sigue respondiendo (doble clic recentra el widget).

- [ ] **Step 3: Correr la suite de tests una última vez**

```bash
node --test test/
```

Esperado: `# pass 12` / `# fail 0`.

- [ ] **Step 4: Revisar el log de errores**

```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path');const f=p.join(os.homedir(),'.claude','widget-error.log');try{const l=fs.readFileSync(f,'utf8').trim().split('\n');console.log(l.slice(-15).join('\n'))}catch{console.log('sin log')}"
```

Esperado: ninguna entrada nueva de `scan-skills`, `Skills load failed` ni `Renderer gone` con timestamp de esta sesión.

- [ ] **Step 5: Commit del checkpoint**

Si algún paso anterior obligó a corregir código, commitear esos arreglos primero. Luego:

```bash
git tag catalogo-skills-v1
git log --oneline -5
```

Esperado: los tres commits del feature sobre `254807c`, y el tag apuntando al último.

---

## Notas para quien implemente

- **Reiniciar de verdad.** `Ctrl+Alt+R` y la opción "Reiniciar widget" del tray **solo recrean la ventana en el mismo proceso**: cargan el código viejo. Para probar cambios hay que matar todos los procesos `electron` y relanzar. Verificar que quedaron en 0 antes de relanzar — si sobrevive uno, el handler `second-instance` reposiciona el widget en silencio y sobrescribe `~/.claude/widget-prefs.json`, y parece que "el cambio no funcionó".
- **No tocar** la lógica de bounds/drag/tray de `main.js`. El widget salió de varias rondas de depuración y está en un punto estable (`estable-2026-07-17`).
- Los conteos esperados (78 total, 28/28/14/2/2/1/1/1/1) son del sistema del usuario al 2026-07-20. Si el usuario instala o desinstala plugins entre tanto, los números cambian: lo que se valida es que **coincidan con lo que devuelve `node -e` sobre `scanSkills()` en ese momento**, no los números literales.

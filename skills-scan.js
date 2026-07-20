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

// Se lee el archivo completo a proposito. Leer solo una cabecera de tamano fijo
// parecia mas eficiente, pero varias skills reales (vercel/ai-sdk, vercel/workflow…)
// meten descripciones enormes DENTRO del frontmatter y el bloque llega a cerrar
// pasado el byte 16000: cualquier tope corto parte el bloque y el parseo falla.
// El corpus completo son ~766 KB en 78 archivos, asi que leerlo entero es
// irrelevante frente a introducir un limite que vuelva a quedarse corto.
function readFrontmatter(file) {
  try {
    return parseFrontmatter(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
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

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

// Varias skills reales (vercel/ai-sdk, vercel/workflow…) tienen descripciones
// enormes DENTRO del frontmatter: el bloque llega a cerrar pasado el byte 16000.
// Leer solo una cabecera corta partia el bloque y el parseo fallaba.
test('scanSkills parsea frontmatter de mas de 8 KB', () => {
  const home = tmpHome();
  const descripcion = 'x'.repeat(12000);
  writeSkill(path.join(home, '.claude', 'skills'), 'gigante', fm('gigante', descripcion));

  const out = scanSkills({ home });

  assert.strictEqual(out[0].parsed, true);
  assert.strictEqual(out[0].name, 'gigante');
  assert.strictEqual(out[0].description, descripcion);
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

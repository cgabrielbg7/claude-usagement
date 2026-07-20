# Catálogo de skills — diseño

**Fecha:** 2026-07-20
**Estado:** aprobado, pendiente de implementar
**Punto de partida:** commit `254807c` / tag `estable-2026-07-17`

## Problema

Las skills son clave para usar Claude Code, pero algunas se invocan manualmente y no hay forma
de ver de un vistazo cuáles están instaladas en el sistema. Hoy hay 78 repartidas entre skills
personales y nueve plugins; saber qué existe requiere navegar carpetas a mano.

## Alcance

Una ventana nueva en el widget que lista las skills instaladas. **Solo consulta**: no modifica
nada del sistema, no instala, no deshabilita, no borra.

Fuera de alcance (posibles features futuros, no ahora):

- Abrir la carpeta de una skill o ver el contenido de su `SKILL.md`.
- Habilitar, deshabilitar, actualizar o eliminar skills y plugins.
- Estadísticas de uso de skills.

## Fuentes de datos

Tres fuentes, todas leídas del sistema de archivos local:

| Fuente | Ruta | Hoy |
|---|---|---|
| Personales | `~/.claude/skills/<skill>/SKILL.md` | 2 |
| Plugins | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md` | 76 |
| Proyectos | `<ruta-proyecto>/.claude/skills/<skill>/SKILL.md` | 0 |

Las rutas de proyecto salen de las **claves** de `projects` en `~/.claude.json`. De ese archivo
se extraen únicamente las rutas; no se lee ni se expone ningún otro contenido.

### Hallazgos del escaneo de validación (2026-07-20)

Un prototipo del escaneo ejecutado contra el sistema real dio:

```
TOTAL: 78 skills, 0 fallos de parseo de frontmatter

28  azure 1.1.75          2  supabase 0.1.12
28  vercel 0.44.0         1  claude-code-setup      1  frontend-design
14  superpowers 6.1.1     1  claude-md-management   1  skill-creator
 2  personales
```

Tres consecuencias para el diseño:

1. **6 de 20 rutas de proyecto ya no existen** en disco. Se saltan en silencio.
2. **El único proyecto con `.claude/skills` es la carpeta de usuario**, cuyo
   `.claude/skills` *es* `~/.claude/skills`. Sin deduplicación, las 2 skills personales
   aparecerían dos veces. Se deduplica por ruta real resuelta.
3. **Varios plugins reportan versión `"unknown"`.** El badge de versión se oculta en esos casos
   en vez de mostrar la palabra "unknown".

Además, hay plugins instalados que no aportan skills (code-review, commit-commands, context7,
feature-dev, github, playwright, security-guidance): aportan comandos, agentes o MCP. No
aparecen en el catálogo.

## Arquitectura

`main.js` ya tiene ~500 líneas y varias responsabilidades (ventana, drag, tray, API, prefs). El
escaneo no se le agrega encima; va en un módulo propio.

**Archivos nuevos:**

- **`skills-scan.js`** — módulo del proceso main, sin dependencias externas. Expone
  `scanSkills()` que devuelve el array de skills. Módulo puro de Node: no importa Electron, así
  que se puede ejercitar directo desde la línea de comandos.
- **`skills.html`** — la UI de la ventana, reutilizando las variables CSS del widget.
- **`skills-preload.js`** — puente IPC mínimo de esa ventana: `scan()`, `close()`,
  `dragStart/dragMove/dragEnd`.

**Cambios acotados en archivos existentes:**

- `main.js` — crear/enfocar la ventana, handlers IPC `open-skills` y `scan-skills`.
- `index.html` — botón en el footer del panel expandido (`#pf`).
- `preload.js` — una línea: `openSkills`.

Preload separado a propósito: la ventana del catálogo no necesita `quit`, `togglePin` ni
`fetchData`, y no debe poder invocarlos.

### Formato de cada skill

```js
{
  name,          // del frontmatter; si falta, nombre de la carpeta
  description,   // del frontmatter; puede quedar vacía
  source,        // 'personal' | 'plugin' | 'project'
  group,         // '' | nombre del plugin | nombre del proyecto
  version,       // versión del plugin, o '' si es "unknown" o no aplica
  path,          // ruta absoluta de la carpeta de la skill
  parsed,        // false si el frontmatter no se pudo leer
}
```

### Parseo del frontmatter

Se leen solo los primeros **8 KB** de cada `SKILL.md` — el frontmatter siempre está al inicio, y
así no se cargan archivos largos completos. Se extrae el bloque entre `---`, y se parsea
`clave: valor` soportando continuación en líneas siguientes (las descripciones largas se
envuelven). Sin dependencias nuevas: este parser ya se validó contra las 78 skills reales con 0
fallos.

## La ventana

Frameless, glass, misma estética del widget. 720×560, redimensionable, mínimo 480×360.

A diferencia del widget: **no** always-on-top y **sí** visible en la barra de tareas — es una
ventana para leer, no un overlay. Header propio arrastrable con título, contador total, botón de
recargar y botón de cerrar.

Si la ventana ya está abierta, el botón la enfoca en vez de abrir una segunda.

### Layout

```
🔍 [ buscar skill...]                        78 skills

▾ Personales (2)                    ~/.claude/skills
   paridad-ambientes    Verifica la paridad de ambientes…
   requirements-doc     Redacta y exporta documentación…

▾ Plugins (76)
   ▾ superpowers  v6.1.1                        (14)
      brainstorming    You MUST use this before any…
      writing-plans    Use when you have a spec…
   ▾ azure  v1.1.75                             (28)

▾ Proyectos (0)
```

Secciones colapsables agrupadas por origen. El buscador filtra por nombre y descripción, y al
filtrar expande automáticamente los grupos con coincidencias. Las descripciones se truncan a dos
líneas.

La sección "Proyectos" hoy aparece vacía. Es correcto: se poblará en cuanto exista una skill en
el `.claude/skills` de algún repo.

## Flujo de datos

1. Clic en el botón del footer del panel expandido.
2. `preload.js` → IPC `open-skills`.
3. `main.js` crea la ventana, o enfoca la existente.
4. Al cargar, el renderer hace `invoke('scan-skills')`.
5. `skills-scan.js` recorre las tres fuentes y devuelve el array.
6. El renderer agrupa y pinta.

El botón ⟳ del header repite desde el paso 4, así que instalar un plugin no obliga a reiniciar
el widget.

## Manejo de errores

El principio: **ninguna fuente rota tumba el catálogo.**

- Cada fuente y cada skill van en su propio `try/catch`. Una carpeta sin permisos o un
  `SKILL.md` corrupto se saltan sin afectar al resto.
- Skill sin frontmatter válido: se muestra con el nombre de su carpeta, descripción vacía y
  marca visual (`parsed: false`). Mejor mostrarla imperfecta que ocultarla.
- Rutas de proyecto inexistentes: se saltan en silencio.
- Cero skills o error total: estado vacío explicativo, nunca una ventana en blanco.
- Todo error se registra con el `logError` que ya existe en `main.js`.

## Verificación

No hay infraestructura de tests en el proyecto y montarla para este feature sería
desproporcionado. `skills-scan.js` queda como módulo puro de Node, ejercitable directo con
`node -e` contra el sistema real.

Antes de dar el feature por terminado, correr el widget de verdad y confirmar:

1. La ventana abre desde el botón del panel y muestra **78 skills** con los conteos por plugin
   de arriba.
2. El buscador filtra y expande grupos con coincidencias.
3. Las skills personales aparecen **una sola vez** (deduplicación funcionando).
4. Los plugins con versión "unknown" no muestran badge de versión.
5. **La ventana desenfocada no muestra barras blancas** — el bug de compositing DWM en ventanas
   transparentes que ya costó varias rondas en el widget. Verificar con la ventana realmente
   desenfocada; una captura con la ventana enfocada se ve falsamente limpia.
6. Cerrar el catálogo deja el widget vivo y funcional. `window-all-closed` en `main.js:497` solo
   cierra la app si `isQuitting` es true, así que esto ya debería funcionar — se verifica porque
   es justo el tipo de cosa que se rompe sin avisar.

## Riesgos conocidos

- **Barra blanca en ventana transparente** (punto 5). Mitigado de entrada porque
  `app.disableHardwareAcceleration()` ya está activo en `main.js:19` y aplica a todas las
  ventanas del proceso. Se verifica igual.
- **Estructura de carpetas de plugins.** El layout
  `plugins/cache/<marketplace>/<plugin>/<version>/skills/` es un detalle interno de Claude Code
  que podría cambiar. Si cambia, la sección de plugins queda vacía pero el resto del catálogo
  sigue funcionando; el escaneo por fuente aísla el daño.

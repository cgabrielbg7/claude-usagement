# Catálogo de MCPs — diseño

Fecha: 2026-07-22
Estado: aprobado

## Problema

El widget ya tiene un catálogo de skills instaladas (ver
`2026-07-20-catalogo-skills-design.md`). Los servidores MCP son la otra mitad de
lo que un plugin puede aportar y hoy no hay forma de consultarlos sin abrir
archivos a mano.

Hallazgo que motivó el alcance: de los 17 plugins instalados, 8 aportan skills y
6 aportan MCPs. El catálogo actual, al escanear solo carpetas `skills/`, deja
fuera la mitad del cuadro.

## Alcance

Dentro:

- Listar los servidores MCP declarados en disco, agrupados por origen.
- Marcar cuáles están habilitados según la configuración.
- Reusar la ventana del catálogo mediante pestañas.

Fuera:

- Conectar a los servidores para verificar que responden o contar sus tools.
  Lanza procesos `npx`, tarda segundos y puede disparar flujos OAuth.
- Editar configuración. El catálogo es de solo consulta, igual que el de skills.

## Arquitectura

### `mcp-scan.js`

Módulo puro de Node, gemelo de `skills-scan.js`: sin `require('electron')`, con
`{ home, onError }` inyectables para ejercitarlo desde CLI y desde tests.
Exporta `scanMcps()`.

Tres fuentes, cada una en su propio try/catch. Una fuente rota deja las demás
intactas y se reporta por `onError`.

| Fuente    | Dónde busca                                                        |
| --------- | ------------------------------------------------------------------ |
| `plugin`  | `plugin.json.mcpServers`: string → ruta relativa a la raíz del plugin; objeto → inline. Sin la clave, fallback a `<raíz>/.mcp.json` |
| `user`    | `~/.claude.json` → `mcpServers`                                     |
| `project` | por cada ruta en `projects`: su `.mcp.json`, más `projects[ruta].mcpServers` |

La ruta del `plugin.json` puede apuntar a un subdirectorio arbitrario: el plugin
`supabase` usa `./agents/claude/.mcp.json`. No se puede asumir la raíz.

### Normalización de las dos formas de archivo

Un `.mcp.json` aparece de dos maneras en el mismo marketplace oficial:

```jsonc
{ "github": { … } }                    // mapa pelado
{ "mcpServers": { "vercel": { … } } }  // envuelto
```

Regla única: si el JSON tiene una clave `mcpServers` cuyo valor es un objeto, ese
es el mapa; si no, el objeto entero es el mapa. Cubre ambos casos sin ramas
especiales.

### Registro devuelto

```js
{ name, source, group, version, transport, detail, enabled, note, path, parsed }
```

- `transport`: el `type` explícito si viene; si no, `stdio` cuando hay `command`,
  `http` cuando hay `url`.
- `detail`: para stdio, `command` más `args`; para http/sse, la URL **sin query
  string** — una URL de MCP puede llevar el token ahí.
- `enabled`: para plugins, `settings.json.enabledPlugins["<plugin>@<marketplace>"]
  === true`. Para user/project, se cruza con `disabledMcpjsonServers` y
  `enabledMcpjsonServers`.
- `parsed: false` cuando el JSON está corrupto. La fila se muestra con aviso, tal
  como el catálogo de skills muestra `sin frontmatter legible`.

### Secretos

El registro **nunca** incluye valores de `headers` ni de `env`. Solo los nombres
de las claves (`env: AZURE_TENANT_ID, PATH`), que informan sin filtrar nada.

Es la diferencia importante con el escáner de skills, donde todo lo leído era
público. Los `.mcp.json` de plugin usan placeholders (`${GITHUB_PERSONAL_ACCESS_TOKEN}`),
pero un `.mcp.json` de usuario o de proyecto puede traer un token literal.

## UI

### Pestañas

El header pasa de `Skills instaladas · conteo · ⟳ · ✕` a
`[ Skills ] [ MCPs ] · conteo · ⟳ · ✕`.

Las pestañas viven dentro de la zona `-webkit-app-region: drag` del header, así
que necesitan `-webkit-app-region: no-drag` propio o no se podrán clicar.

### Estado por pestaña

Las tres globales sueltas (`ALL`, `query`, `closed`) pasan a un objeto por
pestaña con su propio `data`, `query`, `closed`, `scan` y renderer de fila.

`data: null` significa "no escaneado aún": la pestaña de MCPs escanea la primera
vez que se abre, no al arrancar la ventana. Cada pestaña recuerda su búsqueda y
sus grupos colapsados. El botón `⟳` recarga solo la pestaña activa.

Se reusa sin cambios: `section()`, `group()`, `groupBy()`, el caret, el buscador,
`esc()`, el tema desde `localStorage` y la regla de "durante una búsqueda no se
colapsa". Lo único que cambia por pestaña es el renderer de fila y `matches()`
— los MCPs no tienen descripción, así que se busca por nombre y por `detail`.

### Fila de MCP

```
  azure                      stdio  ● activo
  npx -y @azure/mcp@latest server start

  github                      http  ● activo
  https://api.githubcopilot.com/mcp/   env: GITHUB_PERSONAL_ACCESS_TOKEN
```

## Renombrado

Con dos pestañas, `skills.html` / `skills-preload.js` / `window.skills` pasan a
ser nombres equivocados. Se renombran a `catalog.html` / `catalog-preload.js` /
`window.catalog`.

Los canales IPC (`open-skills`, `close-skills`) se dejan quietos: no se ven desde
fuera y renombrarlos toca el widget sin ganar nada.

## Cableado

- `main.js`: `ipcMain.handle('scan-mcps', …)` calcado del de skills, con su
  `logError`. Y `loadFile('catalog.html')`.
- `catalog-preload.js`: añade `scanMcps` al puente.
- `package.json` → `build.files`: añadir `mcp-scan.js` y los archivos renombrados.
  Si se olvida, `npm start` funciona y el `.exe` portable sale roto. Es el fallo
  silencioso más probable de este cambio.
- `index.html`: el tooltip del botón pasa de "Catálogo de skills" a "Catálogo".

## Pruebas

`test/mcp-scan.test.js`, mismo estilo que `test/skills-scan.test.js`
(`node:test`, `tmpHome()` con fixtures, corre con `npm test`):

- las dos formas de archivo (mapa pelado / envuelto)
- `plugin.json` con ruta string, con objeto inline, y sin la clave
- ruta que apunta a un subdirectorio, como hace `supabase`
- plugin deshabilitado en `settings.json` → `enabled: false`
- JSON corrupto → `parsed: false`, las demás fuentes intactas
- que `headers` y `env` nunca aparezcan con sus valores en la salida
- `transport` inferido y URL con query string recortada

Verificación final: `npm test` más abrir la ventana y comparar contra los 6 MCPs
conocidos del sistema (azure, context7, github, playwright, supabase, vercel).

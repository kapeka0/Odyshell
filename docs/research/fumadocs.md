# Fumadocs para la documentación de Odyshell

Fecha de verificación: 2026-07-30.

## Veredicto

Fumadocs encaja bien dentro de `apps/web`: permite conservar Next.js App Router, la
ruta pública `/docs` y el despliegue actual de Vercel. Para el MVP usaría Fumadocs
MDX como fuente local, Fumadocs UI con el preset de shadcn, búsqueda ZBSearch
autohospedada y salidas estáticas para agentes.

No añadiría todavía `Ask AI`: requiere escoger y pagar un proveedor de modelos, y
Fumadocs no incluye el modelo. Tampoco migraría a Fumapress: aunque automatiza
`llms.txt` y MCP, impone su propio framework basado en Waku, mientras Odyshell ya
tiene una aplicación Next.js. La [guía oficial de inicio][quick-start] distingue
estas opciones.

## Versiones y compatibilidad verificadas

El registro oficial de npm, consultado con `pnpm view <paquete> version`, devolvió:

| Paquete | Versión |
| --- | --- |
| `fumadocs-core` | `16.14.0` |
| `fumadocs-ui` | `16.14.0` |
| `fumadocs-mdx` | `15.2.1` |
| `@fumadocs/cli` | `1.4.1` |
| `create-fumadocs-app` | `16.1.10` |

La instalación manual actual exige Next.js 16 y Tailwind CSS 4, justo las versiones
base de `apps/web`. La instalación automática exige Node.js 22; CI usa Node.js 24.
Fuentes: [instalación manual para Next.js][manual-next] y
[inicio rápido][quick-start].

Dependencias propuestas:

```bash
pnpm --filter @odyshell/web add \
  fumadocs-core@16.14.0 \
  fumadocs-ui@16.14.0 \
  fumadocs-mdx@15.2.1 \
  @types/mdx
```

## Arquitectura recomendada

```text
apps/web/
├─ content/docs/
│  ├─ index.mdx
│  ├─ getting-started/
│  ├─ concepts/
│  ├─ agents/
│  ├─ machines/
│  └─ reference/
├─ source.config.ts
├─ .source/                     # generada por dev/build, no se edita
└─ src/
   ├─ lib/source.ts
   ├─ lib/get-llm-text.ts
   └─ app/
      ├─ docs/
      │  ├─ layout.tsx
      │  └─ [[...slug]]/page.tsx
      ├─ api/search/route.ts
      ├─ llms.txt/route.ts
      ├─ llms-full.txt/route.ts
      └─ llms.mdx/docs/[[...slug]]/route.ts
```

### MDX y colección

`source.config.ts` debe declarar `defineDocs({ dir: "content/docs" })`. Para las
salidas LLM debe activar
`docs.postprocess.includeProcessedMarkdown: true`. Fumadocs valida el frontmatter
en build y puede extender su esquema con Zod 4. La fuente oficial explica las
[colecciones, el esquema y el postprocesado][collections].

`next.config.ts` se envuelve con `createMDX()` y `tsconfig.json` añade
`"collections/*": ["./.source/*"]`. La carpeta `.source` se genera con
`next dev` o `next build`; no es contenido fuente. Fumadocs MDX es ESM-only y la
documentación recomienda configuración ESM; el `next.config.ts` existente puede
mantenerse si la resolución TypeScript nativa de Node funciona en CI, o renombrarse
a `next.config.mts` si aparecieran problemas. Véase la
[integración oficial de Fumadocs MDX con Next.js][mdx-next].

Cada página puede ser `.md` o `.mdx` con `title` y `description` en frontmatter.
Los `meta.json` ordenan páginas, añaden separadores y configuran carpetas. Los slugs
se derivan de la ruta (`index.mdx` representa la carpeta) y la lista `pages` de
`meta.json` excluye lo no listado salvo que se use `...`. Fuente:
[convenciones de slugs y árbol de páginas][page-conventions].

### Navegación y render

`lib/source.ts` crea un `loader()` con `baseUrl: "/docs"`. El layout pasa
`source.getPageTree()` a `DocsLayout`; el catch-all obtiene la página por slug,
renderiza `DocsPage`, título, descripción, TOC y el cuerpo MDX, y devuelve 404 si
no existe. `generateStaticParams()` puede usar `source.generateParams()` para
prerrenderizar las rutas conocidas. Fuentes:
[Loader API][loader], [Docs Layout][docs-layout] y [Docs Page][docs-page].

La aplicación ya tiene `ThemeProvider`. Para evitar dos gestores de tema,
`RootProvider` de Fumadocs debe reutilizar el árbol actual con su integración de
tema desactivada, conservando su contexto de búsqueda. En CSS se debe usar
`fumadocs-ui/css/shadcn.css` más `fumadocs-ui/css/preset.css`, no el tema neutral
independiente: Fumadocs declara soporte exclusivo para Tailwind v4 y ofrece el
preset shadcn para adoptar sus colores. Sus estilos también cambian preflight,
por lo que la migración necesita una revisión visual de landing, auth y dashboard.
Fuente: [temas de Fumadocs UI][themes].

### Búsqueda

Para el MVP usaría ZBSearch, la opción predeterminada, gratuita y autohospedable:

```ts
import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

export const { GET } = createFromSource(source, { language: "english" });
```

Esto crea `/api/search` desde el `structuredData` que ya produce Fumadocs MDX.
Evitaría el modo estático al principio: obliga al navegador a descargar el índice
y la propia documentación advierte que resulta caro cuando crece. Si el corpus
llega a ser grande, se puede sustituir el motor por un servicio externo sin
cambiar la estructura MDX. Fuente: [búsqueda Fumadocs][search].

### Documentación para agentes

Esta parte sí debe entrar en el primer MVP:

1. `getLLMText(page)` obtiene `page.data.getText("processed")`.
2. `/llms.txt` devuelve `llms(source).index()`: un índice compacto del árbol.
3. `/llms-full.txt` concatena el Markdown procesado de todas las páginas.
4. `/docs/<ruta>.md` reescribe a una ruta interna que responde
   `Content-Type: text/markdown`.

Las tres salidas pueden usar `revalidate = false`, por lo que se regeneran con
cada despliegue y no necesitan base de datos ni credenciales. La documentación
oficial ofrece exactamente estas recetas y también negociación por cabecera
`Accept`: [AI & LLMs][ai-llms].

Pospondría la negociación por `Accept`. Odyshell ya tiene `proxy.ts` con Clerk;
reemplazarlo por el ejemplo aislado de Fumadocs podría alterar autenticación. La
primera entrega puede ofrecer `.md`, `llms.txt` y `llms-full.txt` sin tocar ese
límite de confianza. Más adelante se compondrá la negociación dentro del proxy
existente, se añadirá `Vary: Accept` y se probará que las rutas privadas siguen
cerradas.

Las salidas LLM deben construirse exclusivamente desde `content/docs`, nunca
desde datos del dashboard, eventos, tokens o documentos internos. El árbol de
páginas llega al cliente y la propia API avisa de no guardar allí datos sensibles
o grandes: [Page Tree][page-tree].

## Migración de la ruta `/docs`

La migración no necesita redirecciones:

1. Convertir el contenido actual de `src/app/docs/page.tsx` en
   `content/docs/index.mdx`.
2. Sustituir esa página única por `src/app/docs/[[...slug]]/page.tsx` y el layout
   Fumadocs.
3. Conservar `baseUrl: "/docs"` para no romper enlaces ni SEO.
4. Mantener el enlace `Docs` de la landing.
5. Añadir inicialmente estas secciones:
   - Overview
   - Quickstart
   - Machines
   - Agents
   - CLI
   - MCP
   - Security
   - Self-hosting
6. Añadir búsqueda, `llms.txt`, `llms-full.txt` y Markdown por página.
7. Verificar URLs antiguas, metadatos, light/dark, móvil, teclado y que las rutas
   de dashboard continúen protegidas.

La FAQ oficial confirma que la ruta la controla Next.js y que `baseUrl` debe
coincidir; también advierte que no puede haber una página manual y otra MDX con
la misma URL. Fuente: [inicio rápido de Fumadocs][quick-start].

## Despliegue en Vercel

Fumadocs no introduce un runtime separado: se despliega como la aplicación
Next.js subyacente. El build existente de `apps/web` generará `.source`, las
rutas estáticas de documentación y los endpoints LLM. No hacen falta variables
de entorno nuevas para MDX, ZBSearch o estas salidas. Fumadocs remite al despliegue
del framework; Next.js reconoce Vercel como adaptador verificado. Fuentes:
[despliegue Fumadocs][fumadocs-deploy] y
[despliegue Next.js][next-deploy].

Comprobaciones mínimas antes de producción:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @odyshell/web build

GET /docs
GET /docs/getting-started
GET /api/search?query=machine
GET /llms.txt
GET /llms-full.txt
GET /docs/getting-started.md
```

Además se debe probar que `llms-full.txt` no contiene patrones de secretos o
tokens, que una página Markdown inexistente responde 404, que la página HTML
equivalente usa la respuesta noindex de Next.js y que añadir Fumadocs no hace
públicas rutas del dashboard.

## Límites y decisiones

- Fumadocs MDX es una capa de contenido, no un CMS; las ediciones requieren commit
  y despliegue.
- MDX es código compilado. Solo se debe aceptar contenido revisado del repositorio,
  no MDX arbitrario enviado por usuarios.
- `llms-full.txt` crecerá linealmente con la documentación. Mantenerlo en el MVP,
  medir tamaño y dividirlo por áreas si se vuelve costoso.
- ZBSearch local evita cuentas y servicios externos; para un corpus grande habrá que
  cambiar de motor o estrategia de índice.
- `DocsLayout` reduce mantenimiento, pero su CSS toca preflight. Debe adoptarse con
  el preset shadcn y pruebas visuales, sin intentar replicar el dashboard dentro de
  la documentación.
- `Ask AI` y un MCP documental son extensiones futuras. Primero conviene ofrecer
  Markdown estable y fácil de descubrir; es más pequeño, auditable y útil para
  cualquier agente.

[quick-start]: https://www.fumadocs.dev/docs
[manual-next]: https://www.fumadocs.dev/docs/manual-installation/next
[mdx-next]: https://www.fumadocs.dev/docs/mdx/next
[collections]: https://www.fumadocs.dev/docs/mdx/collections
[page-conventions]: https://www.fumadocs.dev/docs/page-conventions
[loader]: https://www.fumadocs.dev/docs/headless/source-api
[docs-layout]: https://www.fumadocs.dev/docs/ui/layouts/docs
[docs-page]: https://www.fumadocs.dev/docs/ui/layouts/page
[themes]: https://www.fumadocs.dev/docs/ui/theme
[search]: https://www.fumadocs.dev/docs/search
[ai-llms]: https://www.fumadocs.dev/docs/integrations/llms
[page-tree]: https://www.fumadocs.dev/docs/headless/page-tree
[fumadocs-deploy]: https://www.fumadocs.dev/docs/deploying
[next-deploy]: https://nextjs.org/docs/app/getting-started/deploying

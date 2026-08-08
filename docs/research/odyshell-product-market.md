# Qué producto debería ser Odyshell

Fecha de verificación: 2026-08-08.

## Veredicto

No conviene continuar el roadmap actual como si el ICP y el producto ya estuvieran validados.
La evidencia pública sí demuestra un problema urgente y presupuestado: conceder acceso temporal,
atribuible y revocable a terceros que trabajan sobre infraestructura privada. No demuestra todavía,
con la misma fuerza, que empresas estén buscando y pagando por dejar que **agentes de IA** ejecuten
shell arbitraria en máquinas reales de sus clientes.

La mejor hipótesis para validar es más estrecha que «acceso remoto para agentes» y distinta de
«otro PAM»:

> **Odyshell es un gateway, controlado y alojado por el dueño de la máquina, que delega tareas de
> shell no interactivas y temporales a automatizaciones externas sobre hosts Linux existentes, sin
> entregar SSH, unir al tercero a la red ni conceder acceso permanente.**

El primer segmento a investigar debe ser el de **proveedores de software y MSPs que diagnostican o
remedian servidores Linux de clientes**, hablando con las dos partes de la relación: el proveedor
que necesita operar y el responsable de infraestructura o seguridad que debe autorizarlo. No es una
elección definitiva de ICP: es el segmento con mejor intersección observable entre dolor, frecuencia,
presupuesto y encaje arquitectónico. Los equipos internos de plataforma son una segunda hipótesis con
presupuesto, pero tienen alternativas mucho más maduras. Los self-hosters son buenos usuarios de
diseño y distribución, no un ICP comercial prometedor.

La conclusión más importante es negativa: la intersección exacta «tercero + agente autónomo + host
real de cliente + disposición a pagar» todavía carece de evidencia pública suficiente. Antes de
invertir en más producto deben realizarse entrevistas y pilotos con umbrales de abandono explícitos.

## Cómo se investigó

Se contrastaron cuatro tipos de fuente primaria:

- documentación, arquitectura, licencias y precios oficiales de alternativas;
- conversaciones de usuarios en Reddit y Hacker News;
- issues y discussions de los repositorios que implementan Teleport, Tailscale y MCP;
- el comportamiento y la documentación que existen hoy en este repositorio.

Las páginas comerciales prueban oferta, posicionamiento y unidad de precio; no prueban demanda por sí
solas. Las conversaciones públicas prueban que alguien expresó un problema, no su representatividad.
Por eso el informe etiqueta por separado **evidencia**, **inferencia** y **recomendación**.

## Lo que la evidencia demuestra

### 1. El acceso de proveedores externos es un problema real y recurrente

**Evidencia.** En varias conversaciones independientes, administradores describen el mismo trabajo:
un proveedor pide acceso permanente, una cuenta administrativa o su propio RMM; el cliente responde
con VPN, jump box, escritorio compartido, reglas de firewall activadas manualmente o una plataforma
PAM. Las propiedades exigidas se repiten: acceso iniciado o controlado por el cliente, ventana
temporal, identidad individual, mínimo alcance, MFA, revocación y registro de sesión.[^vendor-2026]
[^vendor-tool][^vendor-2022][^vendor-msp]

Un caso de mayo de 2026 explica además el conflicto económico: el proveedor quiere acceso 24/7
porque le permite asignar técnicos con flexibilidad, mientras el cliente asume el riesgo. La misma
conversación afirma que los proveedores suelen aceptar acceso controlado por el cliente si preserva
el valor del contrato.[^vendor-2026] Esto identifica comprador, usuario y tensión, no solo una
preferencia técnica.

**Inferencia.** El trabajo no es «crear una VPN»; es negociar y aplicar una delegación entre dos
organizaciones que no comparten identidad, red ni apetito de riesgo. Ahí existe una cuña posible para
Odyshell. Sin embargo, las conversaciones observadas tratan principalmente de técnicos humanos, no
de agentes de IA. Sustituir al técnico por un agente es una hipótesis que todavía debe probarse.

### 2. Los agentes ya usan SSH sobre hosts reales, pero la demanda observada es prosumer

**Evidencia.** Usuarios de Claude Code y comunidades self-hosted describen flujos reales sobre VPS y
homelabs: ejecutar SSH por comando, montar con SSHFS, copiar scripts, desplegar, reiniciar servicios y
leer logs. Sus problemas son sesiones no interactivas, conexiones que se rompen, bloqueos por
reintentos, copiar contexto y combinar `tmux`, SSH y una VPN.[^remote-machines][^remote-bridge]
[^claude-ssh][^homelab-ai] Han aparecido MCP servers de SSH que añaden perfiles `readonly` o
`restricted` y auditoría opcional, señal de que los propios implementadores perciben la necesidad de
un límite fuera del modelo.[^mcp-ssh]

La cautela también es explícita. En la conversación sobre self-hosting con IA, varios participantes
prefieren que el agente escriba scripts para revisión, señalan resultados incorrectos o recomiendan
CI/CD en vez de acceso directo.[^homelab-ai][^remote-machines]

**Inferencia.** Existe uso, pero la mayoría de evidencia pública corresponde a una persona operando
sus propias máquinas con credenciales que ya posee. Eso valida ergonomía y utilidad, no un comprador
B2B ni el consentimiento entre empresas. Los self-hosters pueden producir feedback rápido, pero sus
alternativas gratuitas —SSH, Tailscale, scripts, Salt, Ansible— y su preferencia por FOSS reducen la
disposición probable a pagar.

### 3. El mercado general de acceso ya está densamente cubierto

**Evidencia.** Teleport combina túneles, certificados cortos, RBAC, JIT, auditoría, SSH y acceso MCP;
en 2026 documenta específicamente identidades para agentes y pide design partners para ese caso.[^teleport-ai]
[^teleport-mcp] StrongDM vende autorización JIT, auditoría y policy enforcement para humanos,
service accounts y agentes.[^strongdm-pricing] Tailscale ofrece SSH, JIT y grabación; Cloudflare
combina túnel saliente con Access; Boundary ofrece proxy por identidad, credenciales y grabación;
Rundeck, Ansible y Salt ya ejecutan trabajo remoto.[^tailscale-ssh][^tailscale-jit]
[^cloudflare-tunnel][^boundary][^rundeck][^salt]

En Hacker News, usuarios comparan Teleport y Tailscale precisamente por control de autenticación,
reverse tunnels y grabación de sesiones. También señalan que facilitar shell ad hoc puede reducir la
disciplina de convertir cambios en automatización reproducible.[^hn-teleport][^hn-replace]

**Inferencia.** «Sin puertos entrantes», «tokens temporales», «auditoría», «MCP» o «self-hosted» no
son diferenciadores por separado. Teleport es el competidor estratégico más cercano y Salt el
sustituto OSS funcional más peligroso. Si Odyshell intenta igualar la amplitud de un PAM, una VPN o
una plataforma de automatización, perderá la ventaja de un MVP estrecho.

### 4. MCP es una interfaz, no el límite de seguridad

**Evidencia.** El propio proyecto MCP declara que un servidor local corre con los privilegios del
cliente, que un servidor puede ejecutar comandos como comportamiento intencional y que el modelo
puede invocar herramientas de maneras no solicitadas expresamente. Responsabiliza al servidor de
validar inputs y aplicar control de acceso, y al cliente de consentimiento y sandboxing cuando sea
posible.[^mcp-trust] Sus prácticas para clientes requieren que un broker vuelva a autorizar cada
tool call incluso cuando procede de código ya aprobado.[^mcp-client] Issues recientes muestran
bypasses de aprobación a través de wrappers MCP y SSRF capaz de alcanzar credenciales de metadata
cloud.[^mcp-bypass][^mcp-ssrf]

**Recomendación.** MCP debe ser un adaptador sobre la misma API autorizada que usan el SDK y la CLI.
No debe tener una ruta privilegiada, decidir permisos ni recibir credenciales del host. Autorización,
TTL, revocación, límites de proceso y auditoría pertenecen debajo del protocolo.

### 5. Los sandboxes resuelven la frontera contraria

**Evidencia.** E2B, Daytona y Modal crean compute aislado para código no confiable. Cobran CPU,
memoria, almacenamiento y duración; E2B y Daytona ofrecen variantes BYOC/self-hosted, mientras Modal
aloja la infraestructura.[^e2b][^daytona][^modal]

**Inferencia.** Esos productos preguntan «¿dónde puede el agente hacer un desastre sin afectar nada
real?». Odyshell pregunta «¿cómo autorizamos un cambio deliberado sobre una máquina real y con estado?».
No debe construir un sandbox ni un runtime de agentes. Puede integrarse con ellos después: un agente
aislado podría solicitar una tarea Odyshell, pero la máquina destino seguiría siendo un recurso real.

### Patrones de rechazo y fricción

La evidencia comunitaria no converge en una herramienta odiada; converge en compromisos odiados por
cada lado:

- el dueño de la infraestructura rechaza RMM permanente, admin local compartido, acceso 24/7 y
  herramientas controladas por el proveedor porque reducen su capacidad de revocar, atribuir y
  limitar el blast radius;[^vendor-2026][^vendor-tool]
- el proveedor rechaza esperar a que una persona abra una VPN, un firewall o un screen share cada vez
  que necesita continuar un ticket;[^vendor-2026]
- el operador de agentes rechaza copiar comandos y logs entre terminal y modelo, pero tampoco confía
  en un LLM con credenciales o producción sin revisión;[^remote-machines][^homelab-ai]
- equipos pequeños buscan alternativas cuando el coste o la operación de Teleport/PAM exceden su
  necesidad, aunque siguen pidiendo SSH, acceso web y auditoría self-hosted.[^teleport-alternative]

**Inferencia.** El producto útil no elimina toda fricción: mueve la fricción al momento correcto. Una
aprobación de tarea breve antes de actuar puede satisfacer al dueño sin obligar al proveedor a
coordinar cada comando. Si los compradores exigen aprobación comando por comando, el beneficio de
automatización cae y la tesis debe reevaluarse.

## Comparación de segmentos

| Segmento | Dolor público observado | Frecuencia | Presupuesto proxy | Acceso a pilotos | Presión competitiva | Juicio |
| --- | --- | --- | --- | --- | --- | --- |
| Proveedores de software/MSPs que operan Linux de clientes | Alto: cuentas compartidas, RMM permanente, VPN, jump boxes, coordinación manual y auditoría | Recurrente durante soporte, upgrades e incidentes | Alto: ya evalúan PAM, ZTNA, RMM y VDI | Medio: exige reclutar a proveedor y cliente | Alta en acceso humano; menor en tarea agent-first cross-org | **Primera hipótesis** |
| Plataforma/SRE/seguridad internos desplegando agentes | Emergente: identidad del agente, secretos, blast radius y auditoría | Potencialmente alta | Alto | Medio-bajo sin red empresarial previa | Muy alta: Teleport, StrongDM, Tailscale, Boundary y CI/CD | Segunda hipótesis |
| Vendors puros de agentes que necesitan hosts de clientes | Plausible, pero la evidencia pública encontrada procede sobre todo de proveedores, no de compradores | Desconocida | Desconocido | Bajo hasta identificar productos en producción | Teleport ya busca design partners | No preseleccionar sin entrevistas |
| Desarrolladores que administran uno o varios VPS | Claro: SSH frágil/no interactivo, despliegue y diagnóstico manual | Semanal | Bajo-medio | Alto | SSH, CI/CD, Coolify/Dokploy, Tailscale y MCP-SSH | Canal de aprendizaje, no ICP inicial |
| Homelab/self-hosters | Claro y accesible | Ocasional/semanal | Bajo | Muy alto | FOSS, WireGuard/Tailscale/Headscale/Salt | Community edition y testing |
| IoT/edge fleets | Encaje arquitectónico con egress-only, pero poca evidencia comunitaria reunida para tareas de agentes | Desconocida | Potencialmente alto | Bajo | ngrok, RMM y plataformas del fabricante | Investigación posterior |

La tabla no es un TAM ni una puntuación estadística. Resume la calidad relativa de la evidencia
encontrada. La oportunidad mejor documentada es el acceso de terceros; la oportunidad más alineada
con el relato actual —vendors de agentes— es también la menos probada públicamente.

## Qué sustitutos compra o ensambla hoy cada usuario

| Alternativa | Unidad comercial pública | Lo que ya resuelve | Hueco que deja para la hipótesis propuesta |
| --- | --- | --- | --- |
| Teleport | MAU + recurso protegido; Enterprise bajo presupuesto | Identidad humana/máquina/agente, JIT, SSH, MCP, túneles, RBAC y grabación; Community self-hosted | Producto amplio y operacionalmente mayor; el hueco solo puede ser workflow cross-org mucho más simple, no features |
| StrongDM | Un SKU por usuario; precio bajo ventas | PAM/JIT, aprobaciones, policy y auditoría para agentes y humanos | Control plane operado por StrongDM; no es soberano de extremo a extremo |
| Tailscale | Personal $0; Standard $8/seat/mes; Premium $18/seat/mes | Mesh, identidad de red, SSH, JIT y grabación | Control plane SaaS; concede conectividad/red y sesión, no una tarea externa con resultado estructurado |
| Cloudflare Access + Tunnel | Free hasta 50 usuarios; PAYG $7/usuario/mes anual | Egress tunnel, identidad y acceso de terceros sin VPN | Control plane/edge SaaS y foco en acceso a aplicaciones/red |
| Boundary | HCP por usuario activo humano o máquina; 6–20 usuarios ≈ $24–25 Standard o $48–50 Plus/mes; Enterprise self-managed bajo ventas | JIT, proxy, credenciales, targets, workers y session recording en Plus | Plataforma PAM y operación más compleja; no agent-task API mínima |
| ngrok | $0; Hobby $8/mes anual; PAYG $20/mes + uso | Reachability TCP/HTTP detrás de NAT | Conserva autenticación SSH y no aporta consentimiento por tarea ni autoridad local |
| Rundeck | Community gratis; comercial bajo ventas | Runbooks, jobs, SSH, ACL, scheduling, logs y plugins | Su centro es catálogo/runbook; el Runner outbound es comercial |
| Ansible/AAP | Community gratis; AAP dimensionado por managed nodes bajo presupuesto | Playbooks, ad hoc commands, inventario, RBAC empresarial | Normalmente presupone SSH/ruta/credenciales y trabajo modelado como automatización |
| Salt | OSS sin tarifa de software | Minions outbound, remote exec arbitraria, estados, jobs y targeting masivo | No resuelve de forma productizada el consentimiento cross-org ni UX de agente temporal |
| E2B | Hobby $0 + uso; Pro $150/mes + uso | MicroVMs desechables para ejecutar código de agentes | No actúa sobre el host privado existente |
| Daytona | CPU $0.0504/vCPU/h, RAM $0.0162/GiB/h y storage; OSS AGPL/self-hosted | Sandboxes persistentes, SDK/MCP, red y auditoría | Aísla un computador creado para el agente; no delega el host existente |
| Modal | Starter $0 + compute; Team $250/mes + compute | Sandboxes serverless alojados | No self-hosted y no actúa sobre la máquina real |

Fuentes de precios y límites: Teleport,[^teleport-pricing] Tailscale,[^tailscale-pricing]
Cloudflare,[^cloudflare-pricing] Boundary,[^boundary-pricing] ngrok,[^ngrok-pricing]
StrongDM,[^strongdm-pricing] Ansible,[^ansible-pricing] E2B,[^e2b] Daytona[^daytona] y
Modal.[^modal] Los importes son precios de lista observados en la fecha de verificación, sin
impuestos, descuentos ni contratos negociados.

Otras piezas self-hosted confirman que conectividad y acceso humano son commodities ensamblables:
Headscale ofrece un control server compatible con Tailscale deliberadamente limitado a una tailnet
personal o pequeña; Pangolin crea sites outbound con default-deny y clientes de red; Apache Guacamole
ofrece SSH/RDP/VNC desde navegador y grabación.[^headscale][^pangolin][^guacamole] Son alternativas
relevantes para el comprador que solo necesita llegar a una máquina o supervisar a una persona, pero
no implementan por sí solas la identidad de integración y el lifecycle de tarea propuestos.

## El hueco defendible

Ningún elemento individual es nuevo. El hueco plausible es la combinación y, sobre todo, el modelo
de relación:

1. el **dueño del host** opera el control plane y conserva identidad, política y evidencia;
2. un **actor externo** se registra como integración, no como empleado ni miembro permanente;
3. pide una **tarea** con propósito, targets y duración;
4. un humano del lado propietario aprueba esa autoridad visible;
5. el cliente outbound ejecuta comandos no interactivos como un usuario de SO explícito;
6. el grant expira o se revoca y deja un registro atribuible.

Teleport y StrongDM pueden aproximar gran parte con configuración. Salt puede aproximar la ejecución.
Tailscale o Cloudflare pueden aproximar la conectividad. La hipótesis de Odyshell es que ensamblar y
operar esas piezas es demasiado costoso para proveedores medianos y que el cliente prefiere una
superficie limitada a tareas frente a incorporar al proveedor a su red o IAM.

Eso debe medirse como ventaja de workflow: minutos hasta primera tarea, número de pasos para aprobar,
ausencia de cuentas/SSH compartidos y capacidad de demostrar quién pidió, aprobó y ejecutó cada
acción. No debe venderse como ausencia de competidores.

## Contrato de self-hosting

El requisito del usuario implica **self-hosting soberano del camino crítico**, no solo desplegar un
servidor propio mientras identidad o autorización dependen de un SaaS.

### Hallazgo en el estado actual

La guía actual de [self-hosting](../self-hosting.md) exige la aplicación web y Clerk Organizations
para identidad humana y aprobación. El servidor y la web importan directamente SDKs de Clerk
([server package](../../apps/server/package.json), [web package](../../apps/web/package.json)).
Clerk se describe oficialmente como SaaS gestionado y sin opción self-hosted; su FAPI y Backend API
son servicios aprovisionados por Clerk.[^clerk-managed][^clerk-architecture] Por tanto, la ruta
actual es **customer-hosted con dependencia SaaS**, no self-hostable de extremo a extremo. Un CNAME
propio no cambia quién opera el servicio.

También se encontraron licencias Apache-2.0 solo en `apps/cli`, `packages/sdk` y
`packages/protocol`; no existe licencia raíz ni licencia explícita para `apps/server`, `apps/web` o
`apps/client`. Como hallazgo de repositorio —no asesoría legal—, publicar el código sin una licencia
aplicable no ofrece a terceros una ruta jurídicamente clara para usar, modificar y redistribuir el
control plane self-hosted.

### Requisito recomendado

Una instalación MVP debe:

- arrancar con Compose sobre infraestructura del operador y seguir autorizando tareas sin depender
  de ningún servicio SaaS operado por Odyshell, Clerk u otro proveedor obligatorio;
- incluir cuenta administrativa local de bootstrap y soportar OIDC genérico opcional; el operador
  puede elegir ZITADEL, Authentik, Keycloak o un IdP SaaS, pero ninguno debe ser obligatorio;
- guardar identidades, grants, comandos, resultados de control y auditoría en PostgreSQL del
  operador;
- documentar backups, restauración, upgrades, rotación de claves y revocación;
- no requerir telemetría, license check o relay externo para el camino de datos en la edición
  funcional self-hosted;
- tener una licencia explícita para cada componente necesario para operar el producto.

ZITADEL y Authentik documentan despliegues propios y OIDC, demostrando que no es necesario inventar
un IdP para eliminar la dependencia obligatoria.[^zitadel][^authentik] Integrar OIDC genérico y un
bootstrap local es más pequeño y más interoperable que acoplar el dominio de Odyshell a otro SDK de
auth específico.

## MVP recomendado

### Un único workflow

El vertical inicial debe ser: **un proveedor diagnostica y remedia un servicio Linux de un cliente
durante una tarea aprobada**.

Ejemplo de prueba: el proveedor solicita «diagnosticar y corregir el servicio de ingestión» sobre un
host; el cliente aprueba 30 minutos; la automatización consulta estado y logs, edita configuración,
reinicia el servicio y verifica salud; el cliente revoca o deja expirar el grant y revisa el registro.

### Debe incluir

- una instalación single-tenant del control plane, web y PostgreSQL;
- Linux y un cliente persistente outbound-only;
- enrollment de host mediante token corto de un solo uso;
- identidad independiente por integración/agente;
- solicitud de tarea con actor, propósito, host, usuario de SO, TTL y límites visibles;
- aprobación humana y denegación desde la web;
- shell arbitraria **no interactiva** durante el grant aprobado;
- timeout, límite de output, concurrencia y número de procesos; cancelación que termine el árbol de
  procesos;
- revocación efectiva durante una tarea y denegación de replays o comandos posteriores;
- API, SDK y MCP como adaptadores equivalentes sobre la misma autorización;
- exportación JSON del registro de la tarea.

### La auditoría mínima debe cambiar

La tesis actual de eventos «content-minimal» no basta para el comprador observado. Las conversaciones
sobre acceso de vendors piden logs inmutables o session recording, y Teleport, Tailscale, StrongDM y
Boundary venden profundidad de auditoría.[^vendor-2026][^tailscale-recording][^boundary]

Para cada comando, el MVP debe conservar al menos solicitante, aprobador, identidad de agente, host,
usuario de SO, comando exacto, directorio, timestamps, exit code, timeout/cancelación y tamaño del
resultado. `stdout`/`stderr` pueden ser configurables y estar desactivados por defecto para reducir
secret leakage, pero un registro que omite incluso el comando no permite explicar qué hizo el agente.
Al ser self-hosted, el operador controla retención y destino. Esto sigue sin ser tamper-proof frente a
un administrador de la instalación; no debe prometerse inmutabilidad hasta implementarla.

### Límite de seguridad honesto

El usuario de SO es la frontera. Un working directory no confina shell arbitraria: el comando puede
leer cualquier archivo, credencial, socket o red accesible a ese usuario y persistir cambios después
del TTL. La pantalla de aprobación debe decir literalmente qué usuario y host se conceden. El MVP
debe recomendar un usuario dedicado sin `sudo`, pero no denominarlo sandbox.

La identidad temporal limita **quién, dónde y durante cuánto tiempo** puede ejecutar; no vuelve seguro
el contenido del comando. Esta limitación puede ser un motivo de rechazo del mercado y debe probarse
en entrevistas, no esconderse con filtros de comandos que el shell pueda eludir.

### No debe incluir todavía

- Stripe, planes o enforcement de pago;
- Windows/macOS, Kubernetes, RDP o browser automation;
- terminal interactiva, VPN, port forwarding o acceso general a la red;
- runtime/model hosting, multi-agent orchestration o sandboxes;
- HA multi-región, SCIM, SIEM nativo o compliance claims;
- organizaciones y workspaces multi-tenant dentro de una instalación: el deployment es el tenant;
- allowlists que intenten interpretar shell;
- un catálogo de runbooks, scheduling o configuración declarativa que compita con Rundeck/Ansible/Salt.

## Buyer, usuario y unidad de valor

Para la primera hipótesis:

- **comprador/controlador:** responsable de infraestructura o seguridad del cliente;
- **usuario operativo:** soporte/SRE del proveedor y su automatización;
- **beneficiario económico adicional:** el proveedor, que reduce coordinación y tiempo por ticket;
- **objeto gobernado:** host o site de cliente durante una tarea;
- **activación:** primera tarea real completada sin cuenta SSH/VPN compartida;
- **retención:** sites con tareas exitosas recurrentes, no logins al dashboard.

Los precios del mercado usan seats, usuarios activos, recursos protegidos, managed nodes o compute.
Para Odyshell, cobrar por seat castiga una relación con muchos técnicos/agentes externos; cobrar por
operación hace impredecible una tarea que puede requerir muchos pasos. La unidad futura más legible
es **host o site activo gestionado**, posiblemente con capacidad incluida. Esto es una recomendación,
no evidencia de que una cifra concreta vaya a funcionar.

El MVP no necesita billing integrado. Los primeros pilotos deben venderse manualmente como diseño e
integración con una cuota fija. Que PAM y automation vendors cobren por usuario o nodo es un proxy de
presupuesto, no una validación del precio de Odyshell.

## Plan de validación antes de construir más

### Reclutamiento equilibrado

Realizar al menos 15 entrevistas:

- cinco proveedores/MSPs que hoy acceden a Linux de clientes;
- cinco responsables de infraestructura/seguridad que autorizan a vendors;
- cinco equipos internos que estén probando agentes con acciones sobre sistemas reales.

No enseñar primero la solución. Pedir el último caso real: qué falló, quién pidió acceso, cuánto tardó,
qué credencial se entregó, qué aprobación/auditoría exigió el cliente y cuánto costó el proceso.

### Pruebas que pueden refutar la tesis

1. ¿Aceptaría el cliente instalar un conector outbound de un tercero si él mismo aloja el control
   plane?
2. ¿Aceptaría autoridad de un usuario de SO sin sandbox, aunque sea temporal y auditable?
3. ¿Necesita aprobar cada comando, toda la tarea o solo categorías de riesgo?
4. ¿El proveedor puede operar contra un endpoint distinto por cliente o necesita un control plane
   central propio?
5. ¿La evidencia de comando/exit code es suficiente o exige stdout, video, SIEM o credenciales
   inyectadas?
6. ¿Quién pagaría: proveedor, cliente o ambos? ¿Qué presupuesto o herramienta reemplaza?

### Umbral para continuar

Construir el vertical solo si:

- al menos cinco pares proveedor/cliente confirman un workflow mensual o más frecuente;
- tres clientes aceptan instalar el stack self-hosted y el conector en una máquina no ficticia;
- dos pares completan el mismo tipo de tarea una segunda vez durante una semana;
- al menos un comprador firma un piloto pagado o compromiso equivalente;
- ningún requisito recurrente obliga a convertirse primero en VPN, RMM, sandbox o PAM generalista.

Si el dolor aparece solo en homelabs, mantenerlo como proyecto OSS o pivotar. Si los equipos internos
ya resuelven con Teleport/StrongDM/Tailscale/CI, no competir por amplitud. Si los clientes exigen
sandboxing, el producto deja de ser acceso a hosts reales y debe reevaluarse, no añadir un contenedor
cosmético.

## Decisiones que el siguiente grilling debe resolver

La investigación deja estas preguntas, en este orden:

1. ¿Odyshell puede abandonar «agent vendors» como ICP asumido y validar primero soporte/MSP
   cross-org, aunque el actor inicial combine automatización y supervisión humana?
2. ¿Self-hostable significa que Clerk debe salir del camino obligatorio y que cada deployment será
   single-tenant?
3. ¿Se acepta registrar el comando exacto por defecto para que «auditoría» tenga valor operativo?
4. ¿El producto se compromete a no ofrecer terminal interactiva, VPN ni red privada en el MVP?
5. ¿Se acepta detener el desarrollo si no aparece un piloto pagado tras las entrevistas y el
   prototipo del workflow?

## Limitaciones

- La investigación usa evidencia pública. Los procesos de compra, evaluaciones privadas y precios
  empresariales negociados no son observables.
- Reddit, HN e issues sobrerrepresentan usuarios técnicos, problemas y proyectos nuevos; no permiten
  estimar tamaño de mercado.
- No se entrevistó a compradores ni se observó un deployment real. Por ello la recomendación es una
  hipótesis priorizada, no product-market fit.
- La evidencia sobre vendor access es fuerte pero mayoritariamente humana; extrapolarla a agentes es
  la principal inferencia pendiente.
- Teleport, Tailscale, MCP y los sandboxes cambian rápidamente. Capacidades y precios deben
  reverificarse antes de una decisión comercial.
- No se realizó análisis jurídico de licencias, privacidad, responsabilidad contractual o
  regulación de acceso de terceros.

## Fuentes

Todas las fuentes se consultaron el 2026-08-08.

[^vendor-2026]: Reddit, r/sysadmin, [How to handle vendor remote access?](https://www.reddit.com/r/sysadmin/comments/1t4m7dn/how_to_handle_vendor_remote_access/), 2026-05-05.
[^vendor-tool]: Reddit, r/sysadmin, [Vendor proposes we install their remote access tool](https://www.reddit.com/r/sysadmin/comments/1rqsj8t/vendor_proposes_we_install_their_remote_access/), 2026-03-11.
[^vendor-2022]: Reddit, r/sysadmin, [How do you securely allow access for vendors to your network?](https://www.reddit.com/r/sysadmin/comments/v4q8bc/), 2022-06-04.
[^vendor-msp]: Reddit, r/msp, [Individual Credential Management](https://www.reddit.com/r/msp/comments/1527ql4/), 2023-07-18.
[^remote-machines]: Reddit, r/ClaudeCode, [How are you letting Claude work on remote machines?](https://www.reddit.com/r/ClaudeCode/comments/1twpv0q/how_are_you_letting_claude_work_on_remote_machines/), 2026-06-04.
[^remote-bridge]: Reddit, r/selfhosted, [Built an MCP server that lets Claude SSH into your server](https://www.reddit.com/r/selfhosted/comments/1s0prhm/built_an_mcp_server_that_lets_claude_or_any/), 2026-03-22.
[^claude-ssh]: Reddit, r/ClaudeAI, [Is it possible for Claude Code in VS Code to manage SSH connections?](https://www.reddit.com/r/ClaudeAI/comments/1s7tmge/is_it_possible_for_claude_code_in_vs_code_to_be/), 2026-03-30.
[^homelab-ai]: Reddit, r/selfhosted, [2026 is the year of self-hosting](https://www.reddit.com/r/selfhosted/comments/1q4sxqh/2026_is_the_year_of_selfhosting/), 2026-01-05.
[^mcp-ssh]: GitHub, bvisible, [mcp-ssh-manager](https://github.com/bvisible/mcp-ssh-manager), consultado en la revisión publicada en 2026.
[^teleport-ai]: Teleport, [AI Agents with Machine & Workload Identity](https://goteleport.com/docs/machine-workload-identity/use-cases/ai-agents-mwi/).
[^teleport-mcp]: Teleport, [MCP Access](https://goteleport.com/docs/enroll-resources/mcp-access/).
[^strongdm-pricing]: StrongDM, [Pricing](https://www.strongdm.com/pricing/) y [Gateways and Relays](https://docs.strongdm.com/admin/networking/gateways-and-relays).
[^tailscale-ssh]: Tailscale, [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh).
[^tailscale-jit]: Tailscale, [Just-in-time network access, generally available](https://tailscale.com/blog/jit-access-ga), 2025-03-18.
[^cloudflare-tunnel]: Cloudflare, [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) y [Connect internal network services](https://developers.cloudflare.com/use-cases/apis/internal-services/).
[^boundary]: HashiCorp, [What is Boundary?](https://developer.hashicorp.com/boundary/docs/what-is-boundary) y [Self-managed worker operations](https://developer.hashicorp.com/hcp/docs/boundary/self-managed-workers).
[^rundeck]: PagerDuty, [Rundeck Introduction](https://docs.rundeck.com/docs/about/introduction.html) y [Runbook Automation Self Hosted](https://docs.rundeck.com/docs/about/enterprise/).
[^salt]: Salt Project, [Introduction to Salt](https://docs.saltproject.io/en/3008/topics/index.html) y [Execution architecture](https://docs.saltproject.io/salt/user-guide/en/latest/topics/execution-architecture.html).
[^hn-teleport]: Hacker News, [Teleport compared with Tailscale](https://news.ycombinator.com/item?id=31837663), 2022.
[^hn-replace]: Hacker News, [Ask HN: How did you replace Teleport?](https://news.ycombinator.com/item?id=41873439), 2024-10-17.
[^mcp-trust]: Model Context Protocol, [Security policy and trust model](https://github.com/modelcontextprotocol/modelcontextprotocol/security).
[^mcp-client]: Model Context Protocol, [Client Best Practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices).
[^mcp-bypass]: GitHub, NousResearch/hermes-agent, [Approval bypass through MCP-wrapped commands](https://github.com/NousResearch/hermes-agent/issues/32877), 2026.
[^mcp-ssrf]: GitHub, modelcontextprotocol/servers, [mcp-server-fetch lacks SSRF protection](https://github.com/modelcontextprotocol/servers/issues/4143), 2026-05-12.
[^e2b]: E2B, [Pricing](https://e2b.dev/pricing), [Documentation](https://www.e2b.dev/docs) y [self-hosted repository](https://github.com/e2b-dev/e2b).
[^daytona]: Daytona, [Pricing](https://www.daytona.io/pricing), [Billing](https://www.daytona.io/docs/billing) y [source repository](https://github.com/daytonaio/daytona).
[^modal]: Modal, [Pricing](https://modal.com/pricing), [Sandboxes](https://modal.com/docs/guide/sandboxes) y [Sandbox pricing](https://modal.com/products/sandboxes).
[^teleport-pricing]: Teleport, [Pricing](https://goteleport.com/pricing/), [2026 pricing guide](https://goteleport.com/api/files/teleport-pricing-guide.pdf) y [Usage reporting](https://goteleport.com/docs/usage-billing/).
[^tailscale-pricing]: Tailscale, [Pricing](https://tailscale.com/pricing) y [SSH session recording](https://tailscale.com/kb/1246/tailscale-ssh-session-recording/).
[^cloudflare-pricing]: Cloudflare, [Access](https://www.cloudflare.com/en-in/sase/products/access/) y [Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/).
[^boundary-pricing]: HashiCorp, [Flex Consumption Pricing Table](https://www.hashicorp.com/en/pricing/consumption-table), tabla 6.
[^ngrok-pricing]: ngrok, [Pricing](https://ngrok.com/pricing) y [Using ngrok with SSH](https://ngrok.com/docs/using-ngrok-with/ssh).
[^ansible-pricing]: Red Hat, [Ansible Automation Platform pricing and deployment options](https://www.redhat.com/en/technologies/management/ansible/pricing) y [managed node definition](https://access.redhat.com/articles/3331481).
[^clerk-managed]: Clerk, [Clerk Pricing Explained](https://clerk.com/articles/clerk-pricing-explained), 2026-06-25: Clerk se identifica como managed SaaS sin self-host option.
[^clerk-architecture]: Clerk, [How Clerk works](https://clerk.com/docs/guides/how-clerk-works/overview) y [Backend API reference](https://clerk.com/docs/reference/backend-api).
[^zitadel]: ZITADEL, [Deployment options](https://zitadel.com/docs) y [Deploy ZITADEL](https://zitadel.com/docs/self-hosting/deploy/overview).
[^authentik]: authentik, [Docker Compose installation](https://docs.goauthentik.io/install-config/install/docker-compose/).
[^tailscale-recording]: Tailscale, [SSH session recording](https://tailscale.com/kb/1246/tailscale-ssh-session-recording/).
[^teleport-alternative]: Reddit, r/devops, [Alternatives to Teleport that also cover SSH and Web App access?](https://www.reddit.com/r/devops/comments/15zwqe3/), 2023-08-24.
[^headscale]: Headscale, [Project scope](https://headscale.net/stable/) y [Registration methods](https://headscale.net/stable/ref/registration/).
[^pangolin]: Pangolin, [How Pangolin works](https://docs.pangolin.net/about/how-pangolin-works).
[^guacamole]: Apache Guacamole, [Project overview](https://guacamole.apache.org/) y [session recording release](https://guacamole.apache.org/releases/0.9.10-incubating/).

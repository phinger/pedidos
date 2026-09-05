# Pedidos

App para cargar pedidos desde el iPhone sobre una planilla de Google Sheets.

Se instala en el escritorio como si fuera una app nativa: se elige un nombre,
se suman productos con botones − / + mientras se scrollea el listado, y al
finalizar se agrega una fila en la solapa de pedidos con fecha, hora y el
detalle concatenado. La columna de status la sigue calculando la fórmula de la
planilla.

```
GitHub Pages  ──POST──▶  Apps Script /exec  ──▶  Google Sheets
  (la app)                  (la API)             (los datos)
```

- `docs/` — la app: HTML, CSS, JS, manifest, service worker e íconos.
- `apps-script/Codigo.gs` — la API, se pega en el editor de Apps Script.
- `tools/probar-codigo.js` — pruebas de la API contra una planilla simulada.
- `tools/generar-iconos.py` — regenera los PNG del ícono.

---

## Puesta en marcha

Hay cuatro pasos que requieren tu cuenta y no se pueden automatizar desde acá.
Toman unos 15 minutos.

### 1. Preparar la planilla

En la planilla, además de la solapa del catálogo y la de pedidos, hace falta
una tercera solapa llamada **`Usuarios`** con la lista de quiénes pueden cargar
pedidos:

| Email | Activo |
|---|---|
| `vos@gmail.com` | SI |
| `otra.persona@gmail.com` | SI |

Sin esa solapa nadie puede entrar: el script falla cerrado a propósito. Para
sacarle el acceso a alguien, poné `NO` en Activo — queda afuera en menos de
5 minutos, sin tocar código.

**Sobre la columna de status:** el script escribe celda por celda y nunca toca
esa columna. Lo ideal es que la fórmula sea un `ARRAYFORMULA` en el encabezado,
para que se complete sola en cada fila nueva. Si en cambio está escrita celda
por celda, cambiá `MODO_STATUS: 'auto'` por `'copiar'` en `Codigo.gs` y el
script la va a arrastrar desde la fila anterior.

### 2. Crear el cliente de OAuth

En [console.cloud.google.com](https://console.cloud.google.com):

1. Creá un proyecto (o usá uno existente).
2. **APIs y servicios → Pantalla de consentimiento de OAuth**: tipo *Externo*,
   completá nombre y email de contacto, y agregá tu cuenta en *Usuarios de
   prueba*. No hace falta publicar la app ni pasar verificación.
3. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de
   OAuth**, tipo **Aplicación web**:
   - *Orígenes autorizados de JavaScript*: `https://TU_USUARIO.github.io`
   - *URI de redirección autorizados*: `https://TU_USUARIO.github.io/pedidos/`
     — con la barra final, exactamente igual a la URL de la app.
4. Anotá el **Client ID** y el **Client secret**.

> Para probar en la compu, agregá también `http://localhost:8000` como origen y
> `http://localhost:8000/` como URI de redirección.

### 3. Desplegar el Apps Script

1. Abrí la planilla → **Extensiones → Apps Script**.
2. Pegá el contenido de `apps-script/Codigo.gs` en el editor.
3. **Configuración del proyecto → Propiedades del script**, agregá:
   - `CLIENT_ID` → el Client ID del paso anterior
   - `CLIENT_SECRET` → el Client secret
4. Ejecutá la función **`probarEstructura`** una vez y mirá el registro
   (*Ver → Registro*). Te va a listar las solapas, sus encabezados y cómo quedó
   resuelto el mapeo de columnas. Si alguna dice `⚠️ NO ENCONTRADA`, agregá el
   nombre real de esa columna al principio de la lista correspondiente en el
   bloque `CFG`.
5. **Implementar → Nueva implementación → Aplicación web**:
   - *Ejecutar como*: **Yo**
   - *Quién tiene acceso*: **Cualquier usuario**
6. Copiá la URL que termina en `/exec`.

> **Por qué "cualquier usuario":** un Web App restringido responde a las
> llamadas del navegador con un redirect al login de Google que CORS bloquea, y
> la app nunca recibiría los datos. El control de acceso lo hace el script: sin
> un token de sesión válido —que solo se obtiene con una cuenta de la solapa
> `Usuarios`— toda acción devuelve error. La URL sola no sirve para nada.

### 4. Configurar y publicar la app

En `docs/config.js` completá los dos valores:

```js
window.PEDIDOS_CONFIG = {
  apiUrl:   'https://script.google.com/macros/s/.../exec',
  clientId: '....apps.googleusercontent.com',
};
```

Guardá, `git push`, y GitHub Pages republica solo.

### 5. Instalar en el iPhone

Abrí la URL en **Safari** (no Chrome), tocá *Compartir* → **Agregar a inicio**.
Después entrá siempre por el ícono.

---

## El login en iOS

El popup de Google Sign-In está roto en las PWA instaladas en iOS: desde la
17.5 la ventana emergente pierde el `window.opener` y nunca devuelve el
resultado. Por eso esta app usa **OAuth 2.0 con PKCE por redirect**, sin
librería ni popups, y guarda una sesión de larga duración: el login pasa una
sola vez por dispositivo.

Queda un caso borde: iOS a veces abre el login fuera de la app y la vuelta
aterriza en Safari, cuyo almacenamiento está separado del de la app instalada.
Si eso pasa, la pantalla muestra un **código de 6 dígitos**. Abrís *Pedidos*
desde el ícono, tocás *"Tengo un código"*, lo escribís, y la sesión pasa a la
app. Es un trámite de una sola vez.

---

## Desarrollo

```bash
# Pruebas de la API (planilla simulada, no toca nada real)
node tools/probar-codigo.js

# Servir la app localmente
cd docs && python3 -m http.server 8000

# Ver el diseño sin configurar nada
open http://localhost:8000/?demo=1

# Regenerar los íconos después de tocar el color o el dibujo
python3 tools/generar-iconos.py
```

El **modo demo** (`?demo=1`) levanta un catálogo falso y no escribe en ninguna
planilla: sirve para revisar el diseño en el teléfono antes de tener Google
configurado.

Al publicar cambios en `docs/`, subí `VERSION` en `sw.js` para que el service
worker invalide el caché viejo.

## Decisiones que conviene conocer

- **Idempotencia.** Cada pedido lleva una clave generada en el teléfono. Si el
  envío llega pero la respuesta se pierde, reintentar devuelve el mismo pedido
  en lugar de duplicar la fila.
- **Los nombres salen del catálogo.** El servidor ignora el nombre de producto
  que manda el cliente y usa el de la planilla, así un borrador viejo no ensucia
  los datos.
- **Fecha y hora las pone el servidor**, con la zona horaria de la planilla: no
  dependen del reloj del teléfono.
- **Los IDs de producto derivan del nombre**, no del número de fila: se pueden
  reordenar filas sin romper los pedidos a medio cargar.
- **El borrador se guarda en el teléfono** con cada toque. Si la app se cierra,
  al volver está intacto.

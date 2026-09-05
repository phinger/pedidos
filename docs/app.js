/* ═══════════════════════════════════════════════════════════════════════
   Pedidos — lógica del cliente.
   Sin dependencias externas: todo corre en el navegador del iPhone.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

(() => {

const CFG = window.PEDIDOS_CONFIG || {};

/* Claves de almacenamiento local. El token de sesión es de larga duración:
   el login de Google ocurre una sola vez por dispositivo. */
const LS = {
  token:     'pedidos.token',
  usuario:   'pedidos.usuario',
  borrador:  'pedidos.borrador',
  catalogo:  'pedidos.catalogo',
  nombres:   'pedidos.nombres',
  verifier:  'pedidos.pkce_verifier',
  estadoOAuth: 'pedidos.oauth_state',
};

const CATALOGO_FRESCO_MS = 5 * 60 * 1000;   // pasado esto, refresca en segundo plano
const TODAS = '__todas__';

/* Modo demo: catálogo falso y envíos que no tocan la planilla. Sirve para
   probar el diseño en el teléfono antes de configurar Google. Se activa con
   ?demo=1 y se ofrece solo si config.js todavía no está completo. */
const CONFIGURADO = !!(CFG.apiUrl && CFG.clientId &&
  CFG.apiUrl.indexOf('PEGAR_') < 0 && CFG.clientId.indexOf('PEGAR_') < 0);
let demo = false;

const CATALOGO_DEMO = [
  { categoria: 'Almacén',    unidad: '1 kg',    nombre: 'Granola artesanal' },
  { categoria: 'Almacén',    unidad: '500 g',   nombre: 'Avena arrollada' },
  { categoria: 'Almacén',    unidad: '250 g',   nombre: 'Castañas de cajú' },
  { categoria: 'Almacén',    unidad: '1 l',     nombre: 'Aceite de oliva' },
  { categoria: 'Panadería',  unidad: '500 g',   nombre: 'Pan integral' },
  { categoria: 'Panadería',  unidad: 'x 6 u.',  nombre: 'Facturas integrales' },
  { categoria: 'Congelados', unidad: 'x 6 u.',  nombre: 'Milanesas de soja' },
  { categoria: 'Congelados', unidad: 'x 12 u.', nombre: 'Empanadas de verdura' },
  { categoria: 'Congelados', unidad: '200 g',   nombre: 'Queso vegano' },
  { categoria: 'Bebidas',    unidad: '1,5 l',   nombre: 'Jugo de naranja' },
  { categoria: 'Bebidas',    unidad: 'x 6 u.',  nombre: 'Agua saborizada' },
  { categoria: 'Frescos',    unidad: '400 g',   nombre: 'Tofu ahumado' },
  { categoria: 'Frescos',    unidad: '200 g',   nombre: 'Hummus de garbanzo' },
].map(function (p, i) {
  return { id: 'demo' + i, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad, orden: i };
});

let contadorDemo = 0;

function respuestaDemo(accion) {
  if (accion === 'productos') return { ok: true, productos: CATALOGO_DEMO };
  if (accion === 'pedido') {
    contadorDemo++;
    return { ok: true, id: 'DEMO-' + String(contadorDemo).padStart(4, '0') };
  }
  return { ok: true };
}

const estado = {
  productos: [],
  cantidades: {},          // id de producto -> cantidad
  categoria: TODAS,
  busqueda: '',
  usuario: null,
  claveEnvio: null,        // clave de idempotencia del pedido en curso
  enviando: false,
};

const filas = new Map();   // id de producto -> { fila, cantidadEl, stepper }

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ── Utilidades ──────────────────────────────────────────────────────── */

const leerJSON = (clave, porDefecto) => {
  try { const v = localStorage.getItem(clave); return v ? JSON.parse(v) : porDefecto; }
  catch { return porDefecto; }
};
const guardarJSON = (clave, valor) => {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* almacenamiento lleno */ }
};

const normalizar = (s) => (s || '').toString().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const esStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let avisoTimer;
function aviso(texto) {
  const el = $('#aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function mostrarPantalla(id) {
  $$('.pantalla').forEach((p) => p.removeAttribute('data-activa'));
  $(id).setAttribute('data-activa', '');
}

function abrirHoja(id) {
  $('#velo').hidden = false;
  $(id).hidden = false;
}
function cerrarHojas() {
  $('#velo').hidden = true;
  $('#p-resumen').hidden = true;
  $('#p-menu').hidden = true;
}

/* ── API ─────────────────────────────────────────────────────────────── */

/* Content-Type text/plain a propósito: convierte el POST en una "simple
   request" y evita el preflight OPTIONS, que Apps Script no responde. */
async function api(accion, datos = {}) {
  if (demo) {
    await new Promise((r) => setTimeout(r, 320));   // simula la latencia de la red
    return respuestaDemo(accion, datos);
  }
  if (!CFG.apiUrl || CFG.apiUrl.includes('PEGAR_')) {
    throw new Error('Falta configurar apiUrl en config.js');
  }
  const cuerpo = JSON.stringify({
    accion,
    token: localStorage.getItem(LS.token) || '',
    ...datos,
  });

  let respuesta;
  try {
    respuesta = await fetch(CFG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: cuerpo,
      redirect: 'follow',
    });
  } catch {
    throw Object.assign(new Error('Sin conexión con el servidor.'), { red: true });
  }

  if (!respuesta.ok) throw new Error('El servidor respondió ' + respuesta.status + '.');

  let json;
  try { json = await respuesta.json(); }
  catch { throw new Error('Respuesta inesperada del servidor.'); }

  if (!json.ok) {
    const err = new Error(json.error || 'Error del servidor.');
    err.codigo = json.codigo;
    if (json.codigo === 'SIN_AUTORIZACION') cerrarSesion(true);
    throw err;
  }
  return json;
}

/* ── Autenticación: OAuth 2.0 con PKCE, por redirect (sin popups) ────── */

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const aleatorio = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function desafioPKCE(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(hash);
}

/* Debe coincidir exactamente con el "Authorized redirect URI" del cliente OAuth.
   Se recorta "index.html" para que abrir esa ruta a mano no rompa el login. */
const redirectURI = () => location.origin + location.pathname.replace(/index\.html$/, '');

async function iniciarLogin() {
  if (!CFG.clientId || CFG.clientId.includes('PEGAR_')) {
    return errorLogin('Falta configurar clientId en config.js');
  }
  const verifier = aleatorio(48);
  const estadoCsrf = aleatorio(16);
  localStorage.setItem(LS.verifier, verifier);
  localStorage.setItem(LS.estadoOAuth, estadoCsrf);

  const p = new URLSearchParams({
    client_id: CFG.clientId,
    redirect_uri: redirectURI(),
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: await desafioPKCE(verifier),
    code_challenge_method: 'S256',
    state: estadoCsrf,
    prompt: 'select_account',
  });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

function errorLogin(msg) {
  const el = $('#login-error');
  el.textContent = msg;
  el.hidden = false;
  mostrarPantalla('#p-login');
}

/* Google vuelve a esta misma URL con ?code=...&state=... */
async function procesarRetornoOAuth(params) {
  const limpiarURL = () => history.replaceState(null, '', redirectURI());

  if (params.get('error')) {
    limpiarURL();
    errorLogin(params.get('error') === 'access_denied'
      ? 'Cancelaste el ingreso.'
      : 'Google rechazó el ingreso: ' + params.get('error'));
    return true;
  }

  const code = params.get('code');
  if (!code) return false;

  const esperado = localStorage.getItem(LS.estadoOAuth);
  const verifier = localStorage.getItem(LS.verifier);
  localStorage.removeItem(LS.estadoOAuth);
  localStorage.removeItem(LS.verifier);
  limpiarURL();

  if (!esperado || params.get('state') !== esperado || !verifier) {
    errorLogin('El ingreso no se pudo validar. Probá de nuevo.');
    return true;
  }

  try {
    const r = await api('login', { code, code_verifier: verifier, redirect_uri: redirectURI() });
    localStorage.setItem(LS.token, r.token);
    guardarJSON(LS.usuario, { nombre: r.nombre, email: r.email });
    estado.usuario = { nombre: r.nombre, email: r.email };

    /* Si iOS expulsó el login a Safari, el token quedó en el almacenamiento
       equivocado: mostramos un código para pasarlo a la app instalada. */
    if (!esStandalone() && r.codigoVinculacion) {
      $('#codigo-vinculacion').textContent = r.codigoVinculacion.replace(/(\d{3})(\d{3})/, '$1 $2');
      mostrarPantalla('#p-codigo');
    } else {
      await entrarALaApp();
    }
  } catch (e) {
    errorLogin(e.message);
  }
  return true;
}

async function vincular() {
  const codigo = $('#input-codigo').value.replace(/\D/g, '');
  const err = $('#vincular-error');
  err.hidden = true;
  $('#btn-vincular').disabled = true;
  try {
    const r = await api('vincular', { codigo });
    localStorage.setItem(LS.token, r.token);
    guardarJSON(LS.usuario, { nombre: r.nombre, email: r.email });
    estado.usuario = { nombre: r.nombre, email: r.email };
    await entrarALaApp();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    $('#btn-vincular').disabled = $('#input-codigo').value.replace(/\D/g, '').length !== 6;
  }
}

function entrarEnDemo() {
  demo = true;
  estado.usuario = { nombre: 'Demo', email: 'modo demo' };
  $('#cinta-demo').hidden = false;
  entrarALaApp();
}

function cerrarSesion(silencioso) {
  demo = false;
  $('#cinta-demo').hidden = true;
  localStorage.removeItem(LS.token);
  localStorage.removeItem(LS.usuario);
  estado.usuario = null;
  cerrarHojas();
  mostrarPantalla('#p-login');
  if (!silencioso) aviso('Sesión cerrada');
}

/* ── Catálogo ────────────────────────────────────────────────────────── */

async function entrarALaApp() {
  mostrarPantalla('#p-pedido');
  cargarBorrador();
  actualizarNombresRecientes();

  /* En demo no se toca el caché real: ni se lee ni se escribe. */
  const cache = demo ? null : leerJSON(LS.catalogo, null);
  if (cache && Array.isArray(cache.productos) && cache.productos.length) {
    aplicarCatalogo(cache.productos);
    if (Date.now() - (cache.ts || 0) > CATALOGO_FRESCO_MS) refrescarCatalogo(false);
  } else {
    mostrarEsqueletos();
    await refrescarCatalogo(false);
  }
}

function mostrarEsqueletos() {
  $('#lista-productos').innerHTML = '<div class="esqueleto"></div>'.repeat(7);
}

async function refrescarCatalogo(manual) {
  try {
    const r = await api('productos');
    if (!demo) guardarJSON(LS.catalogo, { ts: Date.now(), productos: r.productos });
    aplicarCatalogo(r.productos);
    if (manual) aviso('Catálogo actualizado');
  } catch (e) {
    if (e.codigo === 'SIN_AUTORIZACION') return;
    if (!estado.productos.length) {
      $('#lista-productos').innerHTML =
        '<div class="vacio"><p>' + e.message + '</p></div>';
      const reintentar = document.createElement('button');
      reintentar.className = 'btn btn-secundario';
      reintentar.textContent = 'Reintentar';
      reintentar.onclick = () => { mostrarEsqueletos(); refrescarCatalogo(true); };
      $('#lista-productos').firstElementChild.appendChild(reintentar);
    } else if (manual) {
      aviso('No se pudo actualizar');
    }
  }
}

function aplicarCatalogo(productos) {
  estado.productos = productos;

  /* Si un producto desapareció del catálogo, sacamos su cantidad del borrador. */
  const vigentes = new Set(productos.map((p) => p.id));
  let cambio = false;
  for (const id of Object.keys(estado.cantidades)) {
    if (!vigentes.has(id)) { delete estado.cantidades[id]; cambio = true; }
  }
  if (cambio) guardarBorrador();

  renderChips();
  renderLista();
  actualizarBarra();
}

/* ── Render ──────────────────────────────────────────────────────────── */

function renderChips() {
  const cont = $('#chips-categorias');
  const categorias = [];
  for (const p of estado.productos) {
    if (p.categoria && !categorias.includes(p.categoria)) categorias.push(p.categoria);
  }
  cont.innerHTML = '';
  cont.hidden = categorias.length < 2;   // sin categorías la fila no ocupa lugar
  if (cont.hidden) return;

  for (const [valor, etiqueta] of [[TODAS, 'Todo'], ...categorias.map((c) => [c, c])]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.role = 'tab';
    chip.textContent = etiqueta;
    chip.setAttribute('aria-selected', String(estado.categoria === valor));
    chip.onclick = () => {
      estado.categoria = valor;
      renderChips();
      renderLista();
    };
    cont.appendChild(chip);
  }
}

function productosVisibles() {
  const q = normalizar(estado.busqueda).trim();
  return estado.productos.filter((p) => {
    if (estado.categoria !== TODAS && p.categoria !== estado.categoria) return false;
    if (!q) return true;
    return normalizar(p.nombre).includes(q) || normalizar(p.categoria).includes(q);
  });
}

function renderLista() {
  const cont = $('#lista-productos');
  const visibles = productosVisibles();
  filas.clear();
  cont.innerHTML = '';

  $('#lista-vacia').hidden = visibles.length > 0;
  if (!visibles.length) return;

  /* Con "Todo" y sin búsqueda agrupamos por categoría con encabezado pegajoso. */
  const agrupar = estado.categoria === TODAS && !estado.busqueda.trim();
  let categoriaActual = null;

  const frag = document.createDocumentFragment();
  for (const p of visibles) {
    if (agrupar && p.categoria && p.categoria !== categoriaActual) {
      categoriaActual = p.categoria;
      const h = document.createElement('h2');
      h.className = 'grupo-titulo';
      h.textContent = categoriaActual;
      frag.appendChild(h);
    }
    frag.appendChild(crearFila(p));
  }
  cont.appendChild(frag);
}

function crearFila(p) {
  const cantidad = estado.cantidades[p.id] || 0;

  const fila = document.createElement('article');
  fila.className = 'item';
  fila.dataset.elegido = String(cantidad > 0);

  const info = document.createElement('div');
  info.className = 'item-info';

  const nombre = document.createElement('div');
  nombre.className = 'item-nombre';
  nombre.textContent = p.nombre;
  info.appendChild(nombre);

  const detalle = [p.categoria, p.unidad].filter(Boolean).join(' · ');
  if (detalle) {
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = detalle;
    info.appendChild(meta);
  }

  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  stepper.dataset.cero = String(cantidad === 0);

  const menos = document.createElement('button');
  menos.className = 'btn-menos';
  menos.type = 'button';
  menos.textContent = '−';
  menos.setAttribute('aria-label', 'Quitar uno de ' + p.nombre);
  menos.onclick = () => cambiarCantidad(p.id, -1);

  const cantidadEl = document.createElement('span');
  cantidadEl.className = 'cantidad';
  cantidadEl.textContent = String(cantidad);
  cantidadEl.setAttribute('aria-live', 'polite');

  const mas = document.createElement('button');
  mas.className = 'btn-mas';
  mas.type = 'button';
  mas.textContent = '+';
  mas.setAttribute('aria-label', 'Agregar uno de ' + p.nombre);
  mas.onclick = () => cambiarCantidad(p.id, +1);

  stepper.append(menos, cantidadEl, mas);
  fila.append(info, stepper);

  filas.set(p.id, { fila, cantidadEl, stepper });
  return fila;
}

function cambiarCantidad(id, delta) {
  const previa = estado.cantidades[id] || 0;
  const nueva = Math.min(999, Math.max(0, previa + delta));
  if (nueva === previa) return;

  if (nueva === 0) delete estado.cantidades[id];
  else estado.cantidades[id] = nueva;

  const ref = filas.get(id);
  if (ref) {
    ref.cantidadEl.textContent = String(nueva);
    ref.stepper.dataset.cero = String(nueva === 0);
    ref.fila.dataset.elegido = String(nueva > 0);
    ref.cantidadEl.classList.remove('pulso');
    void ref.cantidadEl.offsetWidth;      // reinicia la animación
    ref.cantidadEl.classList.add('pulso');
  }

  guardarBorrador();
  actualizarBarra();
}

function totales() {
  const items = Object.entries(estado.cantidades)
    .map(([id, cantidad]) => {
      const p = estado.productos.find((x) => x.id === id);
      return p ? { id, nombre: p.nombre, cantidad } : null;
    })
    .filter(Boolean);
  const unidades = items.reduce((a, i) => a + i.cantidad, 0);
  return { items, unidades };
}

function actualizarBarra() {
  const { items, unidades } = totales();
  const nombre = $('#input-nombre').value.trim();
  const listo = items.length > 0 && nombre.length > 0;

  $('#btn-finalizar').disabled = !listo;
  $('#finalizar-texto').textContent = 'Finalizar';
  const badge = $('#finalizar-badge');
  badge.hidden = unidades === 0;
  badge.textContent = String(unidades);

  const motivo = $('#barra-motivo');
  if (listo) {
    motivo.hidden = true;
  } else {
    motivo.textContent = items.length === 0
      ? 'Agregá al menos un producto'
      : 'Escribí el nombre del pedido arriba';
    motivo.hidden = false;
  }
}

/* ── Borrador ────────────────────────────────────────────────────────── */

function guardarBorrador() {
  guardarJSON(LS.borrador, {
    nombre: $('#input-nombre').value,
    cantidades: estado.cantidades,
    clave: estado.claveEnvio,
  });
}

function cargarBorrador() {
  const b = leerJSON(LS.borrador, null);
  if (!b) return;
  $('#input-nombre').value = b.nombre || '';
  estado.cantidades = b.cantidades || {};
  estado.claveEnvio = b.clave || null;
}

function vaciarPedido() {
  estado.cantidades = {};
  estado.claveEnvio = null;
  localStorage.removeItem(LS.borrador);
  renderLista();
  actualizarBarra();
}

function actualizarNombresRecientes() {
  const lista = $('#nombres-recientes');
  lista.innerHTML = '';
  for (const n of leerJSON(LS.nombres, [])) {
    const op = document.createElement('option');
    op.value = n;
    lista.appendChild(op);
  }
}

function recordarNombre(nombre) {
  const previos = leerJSON(LS.nombres, []).filter((n) => n !== nombre);
  guardarJSON(LS.nombres, [nombre, ...previos].slice(0, 12));
  actualizarNombresRecientes();
}

/* ── Resumen y envío ─────────────────────────────────────────────────── */

function abrirResumen() {
  const { items, unidades } = totales();
  if (!items.length) return;

  $('#resumen-nombre').textContent = $('#input-nombre').value.trim();
  const cont = $('#resumen-lista');
  cont.innerHTML = '';
  for (const i of items) {
    const fila = document.createElement('div');
    fila.className = 'resumen-fila';
    const n = document.createElement('span');
    n.textContent = i.nombre;
    const c = document.createElement('span');
    c.className = 'resumen-cant';
    c.textContent = '×' + i.cantidad;
    fila.append(n, c);
    cont.appendChild(fila);
  }
  $('#resumen-total').textContent =
    unidades + (unidades === 1 ? ' ítem' : ' ítems') +
    ' · ' + items.length + (items.length === 1 ? ' producto' : ' productos');
  $('#resumen-error').hidden = true;
  abrirHoja('#p-resumen');
}

async function confirmar() {
  if (estado.enviando) return;
  const { items } = totales();
  const nombre = $('#input-nombre').value.trim();
  if (!items.length || !nombre) return;

  /* La clave sobrevive a los reintentos: si el primer envío llegó pero la
     respuesta se perdió, el servidor devuelve el mismo pedido en lugar de
     duplicarlo. */
  if (!estado.claveEnvio) {
    estado.claveEnvio = aleatorio(12);
    guardarBorrador();
  }

  estado.enviando = true;
  const boton = $('#btn-confirmar');
  boton.disabled = true;
  boton.textContent = 'Enviando…';
  $('#resumen-error').hidden = true;

  try {
    const r = await api('pedido', {
      nombre,
      items: items.map((i) => ({ id: i.id, nombre: i.nombre, cantidad: i.cantidad })),
      clave: estado.claveEnvio,
    });

    recordarNombre(nombre);
    const { unidades } = totales();
    $('#exito-id').textContent = r.id;
    $('#exito-detalle').textContent =
      nombre + ' · ' + unidades + (unidades === 1 ? ' ítem' : ' ítems');

    vaciarPedido();
    $('#input-nombre').value = '';
    cerrarHojas();
    mostrarPantalla('#p-exito');
  } catch (e) {
    const err = $('#resumen-error');
    err.textContent = e.red
      ? 'No hay conexión. Revisá la señal y tocá Confirmar de nuevo: no se va a duplicar.'
      : e.message;
    err.hidden = false;
  } finally {
    estado.enviando = false;
    boton.disabled = false;
    boton.textContent = 'Confirmar pedido';
  }
}

/* ── Eventos ─────────────────────────────────────────────────────────── */

function conectarEventos() {
  $('#btn-login').onclick = iniciarLogin;
  $('#btn-demo').onclick = entrarEnDemo;
  $('#btn-ir-vincular').onclick = () => mostrarPantalla('#p-vincular');
  $('#btn-volver-login').onclick = () => mostrarPantalla('#p-login');
  $('#btn-vincular').onclick = vincular;
  $('#btn-seguir-aca').onclick = () => entrarALaApp();

  $('#input-codigo').oninput = (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    $('#btn-vincular').disabled = e.target.value.length !== 6;
  };

  $('#input-nombre').oninput = () => { guardarBorrador(); actualizarBarra(); };
  $('#input-nombre').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };

  const buscar = $('#input-buscar');
  buscar.oninput = () => {
    estado.busqueda = buscar.value;
    $('#btn-limpiar-busqueda').hidden = !buscar.value;
    renderLista();
  };
  $('#btn-limpiar-busqueda').onclick = () => {
    buscar.value = '';
    estado.busqueda = '';
    $('#btn-limpiar-busqueda').hidden = true;
    renderLista();
  };
  $('#btn-reset-filtros').onclick = () => {
    buscar.value = '';
    estado.busqueda = '';
    estado.categoria = TODAS;
    $('#btn-limpiar-busqueda').hidden = true;
    renderChips();
    renderLista();
  };

  $('#btn-finalizar').onclick = abrirResumen;
  $('#btn-volver-pedido').onclick = cerrarHojas;
  $('#btn-confirmar').onclick = confirmar;
  $('#velo').onclick = cerrarHojas;

  $('#btn-nuevo').onclick = () => { mostrarPantalla('#p-pedido'); $('#input-nombre').focus(); };

  $('#btn-menu').onclick = () => {
    const u = estado.usuario;
    $('#menu-usuario').textContent = u ? u.email : '';
    abrirHoja('#p-menu');
  };
  $('#btn-refrescar').onclick = () => { cerrarHojas(); refrescarCatalogo(true); };
  $('#btn-vaciar').onclick = () => { cerrarHojas(); vaciarPedido(); aviso('Pedido vaciado'); };
  $('#btn-salir').onclick = () => cerrarSesion(false);

  /* Al volver a la app, refresca el catálogo si quedó viejo. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!localStorage.getItem(LS.token)) return;
    const cache = leerJSON(LS.catalogo, null);
    if (!cache || Date.now() - (cache.ts || 0) > CATALOGO_FRESCO_MS) refrescarCatalogo(false);
  });
}

/* ── Arranque ────────────────────────────────────────────────────────── */

async function iniciar() {
  conectarEventos();

  const params = new URLSearchParams(location.search);

  if (params.get('demo') === '1') { entrarEnDemo(); return; }
  if (!CONFIGURADO) {
    $('#btn-demo').hidden = false;
    $('#login-error').textContent =
      'Todavía falta completar config.js con la URL del Web App y el Client ID.';
    $('#login-error').hidden = false;
  }

  if (await procesarRetornoOAuth(params)) return;

  if (localStorage.getItem(LS.token)) {
    estado.usuario = leerJSON(LS.usuario, null);
    await entrarALaApp();
  } else {
    mostrarPantalla('#p-login');
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin SW igual funciona */ });
  });
}

iniciar();

})();

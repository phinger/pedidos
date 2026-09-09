/* ═══════════════════════════════════════════════════════════════════════
   Catálogo — stock, costos y precios. Pensado para escritorio.

   Reutiliza la sesión que dejó la app de pedidos en localStorage: comparten
   origen, así que no hace falta registrar otro redirect_uri en Google. Si no
   hay sesión, manda a la app a iniciarla y vuelve acá.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

(() => {

const CFG = window.PEDIDOS_CONFIG || {};

const LS = {
  token:   'pedidos.token',
  usuario: 'pedidos.usuario',
};

/* El margen se define sobre la venta:  venta = costo / (1 - margen)
   que es lo mismo que:                 margen = (venta - costo) / venta   */
const margenDe  = (costo, venta) =>
  (costo === null || venta === null || venta <= 0) ? null : (venta - costo) / venta;
const ventaDe   = (costo, margen) =>
  (costo === null || margen === null || margen >= 1) ? null : costo / (1 - margen);

const $  = (sel) => document.querySelector(sel);

const estado = {
  productos: [],
  columnas: {},
  busqueda: '',
  verInactivos: false,
  orden: { campo: 'nombre', asc: true },
};

const dinero = new Intl.NumberFormat('es-AR', {
  style: 'currency', currency: 'ARS', maximumFractionDigits: 2,
});
const numero = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });

/* ── API ─────────────────────────────────────────────────────────────── */

async function api(accion, datos = {}) {
  if (!CFG.apiUrl || CFG.apiUrl.indexOf('PEGAR_') >= 0) {
    throw new Error('La página no tiene configurada la URL del servidor. ' +
      'Revisá que config.js se esté cargando.');
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
  if (!respuesta.ok) {
    /* Un 404 acá casi siempre es una implementación de Apps Script vieja o
       archivada: la URL existe pero ya no responde. Se muestra cuál se usó
       para no tener que adivinar. */
    throw new Error('El servidor respondió ' + respuesta.status + ' en ' + CFG.apiUrl);
  }

  const json = await respuesta.json();
  if (!json.ok) {
    const err = new Error(json.error || 'Error del servidor.');
    err.codigo = json.codigo;
    if (json.codigo === 'SIN_AUTORIZACION') irAIniciarSesion();
    throw err;
  }
  return json;
}

function irAIniciarSesion() {
  localStorage.removeItem(LS.token);
  location.href = '../?next=admin';
}

/* ── Avisos ──────────────────────────────────────────────────────────── */

let avisoTimer;
function aviso(texto, tipo) {
  const el = $('#aviso');
  el.textContent = texto;
  el.dataset.tipo = tipo || '';
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ── Carga ───────────────────────────────────────────────────────────── */

async function cargar() {
  $('#cargando').hidden = false;
  $('#pantalla-error').hidden = true;
  try {
    const r = await api('catalogo');
    estado.productos = r.productos;
    estado.columnas = r.columnas || {};
    $('#cargando').hidden = true;
    $('#app').hidden = false;
    render();
  } catch (e) {
    if (e.codigo === 'SIN_AUTORIZACION') return;
    $('#cargando').hidden = true;
    $('#pantalla-error').hidden = false;
    $('#error-texto').textContent = e.message;
    diagnosticar();
  }
}

/* Pregunta directa al servidor qué versión tiene publicada. Distingue de un
   vistazo entre "la URL está mal" y "el código publicado está viejo". */
async function diagnosticar() {
  const caja = $('#diagnostico');
  caja.hidden = false;
  caja.textContent = 'Servidor configurado: ' + (CFG.apiUrl || '(ninguno)') + '\nComprobando…';
  if (!CFG.apiUrl) return;

  try {
    const r = await fetch(CFG.apiUrl, { redirect: 'follow' });
    const texto = await r.text();
    caja.textContent = 'Servidor configurado: ' + CFG.apiUrl +
      '\nRespuesta: ' + r.status + ' ' + texto.slice(0, 160);
  } catch (e) {
    caja.textContent = 'Servidor configurado: ' + CFG.apiUrl +
      '\nNo respondió: ' + e.message;
  }
}

/* ── Render ──────────────────────────────────────────────────────────── */

function visibles() {
  const q = estado.busqueda.trim().toLowerCase();
  let lista = estado.productos.filter((p) => {
    if (!estado.verInactivos && !p.activo) return false;
    if (!q) return true;
    return (p.nombre + ' ' + p.categoria).toLowerCase().includes(q);
  });

  const { campo, asc } = estado.orden;
  lista = lista.slice().sort((a, b) => {
    const va = campo === 'margen' ? margenDe(a.costo, a.precio) : a[campo];
    const vb = campo === 'margen' ? margenDe(b.costo, b.precio) : b[campo];
    if (va === null || va === undefined || va === '') return 1;    // los vacíos al final
    if (vb === null || vb === undefined || vb === '') return -1;
    const d = typeof va === 'string'
      ? va.localeCompare(vb, 'es')
      : (va === vb ? 0 : (va > vb ? 1 : -1));
    return asc ? d : -d;
  });
  return lista;
}

function render() {
  const lista = visibles();
  const cuerpo = $('#cuerpo');
  cuerpo.innerHTML = '';

  const frag = document.createDocumentFragment();
  lista.forEach((p) => frag.appendChild(crearFila(p)));
  cuerpo.appendChild(frag);

  $('#sin-resultados').hidden = lista.length > 0;
  renderResumen();
  renderOrden();
}

function renderOrden() {
  document.querySelectorAll('thead th[data-orden]').forEach((th) => {
    if (th.dataset.orden === estado.orden.campo) {
      th.setAttribute('aria-sort', estado.orden.asc ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

function renderResumen() {
  const activos = estado.productos.filter((p) => p.activo);
  const sinStock = activos.filter((p) => !p.stock).length;

  let costoTotal = 0;
  let ventaTotal = 0;
  activos.forEach((p) => {
    if (!p.stock) return;
    if (p.costo !== null)  costoTotal += p.stock * p.costo;
    if (p.precio !== null) ventaTotal += p.stock * p.precio;
  });

  /* Margen ponderado por lo que hay en stock, no promedio simple: un producto
     del que hay cien unidades pesa más que uno del que hay una. */
  const margen = ventaTotal > 0 ? (ventaTotal - costoTotal) / ventaTotal : null;

  $('#r-productos').textContent = activos.length +
    (estado.productos.length !== activos.length ? ' / ' + estado.productos.length : '');
  $('#r-sinstock').textContent = sinStock;
  $('#r-costo').textContent = costoTotal ? dinero.format(costoTotal) : '—';
  $('#r-venta').textContent = ventaTotal ? dinero.format(ventaTotal) : '—';
  $('#r-margen').textContent = margen === null ? '—' : numero.format(margen * 100) + ' %';
}

function celda(clase) {
  const td = document.createElement('td');
  if (clase) td.className = clase;
  return td;
}

function crearFila(p) {
  const tr = document.createElement('tr');
  tr.dataset.fila = p.fila;
  tr.dataset.inactivo = String(!p.activo);

  /* ── Texto ── */
  const campoTexto = (campo, ancho) => {
    const td = celda(ancho);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = p[campo] || '';
    input.disabled = estado.columnas[campo] === false;
    input.setAttribute('aria-label', campo + ' de ' + p.nombre);
    input.addEventListener('change', () => guardar(p, tr, { [campo]: input.value }, input));
    td.appendChild(input);
    return td;
  };

  tr.appendChild(campoTexto('nombre'));
  tr.appendChild(campoTexto('categoria', 'col-texto'));
  tr.appendChild(campoTexto('unidad', 'col-texto'));

  /* ── Números ── */
  const entradas = {};
  const campoNumero = (campo, decimales) => {
    const td = celda('col-num');
    const input = document.createElement('input');
    input.type = 'number';
    input.step = decimales ? '0.01' : '1';
    input.min = '0';
    input.value = p[campo] === null || p[campo] === undefined ? '' : p[campo];
    input.disabled = estado.columnas[campo] === false;
    input.setAttribute('aria-label', campo + ' de ' + p.nombre);
    entradas[campo] = input;
    td.appendChild(input);
    return td;
  };

  tr.appendChild(campoNumero('stock', true));
  tr.appendChild(campoNumero('costo', true));
  tr.appendChild(campoNumero('precio', true));

  /* ── Margen: derivado, pero editable en las dos direcciones ── */
  const tdMargen = celda('col-num derivado');
  const inputMargen = document.createElement('input');
  inputMargen.type = 'number';
  inputMargen.step = '0.1';
  inputMargen.setAttribute('aria-label', 'margen de ' + p.nombre);
  tdMargen.appendChild(inputMargen);
  tr.appendChild(tdMargen);

  const leer = (input) => (input.value === '' ? null : Number(input.value));

  const pintarMargen = () => {
    const m = margenDe(leer(entradas.costo), leer(entradas.precio));
    inputMargen.value = m === null ? '' : (m * 100).toFixed(1);
  };
  pintarMargen();

  /* Stock se guarda solo. Costo y venta, además, recalculan el margen. */
  entradas.stock.addEventListener('change', () =>
    guardar(p, tr, { stock: entradas.stock.value }, entradas.stock));

  ['costo', 'precio'].forEach((campo) => {
    entradas[campo].addEventListener('input', pintarMargen);
    entradas[campo].addEventListener('change', () =>
      guardar(p, tr, { [campo]: entradas[campo].value }, entradas[campo]));
  });

  /* El margen es la otra cara del precio: al editarlo se recalcula la venta. */
  inputMargen.addEventListener('change', () => {
    const costo = leer(entradas.costo);
    if (costo === null) {
      aviso('Cargá primero el costo', 'error');
      pintarMargen();
      return;
    }
    const m = inputMargen.value === '' ? null : Number(inputMargen.value) / 100;
    if (m === null || m >= 1) {
      aviso('El margen tiene que ser menor a 100 %', 'error');
      pintarMargen();
      return;
    }
    const venta = ventaDe(costo, m);
    entradas.precio.value = venta.toFixed(2);
    guardar(p, tr, { precio: entradas.precio.value }, entradas.precio);
  });

  /* ── Activo ── */
  const tdActivo = celda('col-activo');
  const envoltorio = document.createElement('div');
  envoltorio.className = 'celda-activo';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = p.activo;
  check.disabled = estado.columnas.activo === false;
  check.setAttribute('aria-label', 'activo: ' + p.nombre);
  check.addEventListener('change', () => {
    tr.dataset.inactivo = String(!check.checked);
    guardar(p, tr, { activo: check.checked }, check);
  });
  envoltorio.appendChild(check);
  tdActivo.appendChild(envoltorio);
  tr.appendChild(tdActivo);

  /* ── Estado del guardado ── */
  const tdEstado = celda('col-estado');
  const marca = document.createElement('div');
  marca.className = 'estado';
  tdEstado.appendChild(marca);
  tr.appendChild(tdEstado);

  return tr;
}

/* ── Guardado ────────────────────────────────────────────────────────── */

const temporizadores = new Map();

async function guardar(producto, tr, campos, origen) {
  const marca = tr.querySelector('.estado');
  marca.dataset.estado = 'guardando';

  /* Se agrupan los cambios de una misma fila: editar costo y venta seguidos
     manda una sola escritura en vez de dos. */
  const pendiente = temporizadores.get(producto.fila) || { campos: {}, timer: null };
  Object.assign(pendiente.campos, campos);
  clearTimeout(pendiente.timer);

  pendiente.timer = setTimeout(async () => {
    const aEnviar = pendiente.campos;
    temporizadores.delete(producto.fila);

    try {
      const r = await api('guardarProducto', {
        fila: producto.fila,
        nombreOriginal: producto.nombre,
        campos: aEnviar,
      });

      /* El modelo local se actualiza con lo que confirmó el servidor, y el
         nombre nuevo pasa a ser la referencia para el próximo guardado. */
      Object.assign(producto, r.campos);
      marca.dataset.estado = 'guardado';
      setTimeout(() => {
        if (marca.dataset.estado === 'guardado') marca.dataset.estado = '';
      }, 1600);
      renderResumen();
    } catch (e) {
      if (e.codigo === 'SIN_AUTORIZACION') return;
      marca.dataset.estado = 'error';
      aviso(e.message, 'error');
      if (origen) origen.focus();
    }
  }, 400);

  temporizadores.set(producto.fila, pendiente);
}

/* ── Eventos ─────────────────────────────────────────────────────────── */

function conectarEventos() {
  $('#buscar').addEventListener('input', (e) => {
    estado.busqueda = e.target.value;
    render();
  });

  $('#ver-inactivos').addEventListener('change', (e) => {
    estado.verInactivos = e.target.checked;
    render();
  });

  $('#btn-recargar').addEventListener('click', () => { cargar(); aviso('Catálogo recargado'); });
  $('#btn-reintentar').addEventListener('click', cargar);

  document.querySelectorAll('thead th[data-orden]').forEach((th) => {
    th.addEventListener('click', () => {
      const campo = th.dataset.orden;
      estado.orden = estado.orden.campo === campo
        ? { campo, asc: !estado.orden.asc }
        : { campo, asc: true };
      render();
    });
  });

  /* Enter confirma y baja a la misma columna de la fila siguiente. */
  $('#cuerpo').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    e.target.blur();
    const tr = e.target.closest('tr');
    const columna = Array.from(tr.children).indexOf(e.target.closest('td'));
    const siguiente = tr.nextElementSibling;
    if (!siguiente) return;
    const destino = siguiente.children[columna].querySelector('input');
    if (destino) { destino.focus(); destino.select(); }
  });
}

/* ── Arranque ────────────────────────────────────────────────────────── */

if (!localStorage.getItem(LS.token)) {
  irAIniciarSesion();
} else {
  const u = JSON.parse(localStorage.getItem(LS.usuario) || 'null');
  if (u) $('#usuario').textContent = u.email;
  conectarEventos();
  cargar();
}

})();

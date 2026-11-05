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

/* Para cruzar el detalle del pedido —que guarda nombres, no códigos— contra
   el catálogo. Mismo criterio que usa el servidor al descontar stock. */
const claveNombre = (n) => String(n || '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Cuánto suma un pedido a precio de venta.
 *
 * Devuelve también cuántos renglones quedaron sin precio: un producto que se
 * renombró, o al que todavía no se le cargó precio, haría parecer que el
 * pedido vale menos de lo que vale. Es preferible marcar el monto como
 * incompleto que mostrar un número que no es.
 */
const calcularMonto = (items, preciosPorNombre) => {
  let monto = 0;
  let sinPrecio = 0;
  (items || []).forEach((item) => {
    const precio = preciosPorNombre.get(claveNombre(item.nombre));
    if (precio === null || precio === undefined) sinPrecio++;
    else monto += precio * item.cantidad;
  });
  return { monto, sinPrecio, completo: sinPrecio === 0 };
};

/* Igual que en la app del teléfono: sin valor no hay seguimiento de stock,
   con cero está agotado. */
const tieneStock = (p) => p.stock !== null && p.stock !== undefined;

const $  = (sel) => document.querySelector(sel);

const estado = {
  vista: 'productos',
  productos: [],
  columnas: {},
  busqueda: '',
  verInactivos: false,
  orden: { campo: 'nombre', asc: true },

  pedidos: [],
  estados: { inicial: 'Pendiente', impreso: 'Impreso', entregado: 'Entregado', cancelado: 'Cancelado' },
  filtroEstado: '__todos__',
  seleccion: new Set(),      // ids de pedidos tildados
  editando: null,
};

const TODOS = '__todos__';

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
    /* Las dos vistas se traen juntas: cambiar de solapa tiene que ser
       instantáneo, sin volver a esperar al servidor. */
    const [catalogo, pedidos] = await Promise.all([api('catalogo'), api('pedidos')]);
    estado.productos = catalogo.productos;
    estado.columnas = catalogo.columnas || {};
    estado.pedidos = pedidos.pedidos;
    if (pedidos.estados) estado.estados = pedidos.estados;

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

/* ── Vistas ──────────────────────────────────────────────────────────── */

function mostrarVista(vista) {
  estado.vista = vista;
  const enProductos = vista === 'productos';

  $('#solapa-productos').setAttribute('aria-selected', String(enProductos));
  $('#solapa-pedidos').setAttribute('aria-selected', String(!enProductos));
  $('#vista-productos').hidden = !enProductos;
  $('#vista-pedidos').hidden = enProductos;
  $('#resumen-productos').hidden = !enProductos;
  $('#resumen-pedidos').hidden = enProductos;
  $('#pie-productos').hidden = !enProductos;
  $('#pie-pedidos').hidden = enProductos;
  $('#filtro-inactivos').hidden = !enProductos;
  $('#chips-estado').hidden = enProductos;
  $('#buscar').placeholder = enProductos
    ? 'Buscar producto o categoría'
    : 'Buscar por nombre, número o producto';

  /* Cada vista tiene su propia búsqueda: pasar de una a otra con el filtro
     puesto haría parecer que faltan cosas. */
  estado.busqueda = '';
  $('#buscar').value = '';
  estado.seleccion.clear();
  render();
}

/* ── Render ──────────────────────────────────────────────────────────── */

function visibles() {
  const q = estado.busqueda.trim().toLowerCase();
  let lista = estado.productos.filter((p) => {
    if (!estado.verInactivos && !p.activo) return false;
    if (!q) return true;
    return (p.codigo + ' ' + p.nombre + ' ' + p.categoria).toLowerCase().includes(q);
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
  if (estado.vista === 'pedidos') { renderPedidos(); return; }

  const lista = visibles();
  const cuerpo = $('#cuerpo');
  cuerpo.innerHTML = '';

  const frag = document.createDocumentFragment();
  lista.forEach((p) => frag.appendChild(crearFila(p)));
  cuerpo.appendChild(frag);

  $('#sin-resultados').hidden = lista.length > 0;
  renderFilaNueva();
  renderResumen();
  renderOrden();
  renderContadorPedidos();   // el badge de la otra solapa también se mira desde acá
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

  tr.appendChild(campoTexto('codigo', 'col-codigo'));
  tr.appendChild(campoTexto('nombre'));
  tr.appendChild(campoTexto('categoria', 'col-texto'));

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

/* ── Pedidos ─────────────────────────────────────────────────────────── */

/**
 * Lo que vale un pedido.
 *
 * Si tiene monto guardado es porque se entregó: ese número quedó congelado a
 * los precios de ese momento y no se vuelve a tocar, aunque después cambien
 * las listas. Si no, se calcula contra los precios de hoy.
 */
function montoDePedido(pedido, precios) {
  if (pedido.monto !== null && pedido.monto !== undefined) {
    return { monto: pedido.monto, sinPrecio: 0, completo: true, congelado: true };
  }
  return Object.assign(calcularMonto(pedido.items, precios), { congelado: false });
}

/* Índice nombre → precio de venta, para no recorrer el catálogo entero por
   cada renglón de cada pedido. */
function indicePrecios() {
  const mapa = new Map();
  estado.productos.forEach((p) => {
    if (p.precio !== null && p.precio !== undefined) mapa.set(claveNombre(p.nombre), p.precio);
  });
  return mapa;
}

function pedidosVisibles() {
  const q = estado.busqueda.trim().toLowerCase();
  return estado.pedidos.filter((p) => {
    if (estado.filtroEstado !== TODOS && p.status !== estado.filtroEstado) return false;
    if (!q) return true;
    return (p.id + ' ' + p.nombre + ' ' + p.detalle).toLowerCase().includes(q);
  });
}

function renderPedidos() {
  renderChipsEstado();

  const lista = pedidosVisibles();
  const precios = indicePrecios();
  const cont = $('#lista-pedidos');
  cont.innerHTML = '';

  const frag = document.createDocumentFragment();
  lista.forEach((p) => frag.appendChild(crearTarjetaPedido(p, precios)));
  cont.appendChild(frag);

  $('#sin-pedidos').hidden = lista.length > 0;
  renderSeleccion();
  renderResumenPedidos();
}

function renderChipsEstado() {
  const cont = $('#chips-estado');
  const cuenta = (valor) => valor === TODOS
    ? estado.pedidos.length
    : estado.pedidos.filter((p) => p.status === valor).length;

  const opciones = [
    [TODOS, 'Todos'],
    [estado.estados.inicial, 'Pendientes'],
    [estado.estados.impreso, 'Impresos'],
    [estado.estados.entregado, 'Entregados'],
    [estado.estados.cancelado, 'Cancelados'],
  ];

  cont.innerHTML = '';
  opciones.forEach(([valor, etiqueta]) => {
    const n = cuenta(valor);
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.setAttribute('aria-selected', String(estado.filtroEstado === valor));
    chip.append(etiqueta);
    const cuentaEl = document.createElement('span');
    cuentaEl.className = 'cuenta';
    cuentaEl.textContent = n;
    chip.appendChild(cuentaEl);
    chip.onclick = () => {
      estado.filtroEstado = valor;
      /* Cambiar el filtro limpia la selección: operar sobre pedidos que ya no
         se ven es la forma más fácil de tocar el pedido equivocado. */
      estado.seleccion.clear();
      render();
    };
    cont.appendChild(chip);
  });
}

function renderContadorPedidos() {
  const pendientes = estado.pedidos.filter((p) => p.status === estado.estados.inicial).length;
  const contador = $('#contador-pedidos');
  contador.hidden = pendientes === 0;
  contador.textContent = pendientes;
}

/* Los pedidos tildados que además están a la vista: sobre esos se opera. */
function seleccionados() {
  return pedidosVisibles().filter((p) => estado.seleccion.has(p.id));
}

function renderSeleccion() {
  const visibles = pedidosVisibles();
  const elegidos = seleccionados();
  const todo = $('#seleccionar-todo');

  todo.checked = visibles.length > 0 && elegidos.length === visibles.length;
  todo.indeterminate = elegidos.length > 0 && elegidos.length < visibles.length;
  todo.disabled = visibles.length === 0;

  $('#texto-seleccion').textContent = elegidos.length
    ? elegidos.length + ' de ' + visibles.length + ' seleccionados'
    : 'Seleccionar todo';

  $('#acciones-lote').hidden = elegidos.length === 0;

  /* Cada botón dice sobre cuántos va a actuar de verdad: si hay diez
     seleccionados pero solo tres se pueden entregar, mejor saberlo antes. */
  const entregables = elegidos.filter(
    (p) => p.status !== estado.estados.entregado && p.status !== estado.estados.cancelado);
  const reversibles = elegidos.filter(
    (p) => p.status === estado.estados.entregado || p.status === estado.estados.cancelado);

  const marcar = (sel, etiqueta, lista) => {
    const b = $(sel);
    b.textContent = lista.length ? etiqueta + ' (' + lista.length + ')' : etiqueta;
    b.disabled = lista.length === 0;
  };
  marcar('#lote-entregar', 'Entregar', entregables);
  marcar('#lote-cancelar', 'Cancelar', entregables);
  marcar('#lote-deshacer', 'Deshacer', reversibles);
}

function renderResumenPedidos() {
  const cuenta = (v) => estado.pedidos.filter((p) => p.status === v).length;

  /* El servidor manda la fecha como dd/MM/yyyy ya formateada, así que se
     compara contra el mismo formato y no contra el del navegador. */
  const d = new Date();
  const hoy = String(d.getDate()).padStart(2, '0') + '/' +
              String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();

  /* El monto acompaña al filtro puesto: si estás mirando los pendientes,
     el número de arriba es el de los pendientes. */
  const precios = indicePrecios();
  const visibles = pedidosVisibles();
  let suma = 0;
  let incompletos = 0;
  visibles.forEach((p) => {
    const r = montoDePedido(p, precios);
    suma += r.monto;
    if (!r.completo) incompletos++;
  });
  $('#p-monto').textContent = (suma ? dinero.format(suma) : '—') +
    (incompletos ? ' *' : '');
  $('#p-monto').title = incompletos
    ? incompletos + ' pedido(s) tienen productos sin precio cargado'
    : '';

  $('#p-total').textContent = estado.pedidos.length;
  $('#p-pendientes').textContent = cuenta(estado.estados.inicial);
  $('#p-impresos').textContent = cuenta(estado.estados.impreso);
  $('#p-entregados').textContent = estado.pedidos
    .filter((p) => p.status === estado.estados.entregado && p.fecha === hoy).length;

  renderContadorPedidos();
}

function crearTarjetaPedido(p, precios) {
  const tarjeta = document.createElement('article');
  tarjeta.className = 'pedido';
  tarjeta.dataset.status = p.status;
  tarjeta.dataset.seleccionado = String(estado.seleccion.has(p.id));

  const marcaSel = document.createElement('div');
  marcaSel.className = 'pedido-marca';
  const tilde = document.createElement('input');
  tilde.type = 'checkbox';
  tilde.checked = estado.seleccion.has(p.id);
  tilde.setAttribute('aria-label', 'seleccionar ' + p.id);
  tilde.onchange = () => {
    if (tilde.checked) estado.seleccion.add(p.id);
    else estado.seleccion.delete(p.id);
    tarjeta.dataset.seleccionado = String(tilde.checked);
    renderSeleccion();
  };
  marcaSel.appendChild(tilde);

  const id = document.createElement('div');
  id.className = 'pedido-id';
  id.textContent = p.id;

  const cuando = document.createElement('div');
  cuando.className = 'pedido-cuando';
  cuando.textContent = [p.fecha, p.hora].filter(Boolean).join(' · ');

  const centro = document.createElement('div');
  const quien = document.createElement('div');
  quien.className = 'pedido-quien';
  quien.textContent = p.nombre;
  const items = document.createElement('div');
  items.className = 'pedido-items';
  items.textContent = p.detalle;
  centro.append(quien, items);

  if (p.email) {
    const mail = document.createElement('div');
    mail.className = 'pedido-mail';
    mail.textContent = p.email;
    centro.appendChild(mail);
  }

  const derecha = document.createElement('div');
  derecha.className = 'pedido-derecha';

  const { monto, sinPrecio, completo, congelado } = montoDePedido(p, precios);
  const importe = document.createElement('div');
  importe.className = 'pedido-monto';
  importe.dataset.incompleto = String(!completo);
  importe.dataset.congelado = String(congelado);
  importe.textContent = completo || monto > 0 ? dinero.format(monto) : '—';
  if (congelado) importe.title = 'Precio al momento de la entrega';
  if (!completo) {
    const falta = document.createElement('span');
    falta.className = 'monto-falta';
    falta.textContent = '+' + sinPrecio + ' sin precio';
    falta.title = sinPrecio === 1
      ? 'Un producto del pedido no tiene precio cargado'
      : sinPrecio + ' productos del pedido no tienen precio cargado';
    importe.appendChild(falta);
  }
  derecha.appendChild(importe);

  const marca = document.createElement('span');
  marca.className = 'marca-estado';
  marca.dataset.status = p.status;
  marca.textContent = p.status || '—';
  derecha.appendChild(marca);

  const acciones = document.createElement('div');
  acciones.className = 'pedido-acciones';

  const boton = (texto, clase, alHacerClic) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (clase || 'btn-fantasma');
    b.type = 'button';
    b.textContent = texto;
    b.onclick = () => alHacerClic(b);
    return b;
  };

  const entregado = p.status === estado.estados.entregado;
  const cancelado = p.status === estado.estados.cancelado;

  if (!entregado && !cancelado) {
    acciones.appendChild(boton('Entregar', 'btn-entregar', (b) => operar(p, 'entregar', b)));
    acciones.appendChild(boton('Editar', null, () => abrirEdicion(p)));
    acciones.appendChild(boton('Cancelar', null, (b) => {
      if (confirm('¿Cancelar el pedido ' + p.id + ' de ' + p.nombre + '?')) operar(p, 'cancelar', b);
    }));
  } else {
    acciones.appendChild(boton('Deshacer', null, (b) => operar(p, 'deshacer', b)));
  }

  derecha.appendChild(acciones);
  tarjeta.append(marcaSel, id, cuando, centro, derecha);
  return tarjeta;
}

async function operar(pedido, operacion, boton) {
  const previo = boton.textContent;
  boton.disabled = true;
  boton.textContent = '…';
  try {
    const r = await api('estadoPedido', { fila: pedido.fila, id: pedido.id, operacion });
    pedido.status = r.status;
    if ('monto' in r) pedido.monto = r.monto;

    if (operacion === 'entregar') {
      /* La entrega ya no mueve stock —se descontó al cargar el pedido—, así
         que lo único que puede salir torcido es el monto. */
      if (r.sinPrecio) {
        aviso('Entregado, pero ' + r.sinPrecio +
          ' producto(s) no tenían precio: el monto quedó incompleto', 'error');
      } else {
        aviso('Pedido ' + pedido.id + ' entregado');
      }
    } else if (operacion === 'cancelar') {
      aviso('Pedido cancelado' + (r.repuesto ? ' · stock devuelto' : ''));
      await recargarCatalogo();
    } else {
      aviso('Se deshizo el cambio' + (r.retomado ? ' · stock vuelto a reservar' : ''));
      await recargarCatalogo();
    }
    render();
  } catch (e) {
    if (e.codigo === 'SIN_AUTORIZACION') return;
    aviso(e.message, 'error');
    boton.disabled = false;
    boton.textContent = previo;
  }
}

async function operarLote(operacion) {
  const elegidos = seleccionados().filter((p) => {
    const terminado = p.status === estado.estados.entregado || p.status === estado.estados.cancelado;
    return operacion === 'deshacer' ? terminado : !terminado;
  });
  if (!elegidos.length) return;

  const verbo = { entregar: 'Entregar', cancelar: 'Cancelar', deshacer: 'Deshacer' }[operacion];
  if (!confirm(verbo + ' ' + elegidos.length +
      (elegidos.length === 1 ? ' pedido?' : ' pedidos?'))) return;

  const barra = $('#acciones-lote');
  barra.hidden = true;
  aviso(verbo + ' ' + elegidos.length + ' pedidos…');

  try {
    const r = await api('estadoPedidos', {
      operacion,
      items: elegidos.map((p) => ({ fila: p.fila, id: p.id })),
    });

    /* El servidor informa pedido por pedido: uno que falle no cancela el resto,
       y hay que reflejar exactamente cuáles cambiaron. */
    const porId = new Map(r.resultados.map((x) => [x.id, x]));
    estado.pedidos.forEach((p) => {
      const res = porId.get(p.id);
      if (!res || !res.ok) return;
      p.status = res.status;
      if ('monto' in res) p.monto = res.monto;
    });

    const fallados = r.resultados.filter((x) => !x.ok);
    let texto = r.hechos + (r.hechos === 1 ? ' pedido' : ' pedidos') + ' ' +
      { entregar: 'entregados', cancelar: 'cancelados', deshacer: 'revertidos' }[operacion];
    if (fallados.length) texto += ' · ' + fallados.length + ' sin cambios: ' + fallados[0].error;
    /* Al revivir cancelados puede no alcanzar el stock para volver a
       reservarlo; al entregar, lo que puede faltar es el precio. */
    if (r.recortados && r.recortados.length) {
      texto += ' · no alcanzó el stock de ' +
        [...new Set(r.recortados.map((x) => x.nombre))].join(', ');
    }
    const sinPrecio = r.resultados.filter((x) => x.sinPrecio).length;
    if (sinPrecio) texto += ' · ' + sinPrecio + ' con el monto incompleto';

    aviso(texto, fallados.length || (r.recortados || []).length || sinPrecio ? 'error' : '');

    estado.seleccion.clear();
    if (operacion !== 'cancelar') await recargarCatalogo();
    render();
  } catch (e) {
    if (e.codigo === 'SIN_AUTORIZACION') return;
    aviso(e.message, 'error');
    renderSeleccion();
  }
}

/* El stock cambió del lado del servidor: la otra solapa tiene que reflejarlo. */
async function recargarCatalogo() {
  try {
    const r = await api('catalogo');
    estado.productos = r.productos;
    estado.columnas = r.columnas || {};
  } catch { /* el listado de pedidos ya se actualizó igual */ }
}

/* ── Edición del detalle ─────────────────────────────────────────────── */

function abrirEdicion(pedido) {
  estado.editando = pedido;
  $('#editar-titulo').textContent = 'Pedido ' + pedido.id;
  $('#editar-sub').textContent = pedido.nombre + ' · ' + [pedido.fecha, pedido.hora].filter(Boolean).join(' ');
  $('#editar-error').hidden = true;
  $('#pista-agregar').textContent = '';
  $('#agregar-nombre').value = '';
  $('#agregar-cantidad').value = '1';

  /* Solo los activos: agregar a un pedido algo dado de baja del catálogo no
     tiene a dónde ir después, ni para el stock ni para el precio. */
  const sugerencias = $('#catalogo-nombres');
  sugerencias.innerHTML = '';
  estado.productos
    .filter((p) => p.activo)
    .forEach((p) => {
      const op = document.createElement('option');
      op.value = p.nombre;
      sugerencias.appendChild(op);
    });

  const cont = $('#editar-items');
  cont.innerHTML = '';
  pedido.items.forEach((item) => cont.appendChild(filaEditable(item.nombre, item.cantidad, false)));

  renderTotalEdicion();
  $('#velo').hidden = false;
  $('#dialogo-editar').hidden = false;
}

/** Un renglón del pedido dentro del diálogo. */
function filaEditable(nombre, cantidad, esNuevo) {
  const fila = document.createElement('div');
  fila.className = 'item-editable' + (esNuevo ? ' item-nuevo' : '');
  fila.dataset.nombre = nombre;

  const etiqueta = document.createElement('span');
  etiqueta.textContent = nombre;

  const entrada = document.createElement('input');
  entrada.type = 'number';
  entrada.min = '0';
  entrada.step = '1';
  entrada.value = cantidad;
  entrada.setAttribute('aria-label', 'cantidad de ' + nombre);
  /* Poner cero tacha el renglón: se ve que va a salir del pedido antes de
     guardar, en vez de descubrirlo después. */
  entrada.addEventListener('input', () => {
    fila.dataset.fuera = String(!(Number(entrada.value) > 0));
    renderTotalEdicion();
  });

  const quitar = document.createElement('button');
  quitar.className = 'quitar';
  quitar.type = 'button';
  quitar.textContent = '✕';
  quitar.title = 'Quitar del pedido';
  quitar.setAttribute('aria-label', 'quitar ' + nombre);
  quitar.addEventListener('click', () => {
    entrada.value = '0';
    fila.dataset.fuera = 'true';
    renderTotalEdicion();
  });

  fila.dataset.fuera = String(!(cantidad > 0));
  fila.append(etiqueta, entrada, quitar);
  return fila;
}

function itemsDelDialogo() {
  return Array.from($('#editar-items').children).map((fila) => ({
    nombre: fila.dataset.nombre,
    cantidad: Number(fila.querySelector('input').value) || 0,
  }));
}

function renderTotalEdicion() {
  const r = calcularMonto(itemsDelDialogo().filter((i) => i.cantidad > 0), indicePrecios());
  const el = $('#editar-monto');
  el.textContent = r.monto || r.completo ? dinero.format(r.monto) : '—';
  el.dataset.incompleto = String(!r.completo);
  el.title = r.completo ? '' : r.sinPrecio + ' producto(s) sin precio cargado';
}

/**
 * Suma un producto al pedido que se está editando.
 *
 * El nombre se resuelve contra el catálogo y se guarda con la grafía de ahí:
 * el descuento de stock y el precio cruzan por nombre, así que un "almendras"
 * escrito a mano quedaría huérfano.
 */
function agregarItemAlPedido() {
  const pista = $('#pista-agregar');
  const escrito = $('#agregar-nombre').value.trim();
  const cantidad = Math.floor(Number($('#agregar-cantidad').value)) || 0;

  const avisar = (texto, esError) => {
    pista.textContent = texto;
    pista.dataset.error = String(!!esError);
  };

  if (!escrito) { avisar('Elegí un producto de la lista', true); $('#agregar-nombre').focus(); return; }
  if (cantidad < 1) { avisar('La cantidad tiene que ser al menos 1', true); return; }

  const producto = estado.productos.find(
    (p) => p.activo && claveNombre(p.nombre) === claveNombre(escrito));
  if (!producto) {
    avisar('"' + escrito + '" no está en el catálogo. Elegilo de la lista.', true);
    return;
  }

  /* Si ya estaba en el pedido se suma a ese renglón, en vez de dejar el mismo
     producto dos veces. */
  const existente = Array.from($('#editar-items').children)
    .find((fila) => claveNombre(fila.dataset.nombre) === claveNombre(producto.nombre));

  if (existente) {
    const entrada = existente.querySelector('input');
    entrada.value = (Number(entrada.value) || 0) + cantidad;
    existente.dataset.fuera = 'false';
    avisar('Se sumaron ' + cantidad + ' a ' + producto.nombre + ', que ya estaba en el pedido');
  } else {
    $('#editar-items').appendChild(filaEditable(producto.nombre, cantidad, true));
    const faltante = tieneStock(producto) && cantidad > producto.stock;
    avisar(faltante
      ? producto.nombre + ' agregado, pero en stock hay ' + producto.stock
      : producto.nombre + ' agregado', faltante);
  }

  $('#agregar-nombre').value = '';
  $('#agregar-cantidad').value = '1';
  $('#agregar-nombre').focus();
  renderTotalEdicion();
}

function cerrarEdicion() {
  estado.editando = null;
  $('#velo').hidden = true;
  $('#dialogo-editar').hidden = true;
}

async function guardarEdicion() {
  const pedido = estado.editando;
  if (!pedido) return;

  const items = itemsDelDialogo();

  const boton = $('#btn-guardar-edicion');
  boton.disabled = true;
  boton.textContent = 'Guardando…';
  try {
    const r = await api('editarPedido', { fila: pedido.fila, id: pedido.id, items });
    pedido.detalle = r.detalle;
    pedido.total = r.total;
    pedido.items = r.items;
    cerrarEdicion();

    /* Cambiar las cantidades cambia lo que el pedido tiene comprometido. */
    const faltaba = (r.recortados || []).map((x) => x.nombre);
    aviso(faltaba.length
      ? 'Pedido ' + pedido.id + ' actualizado, pero no alcanzaba el stock de ' + faltaba.join(', ')
      : 'Pedido ' + pedido.id + ' actualizado', faltaba.length ? 'error' : '');
    await recargarCatalogo();
    render();
  } catch (e) {
    if (e.codigo === 'SIN_AUTORIZACION') return;
    const err = $('#editar-error');
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    boton.disabled = false;
    boton.textContent = 'Guardar';
  }
}

/* ── Alta de productos ───────────────────────────────────────────────── */

/* Una fila vacía al pie: se completa y, al salir del campo, el producto se
   crea y aparece una fila vacía nueva. No hay botón de "agregar" porque la
   fila misma es la invitación. */
function renderFilaNueva() {
  const pie = $('#pie-alta');
  pie.innerHTML = '';

  const tr = document.createElement('tr');
  const borrador = {};
  const entradas = {};

  const campo = (nombre, tipo, marcador, clase) => {
    const td = celda(clase);
    const input = document.createElement('input');
    input.type = tipo;
    input.placeholder = marcador || '';
    input.setAttribute('aria-label', 'nuevo producto: ' + nombre);
    if (tipo === 'number') { input.step = '0.01'; input.min = '0'; }
    if (estado.columnas[nombre] === false) input.disabled = true;

    input.addEventListener('input', () => { borrador[nombre] = input.value; });
    input.addEventListener('change', () => { borrador[nombre] = input.value; intentarCrear(); });

    entradas[nombre] = input;
    td.appendChild(input);
    return td;
  };

  tr.appendChild(campo('codigo', 'text', 'Código', 'col-codigo'));
  tr.appendChild(campo('nombre', 'text', 'Nuevo producto…'));
  tr.appendChild(campo('categoria', 'text', '', 'col-texto'));
  tr.appendChild(campo('stock', 'number', '', 'col-num'));
  tr.appendChild(campo('costo', 'number', '', 'col-num'));
  tr.appendChild(campo('precio', 'number', '', 'col-num'));

  /* El margen de la fila nueva se muestra pero no se edita: sin producto
     todavía creado no hay nada que recalcular hacia atrás. */
  const tdMargen = celda('col-num derivado');
  const salidaMargen = document.createElement('input');
  salidaMargen.type = 'text';
  salidaMargen.readOnly = true;
  salidaMargen.tabIndex = -1;
  salidaMargen.setAttribute('aria-label', 'margen del nuevo producto');
  tdMargen.appendChild(salidaMargen);
  tr.appendChild(tdMargen);

  const pintar = () => {
    const costo = entradas.costo.value === '' ? null : Number(entradas.costo.value);
    const venta = entradas.precio.value === '' ? null : Number(entradas.precio.value);
    const m = margenDe(costo, venta);
    salidaMargen.value = m === null ? '' : (m * 100).toFixed(1);
  };
  entradas.costo.addEventListener('input', pintar);
  entradas.precio.addEventListener('input', pintar);

  tr.appendChild(celda('col-activo'));

  const tdEstado = celda('col-estado');
  const marca = document.createElement('div');
  marca.className = 'estado';
  tdEstado.appendChild(marca);
  tr.appendChild(tdEstado);

  let creando = false;

  async function intentarCrear() {
    if (creando) return;
    if (!String(borrador.nombre || '').trim()) {
      /* Con datos cargados pero sin nombre, se avisa en vez de perderlos. */
      if (Object.values(borrador).some((v) => String(v || '').trim())) {
        aviso('Falta el nombre del producto', 'error');
        entradas.nombre.focus();
      }
      return;
    }

    creando = true;
    marca.dataset.estado = 'guardando';
    try {
      const r = await api('crearProducto', { campos: borrador });
      estado.productos.push(r.producto);
      aviso(r.producto.nombre + ' agregado');
      render();                                   // redibuja e inserta una fila vacía nueva
      $('#pie-alta').querySelector('input').focus();
    } catch (e) {
      creando = false;
      if (e.codigo === 'SIN_AUTORIZACION') return;
      marca.dataset.estado = 'error';
      aviso(e.message, 'error');
      entradas.nombre.focus();
    }
  }

  pie.appendChild(tr);
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
    if (estado.vista === 'pedidos') estado.seleccion.clear();
    render();
  });

  $('#ver-inactivos').addEventListener('change', (e) => {
    estado.verInactivos = e.target.checked;
    render();
  });

  $('#solapa-productos').addEventListener('click', () => mostrarVista('productos'));
  $('#solapa-pedidos').addEventListener('click', () => mostrarVista('pedidos'));

  $('#seleccionar-todo').addEventListener('change', (e) => {
    const visibles = pedidosVisibles();
    if (e.target.checked) visibles.forEach((p) => estado.seleccion.add(p.id));
    else visibles.forEach((p) => estado.seleccion.delete(p.id));
    render();
  });

  $('#lote-entregar').addEventListener('click', () => operarLote('entregar'));
  $('#lote-cancelar').addEventListener('click', () => operarLote('cancelar'));
  $('#lote-deshacer').addEventListener('click', () => operarLote('deshacer'));
  $('#lote-limpiar').addEventListener('click', () => { estado.seleccion.clear(); render(); });

  $('#btn-agregar-item').addEventListener('click', agregarItemAlPedido);
  ['#agregar-nombre', '#agregar-cantidad'].forEach((sel) => {
    $(sel).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      agregarItemAlPedido();
    });
  });

  $('#btn-cancelar-edicion').addEventListener('click', cerrarEdicion);
  $('#btn-guardar-edicion').addEventListener('click', guardarEdicion);
  $('#velo').addEventListener('click', cerrarEdicion);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#dialogo-editar').hidden) cerrarEdicion();
  });

  $('#btn-recargar').addEventListener('click', () => {
    cargar();
    aviso(estado.vista === 'pedidos' ? 'Pedidos actualizados' : 'Catálogo recargado');
  });
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
  $('#tabla').addEventListener('keydown', (e) => {
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

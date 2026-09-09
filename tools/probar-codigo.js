#!/usr/bin/env node
/* Banco de pruebas de apps-script/Codigo.gs.
 *
 * Apps Script no se puede correr localmente, así que este archivo simula los
 * servicios que usa (SpreadsheetApp, PropertiesService, CacheService,
 * LockService, Utilities, UrlFetchApp) y ejercita el flujo completo contra una
 * planilla falsa. Sirve para verificar el mapeo de columnas, el correlativo de
 * ID, la idempotencia y —lo más importante— que la columna de status nunca se
 * pise.
 *
 *   node tools/probar-codigo.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.resolve(__dirname, '..');

/* ── Planilla falsa ──────────────────────────────────────────────────── */

class HojaFalsa {
  constructor(nombre, datos) {
    this.nombre = nombre;
    this.datos = datos;       // matriz de valores, incluida la fila de encabezados
    this.escrituras = [];     // registro de setValue para poder auditarlo
    this.copias = [];
  }
  getName() { return this.nombre; }
  _asegurarFila(f) {
    while (this.datos.length < f) {
      this.datos.push(new Array(this.datos[0] ? this.datos[0].length : 0).fill(''));
    }
  }
  getLastRow() {
    let ultima = 0;
    this.datos.forEach((fila, i) => {
      if (fila.some((v) => v !== '' && v !== null && v !== undefined)) ultima = i + 1;
    });
    return ultima;
  }
  getLastColumn() { return this.datos[0] ? this.datos[0].length : 0; }
  setFrozenRows() { return this; }
  clear() { this.datos = [[]]; this.formulas = {}; return this; }
  setColumnWidth() { return this; }
  insertColumnBefore(col) {
    this.datos.forEach((fila) => fila.splice(col - 1, 0, ''));
    return this;
  }
  insertRowBefore(fila) {
    const ancho = this.datos[0] ? this.datos[0].length : 0;
    this.datos.splice(fila - 1, 0, new Array(ancho).fill(''));
    return this;
  }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  getRange(fila, col, numFilas = 1, numCols = 1) {
    const hoja = this;
    /* Forma "B:B": solo se usa para dar formato, no hace falta simularla. */
    if (typeof fila === 'string') {
      return { setNumberFormat() { return this; }, setValues() { return this; },
               setFontWeight() { return this; }, setVerticalAlignment() { return this; },
               setWrapStrategy() { return this; }, getValues: () => [[]] };
    }
    return {
      getValues() {
        hoja._asegurarFila(fila + numFilas - 1);
        const salida = [];
        for (let f = 0; f < numFilas; f++) {
          const origen = hoja.datos[fila - 1 + f] || [];
          const linea = [];
          for (let c = 0; c < numCols; c++) linea.push(origen[col - 1 + c] ?? '');
          salida.push(linea);
        }
        return salida;
      },
      setValues(matriz) {
        hoja._asegurarFila(fila + matriz.length - 1);
        matriz.forEach((linea, f) => {
          linea.forEach((v, c) => {
            hoja.datos[fila - 1 + f][col - 1 + c] = v;
            hoja.escrituras.push({ fila: fila + f, col: col + c, valor: v });
          });
        });
        return this;
      },
      setFontWeight() { return this; },
      setNumberFormat() { return this; },
      setVerticalAlignment() { return this; },
      setWrapStrategy() { return this; },
      setFormula(f) {
        hoja.formulas = hoja.formulas || {};
        hoja.formulas[fila + ':' + col] = f;
        return this;
      },
      clearContent() {
        hoja._asegurarFila(fila);
        hoja.datos[fila - 1][col - 1] = '';
        return this;
      },
      getValue() {
        hoja._asegurarFila(fila);
        return hoja.datos[fila - 1][col - 1] ?? '';
      },
      setValue(v) {
        hoja._asegurarFila(fila);
        hoja.datos[fila - 1][col - 1] = v;
        hoja.escrituras.push({ fila, col, valor: v });
        return this;
      },
      copyTo(destino) { hoja.copias.push({ desde: { fila, col }, hacia: destino._pos }); },
      _pos: { fila, col },
    };
  }
}

class PlanillaFalsa {
  constructor(hojas) { this.hojas = hojas; }
  getName() { return 'Planilla de prueba'; }
  getSpreadsheetTimeZone() { return 'America/Argentina/Buenos_Aires'; }
  getSheetByName(n) { return this.hojas.find((h) => h.nombre === n) || null; }
  insertSheet(n) { const h = new HojaFalsa(n, [[]]); this.hojas.push(h); return h; }
  getId() { return this.id || 'planilla-activa'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.getId(); }
  getSheets() { return this.hojas; }
}

/* ── Contexto con los servicios simulados ────────────────────────────── */

function construirContexto({ hojas, respuestaToken }) {
  const planilla = new PlanillaFalsa(hojas);
  const creadas = [];
  const props = new Map();
  const cache = new Map();
  const registro = [];

  const ctx = {
    console,
    planilla,
    creadas,
    props,
    cache,
    registro,

    SpreadsheetApp: {
      getActiveSpreadsheet: () => planilla,
      flush: () => {},
      WrapStrategy: { WRAP: 'wrap' },
      create: (nombre) => {
        const nueva = new PlanillaFalsa([new HojaFalsa('Hoja 1', [[]])]);
        nueva.id = 'creada-' + nombre;
        creadas.push(nueva);
        return nueva;
      },
      openById: (id) => {
        const hallada = creadas.find((p) => p.getId() === id);
        if (!hallada) throw new Error('No existe: ' + id);
        return hallada;
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        deleteProperty: (k) => props.delete(k),
        getProperties: () => Object.fromEntries(props),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
        remove: (k) => cache.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ setMimeType: () => ({ getContent: () => t }) }),
    },
    Logger: { log: (...a) => registro.push(a.join(' ')) },
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => respuestaToken.codigo,
        getContentText: () => JSON.stringify(respuestaToken.cuerpo),
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_alg, texto) =>
        Array.from(crypto.createHash('sha256').update(texto, 'utf8').digest())
          .map((b) => (b > 127 ? b - 256 : b)),          // Apps Script devuelve bytes con signo
      getUuid: () => crypto.randomUUID(),
      base64DecodeWebSafe: (s) => Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      formatDate: (fecha, _zona, formato) => {
        const p = (n, l = 2) => String(n).padStart(l, '0');
        return formato
          .replace('yyyy', fecha.getFullYear())
          .replace('MM', p(fecha.getMonth() + 1))
          .replace('dd', p(fecha.getDate()))
          .replace('HH', p(fecha.getHours()))
          .replace('mm', p(fecha.getMinutes()));
      },
    },
  };

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'apps-script', 'Codigo.gs'), 'utf8'), ctx);
  /* CFG se declara con const, así que no queda como propiedad del contexto:
     para tocarlo desde las pruebas hay que evaluar dentro del VM. */
  ctx.evaluar = (fuente) => vm.runInContext(fuente, ctx);
  return ctx;
}

/* ── Datos de prueba ─────────────────────────────────────────────────── */

const jwt = (carga) =>
  'x.' + Buffer.from(JSON.stringify(carga)).toString('base64url') + '.y';

const CLIENT_ID = 'cliente-de-prueba.apps.googleusercontent.com';

const cargaValida = (email) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 3600,
  email,
  email_verified: true,
  name: 'Juana Pérez',
});

function hojasDePrueba() {
  return [
    /* Encabezados con acentos, mayúsculas y espacios: el mapeo debe resolverlos. */
    new HojaFalsa('Lista de Productos', [
      ['Producto', 'Categoría', 'Unidad', 'Activo'],
      ['Milanesa de soja', 'Congelados', 'x 6 u.', 'SI'],
      ['Pan integral', 'Panadería', '500 g', 'SI'],
      ['Queso vegano', 'Congelados', '200 g', 'NO'],
      ['Granola', 'Almacén', '1 kg', 'SI'],
      ['', '', '', ''],
    ]),
    new HojaFalsa('Pedidos', [
      ['ID', 'Fecha', 'Hora', 'Nombre', 'Detalle', 'Total', 'Status', 'Email'],
    ]),
    new HojaFalsa('Usuarios', [
      ['Email', 'Activo'],
      ['juana@ejemplo.com', 'SI'],
      ['exempleado@ejemplo.com', 'NO'],
    ]),
  ];
}

function nuevoEntorno(email = 'juana@ejemplo.com') {
  const hojas = hojasDePrueba();
  const ctx = construirContexto({
    hojas,
    respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(cargaValida(email)) } },
  });
  ctx.props.set('CLIENT_ID', CLIENT_ID);
  ctx.props.set('CLIENT_SECRET', 'secreto');
  return { ctx, hojas };
}

/* Las pruebas ubican las columnas por su encabezado: si mañana se inserta una
   columna nueva, no hay que renumerar cada aserción. */
const valorDe = (hoja, fila, titulo) => {
  const i = hoja.datos[0].findIndex((h) => String(h).toLowerCase() === titulo.toLowerCase());
  if (i < 0) throw new Error('No existe la columna "' + titulo + '" en ' + hoja.nombre);
  return hoja.datos[fila - 1][i];
};

const llamar = (ctx, cuerpo) =>
  JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(cuerpo) } }).getContent());

const login = (ctx) =>
  llamar(ctx, { accion: 'login', code: 'abc', code_verifier: 'v', redirect_uri: 'https://x/y/' });

/* ── Corrida ─────────────────────────────────────────────────────────── */

const ctx0 = nuevoEntorno().ctx;   // contexto suelto, para probar helpers

let ok = 0, fallas = 0;
function probar(nombre, fn) {
  try { fn(); console.log('  ✓ ' + nombre); ok++; }
  catch (e) { console.log('  ✗ ' + nombre + '\n      ' + e.message); fallas++; }
}
function afirmar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
}
const igual = (a, b, m) =>
  afirmar(JSON.stringify(a) === JSON.stringify(b),
    (m || '') + '\n      esperado: ' + JSON.stringify(b) + '\n      obtenido: ' + JSON.stringify(a));

console.log('\nAutenticación');

probar('un email de la allowlist recibe token', () => {
  const { ctx } = nuevoEntorno();
  const r = login(ctx);
  afirmar(r.ok === true, 'debería autorizar: ' + r.error);
  afirmar(typeof r.token === 'string' && r.token.length > 30, 'token ausente o corto');
  afirmar(/^\d{6}$/.test(r.codigoVinculacion), 'falta el código de vinculación');
});

probar('un email fuera de la allowlist es rechazado', () => {
  const { ctx } = nuevoEntorno('intruso@ejemplo.com');
  const r = login(ctx);
  igual([r.ok, r.codigo], [false, 'SIN_AUTORIZACION'], 'debería rechazar');
});

probar('un usuario marcado como inactivo es rechazado', () => {
  const { ctx } = nuevoEntorno('exempleado@ejemplo.com');
  igual(login(ctx).codigo, 'SIN_AUTORIZACION', 'el inactivo no debería entrar');
});

probar('un id_token de otra aplicación es rechazado', () => {
  const hojas = hojasDePrueba();
  const carga = cargaValida('juana@ejemplo.com');
  carga.aud = 'otra-app.apps.googleusercontent.com';
  const ctx = construirContexto({ hojas, respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(carga) } } });
  ctx.props.set('CLIENT_ID', CLIENT_ID);
  ctx.props.set('CLIENT_SECRET', 'secreto');
  igual(login(ctx).codigo, 'LOGIN_FALLIDO', 'no debería aceptar otro aud');
});

probar('sin token no se puede leer el catálogo', () => {
  const { ctx } = nuevoEntorno();
  igual(llamar(ctx, { accion: 'productos', token: '' }).codigo, 'SIN_AUTORIZACION');
});

probar('un token inventado es rechazado', () => {
  const { ctx } = nuevoEntorno();
  igual(llamar(ctx, { accion: 'productos', token: 'a'.repeat(64) }).codigo, 'SIN_AUTORIZACION');
});

probar('el código de vinculación entrega la misma sesión', () => {
  const { ctx } = nuevoEntorno();
  const r = login(ctx);
  const v = llamar(ctx, { accion: 'vincular', codigo: r.codigoVinculacion });
  igual([v.ok, v.token, v.email], [true, r.token, 'juana@ejemplo.com']);
  igual(llamar(ctx, { accion: 'vincular', codigo: r.codigoVinculacion }).codigo, 'CODIGO_INVALIDO',
    'el código debería ser de un solo uso');
});

probar('sacar a alguien de la allowlist invalida su sesión', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  afirmar(llamar(ctx, { accion: 'productos', token }).ok, 'debería funcionar antes');
  hojas[2].datos[1][1] = 'NO';        // se lo marca inactivo
  ctx.cache.clear();                  // vence el caché de la allowlist
  igual(llamar(ctx, { accion: 'productos', token }).codigo, 'SIN_AUTORIZACION');
});

console.log('\nCatálogo');

probar('lee productos activos y resuelve encabezados con acentos', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  const r = llamar(ctx, { accion: 'productos', token });
  igual(r.productos.map((p) => p.nombre), ['Milanesa de soja', 'Pan integral', 'Granola'],
    'debería omitir el inactivo y la fila vacía');
  igual(r.productos[0].categoria, 'Congelados');
  igual(r.productos[0].unidad, 'x 6 u.');
});

probar('los ids son estables y no dependen del número de fila', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  const antes = llamar(ctx, { accion: 'productos', token }).productos;
  const fila = hojas[0].datos.splice(2, 1)[0];       // se mueve "Pan integral" al final
  hojas[0].datos.splice(4, 0, fila);
  const despues = llamar(ctx, { accion: 'productos', token }).productos;
  const buscar = (lista, n) => lista.find((p) => p.nombre === n).id;
  igual(buscar(antes, 'Pan integral'), buscar(despues, 'Pan integral'),
    'el id no debería cambiar al reordenar');
});

probar('una columna Activo vacía no vacía el catálogo', () => {
  const hojas = hojasDePrueba();
  hojas[0] = new HojaFalsa('Lista de Productos', [
    ['NOMBRES', 'Categoria', 'Unidad', 'Activo', 'Orden'],
    ['Almendras', '', '', '', ''],
    ['Nuez pecán', '', '', '', ''],
  ]);
  const ctx = construirContexto({
    hojas, respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(cargaValida('juana@ejemplo.com')) } },
  });
  ctx.props.set('CLIENT_ID', CLIENT_ID);
  ctx.props.set('CLIENT_SECRET', 'secreto');
  const token = login(ctx).token;
  igual(llamar(ctx, { accion: 'productos', token }).productos.map((p) => p.nombre),
    ['Almendras', 'Nuez pecán'], 'sin valores cargados la columna debería ignorarse');
});

probar('con un solo valor cargado, la columna Activo pasa a mandar', () => {
  const hojas = hojasDePrueba();
  hojas[0] = new HojaFalsa('Lista de Productos', [
    ['NOMBRES', 'Categoria', 'Unidad', 'Activo', 'Orden'],
    ['Almendras', '', '', 'SI', ''],
    ['Nuez pecán', '', '', '', ''],
    ['Pasas', '', '', 'NO', ''],
  ]);
  const ctx = construirContexto({
    hojas, respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(cargaValida('juana@ejemplo.com')) } },
  });
  ctx.props.set('CLIENT_ID', CLIENT_ID);
  ctx.props.set('CLIENT_SECRET', 'secreto');
  const token = login(ctx).token;
  igual(llamar(ctx, { accion: 'productos', token }).productos.map((p) => p.nombre),
    ['Almendras'], 'las filas en blanco quedan afuera');
});

console.log('\nStock en los pedidos');

probar('el catálogo de la app informa el stock', () => {
  const { ctx } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  const productos = llamar(ctx, { accion: 'productos', token }).productos;

  igual(productos.map((p) => [p.nombre, p.stock]),
    [['Almendras', 12], ['Nuez pecán', 0]],
    'el agotado sigue en el listado, con stock 0');
});

probar('sin columna de stock, el stock viaja en null', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  igual(llamar(ctx, { accion: 'productos', token }).productos[0].stock, null,
    'null significa sin seguimiento, no agotado');
});

probar('rechaza pedir más de lo que hay', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  const productos = llamar(ctx, { accion: 'productos', token }).productos;

  const r = llamar(ctx, {
    accion: 'pedido', token, nombre: 'Gimena', clave: 'k1',
    items: [{ id: productos[0].id, cantidad: 20 }],       // hay 12
  });
  igual(r.codigo, 'SIN_STOCK');
  afirmar(/quedan 12/.test(r.error), 'debería decir cuántos quedan: ' + r.error);
  igual(hojas[1].getLastRow(), 1, 'no debería haber escrito el pedido');
});

probar('rechaza pedir algo agotado, con otro mensaje', () => {
  const { ctx } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  const productos = llamar(ctx, { accion: 'productos', token }).productos;

  const r = llamar(ctx, {
    accion: 'pedido', token, nombre: 'Gimena', clave: 'k1',
    items: [{ id: productos[1].id, cantidad: 1 }],        // Nuez pecán, stock 0
  });
  igual(r.codigo, 'SIN_STOCK');
  afirmar(/Ya no queda stock/.test(r.error), r.error);
});

probar('pedir exactamente el stock disponible se acepta', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  const productos = llamar(ctx, { accion: 'productos', token }).productos;

  const r = llamar(ctx, {
    accion: 'pedido', token, nombre: 'Gimena', clave: 'k1',
    items: [{ id: productos[0].id, cantidad: 12 }],
  });
  afirmar(r.ok, r.error);
  igual(valorDe(hojas[1], 2, 'Detalle'), 'Almendras x12');
});

probar('sin seguimiento de stock no hay tope', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  afirmar(llamar(ctx, {
    accion: 'pedido', token, nombre: 'Gimena', clave: 'k1',
    items: [{ id: productos[0].id, cantidad: 500 }],
  }).ok, 'sin columna de stock debería dejar pedir cualquier cantidad');
});

console.log('\nAlta de pedidos');

const pedidoDe = (ctx, token, nombre, clave) => {
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  return llamar(ctx, {
    accion: 'pedido', token, nombre, clave,
    items: [
      { id: productos[0].id, nombre: productos[0].nombre, cantidad: 3 },
      { id: productos[1].id, nombre: productos[1].nombre, cantidad: 2 },
    ],
  });
};

probar('escribe la fila con todos los campos', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  const r = pedidoDe(ctx, token, 'Juana', 'k1');
  afirmar(r.ok, r.error);
  igual(r.id, 'P-0001');

  const fila = hojas[1].datos[1];
  igual(fila[0], 'P-0001', 'ID');
  /* instanceof no sirve: el objeto viene del realm del VM. */
  afirmar(Object.prototype.toString.call(fila[1]) === '[object Date]',
    'la fecha debería ser una fecha real, no texto; vino: ' + typeof fila[1]);
  afirmar(!isNaN(fila[1].getTime()), 'la fecha es inválida');
  afirmar(/^\d{2}:\d{2}$/.test(fila[2]), 'la hora debería tener formato HH:mm, vino: ' + fila[2]);
  igual(fila[3], 'Juana', 'nombre');
  igual(fila[4], 'Milanesa de soja x3; Pan integral x2', 'detalle concatenado');
  igual(fila[5], 5, 'total de unidades');
  igual(fila[7], 'juana@ejemplo.com', 'email de quien cargó');
});

probar('deja el status en Pendiente', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Juana', 'k1');
  igual(hojas[1].datos[1][6], 'Pendiente', 'el proceso de etiquetas lo actualiza después');
});

probar('en modo auto no toca la columna de status', () => {
  const { ctx, hojas } = nuevoEntorno();
  ctx.evaluar("CFG.MODO_STATUS = 'auto'");
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Juana', 'k1');

  const colStatus = 7;   // 1-based: "Status" es la séptima columna
  afirmar(!hojas[1].escrituras.some((e) => e.col === colStatus),
    'el script escribió sobre la columna de status');
  igual(hojas[1].datos[1][6], '', 'la celda debería quedar libre para el ARRAYFORMULA');
});

probar('avisa si falta la columna de status', () => {
  const { ctx, hojas } = nuevoEntorno();
  hojas[1].datos[0] = ['ID', 'Fecha', 'Hora', 'Nombre', 'Detalle', 'Total', 'Email'];
  const token = login(ctx).token;
  const r = pedidoDe(ctx, token, 'Juana', 'k1');
  igual(r.codigo, 'SIN_CONFIG', 'debería avisar en vez de guardar sin status');
});

probar('el correlativo avanza entre pedidos', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  igual(pedidoDe(ctx, token, 'Juana', 'k1').id, 'P-0001');
  igual(pedidoDe(ctx, token, 'Pedro', 'k2').id, 'P-0002');
  igual(pedidoDe(ctx, token, 'Ana', 'k3').id, 'P-0003');
});

probar('el correlativo continúa desde filas preexistentes', () => {
  const { ctx, hojas } = nuevoEntorno();
  hojas[1].datos.push(['P-0041', new Date(), '10:00', 'Previo', 'Algo x1', 1, 'listo', 'x@y.com']);
  const token = login(ctx).token;
  igual(pedidoDe(ctx, token, 'Juana', 'k1').id, 'P-0042');
});

probar('reenviar con la misma clave no duplica la fila', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  const primero = pedidoDe(ctx, token, 'Juana', 'clave-repetida');
  const segundo = pedidoDe(ctx, token, 'Juana', 'clave-repetida');
  igual(segundo.id, primero.id, 'debería devolver el mismo pedido');
  afirmar(segundo.repetido === true, 'debería marcarse como repetido');
  igual(hojas[1].getLastRow(), 2, 'tendría que haber una sola fila de datos');
});

probar('el nombre del producto se toma del catálogo, no del cliente', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  llamar(ctx, {
    accion: 'pedido', token, nombre: 'Juana', clave: 'k9',
    items: [{ id: productos[0].id, nombre: 'NOMBRE FALSIFICADO', cantidad: 1 }],
  });
  igual(hojas[1].datos[1][4], 'Milanesa de soja x1', 'debería ignorar el nombre mandado por el cliente');
});

probar('rechaza pedidos vacíos, sin nombre y con cantidades inválidas', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  const base = { accion: 'pedido', token, nombre: 'Juana', clave: 'k' };

  igual(llamar(ctx, { ...base, items: [] }).codigo, 'DATOS_INVALIDOS', 'pedido vacío');
  igual(llamar(ctx, { ...base, nombre: '  ', items: [{ id: productos[0].id, cantidad: 1 }] }).codigo,
    'DATOS_INVALIDOS', 'sin nombre');
  igual(llamar(ctx, { ...base, items: [{ id: productos[0].id, cantidad: 0 }] }).codigo,
    'DATOS_INVALIDOS', 'cantidad cero');
  igual(llamar(ctx, { ...base, items: [{ id: productos[0].id, cantidad: 5000 }] }).codigo,
    'DATOS_INVALIDOS', 'cantidad excesiva');
  igual(llamar(ctx, { ...base, items: [{ id: 'no-existe', cantidad: 1 }] }).codigo,
    'DATOS_INVALIDOS', 'producto inexistente');
});

probar('sin clave de idempotencia se rechaza', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  igual(llamar(ctx, {
    accion: 'pedido', token, nombre: 'Juana',
    items: [{ id: productos[0].id, cantidad: 1 }],
  }).codigo, 'DATOS_INVALIDOS');
});

console.log('\nConfiguración');

probar('avisa con claridad si falta una solapa', () => {
  const hojas = hojasDePrueba().filter((h) => h.nombre !== 'Pedidos');
  const ctx = construirContexto({
    hojas, respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(cargaValida('juana@ejemplo.com')) } },
  });
  ctx.props.set('CLIENT_ID', CLIENT_ID);
  ctx.props.set('CLIENT_SECRET', 'secreto');
  const token = login(ctx).token;
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  const r = llamar(ctx, {
    accion: 'pedido', token, nombre: 'Juana', clave: 'k1',
    items: [{ id: productos[0].id, cantidad: 1 }],
  });
  igual(r.codigo, 'SIN_CONFIG');
  afirmar(/No existe la solapa "Pedidos"/.test(r.error), 'el mensaje debería nombrar la solapa: ' + r.error);
});

probar('falla si no están cargadas las credenciales', () => {
  const hojas = hojasDePrueba();
  const ctx = construirContexto({
    hojas, respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(cargaValida('juana@ejemplo.com')) } },
  });
  igual(login(ctx).codigo, 'SIN_CONFIG');
});

probar('el modo copiar arrastra la fórmula de status', () => {
  const { ctx, hojas } = nuevoEntorno();
  ctx.evaluar("CFG.MODO_STATUS = 'copiar'");
  hojas[1].datos.push(['P-0001', new Date(), '10:00', 'Previo', 'Algo x1', 1, 'calculado', 'x@y.com']);
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Juana', 'k1');
  igual(hojas[1].copias.length, 1, 'debería haber copiado la fórmula');
  igual(hojas[1].copias[0], { desde: { fila: 2, col: 7 }, hacia: { fila: 3, col: 7 } });
});

console.log('\nPreparación de la planilla');

/* Reproduce la planilla real: catálogo de una sola columna, solapa de pedidos
   vacía y emails cargados desde la fila 1, sin encabezado. */
function entornoCrudo() {
  const hojas = [
    new HojaFalsa('Lista de Productos', [
      ['NOMBRES'], ['Almendras'], ['Nuez pecán'], [''], ['Pasas de uva'],
    ]),
    new HojaFalsa('Pedidos', [[]]),
    new HojaFalsa('Usuarios', [['gimena@ahrensasoc.com'], ['phinger@gmail.com']]),
  ];
  const ctx = construirContexto({
    hojas, respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(cargaValida('phinger@gmail.com')) } },
  });
  ctx.props.set('CLIENT_ID', CLIENT_ID);
  ctx.props.set('CLIENT_SECRET', 'secreto');
  return { ctx, hojas };
}

probar('sin preparar, los emails sueltos dejan a todos afuera', () => {
  const { ctx } = entornoCrudo();
  igual(login(ctx).codigo, 'SIN_CONFIG', 'debería avisar que falta la columna email');
});

probar('prepararPlanilla arma los encabezados de Pedidos', () => {
  const { ctx, hojas } = entornoCrudo();
  ctx.prepararPlanilla();
  igual(hojas[1].datos[0],
    ['ID', 'Fecha', 'Hora', 'Nombre', 'Detalle', 'Total', 'Status', 'Email']);
});

probar('prepararPlanilla corrige Usuarios sin dejar a nadie afuera', () => {
  const { ctx, hojas } = entornoCrudo();
  ctx.prepararPlanilla();
  igual(hojas[2].datos[0], ['Email', 'Activo'], 'fila de encabezados');
  igual(hojas[2].datos[1], ['gimena@ahrensasoc.com', 'SI'], 'el email que ya estaba queda activo');
  igual(hojas[2].datos[2], ['phinger@gmail.com', 'SI']);
  afirmar(login(ctx).ok, 'después de preparar, el login debería funcionar');
});

probar('el catálogo de una sola columna se lee igual', () => {
  const { ctx } = entornoCrudo();
  ctx.prepararPlanilla();
  const token = login(ctx).token;
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  igual(productos.map((p) => p.nombre), ['Almendras', 'Nuez pecán', 'Pasas de uva'],
    'debería saltear la fila vacía');
  igual(productos[0].categoria, '', 'sin columna de categoría queda vacía');
});

probar('el pedido entra bien en la solapa recién preparada', () => {
  const { ctx, hojas } = entornoCrudo();
  ctx.prepararPlanilla();
  const token = login(ctx).token;
  const r = pedidoDe(ctx, token, 'Gimena', 'k1');
  igual(r.id, 'P-0001');
  igual(hojas[1].datos[1][4], 'Almendras x3; Nuez pecán x2');
  igual(hojas[1].datos[1][6], 'Pendiente', 'el status arranca en Pendiente');
});

probar('prepararPlanilla se puede correr dos veces sin romper nada', () => {
  const { ctx, hojas } = entornoCrudo();
  ctx.prepararPlanilla();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  ctx.prepararPlanilla();
  igual(hojas[2].datos[0], ['Email', 'Activo'], 'no debería duplicar encabezados');
  igual(hojas[1].getLastRow(), 2, 'no debería tocar los pedidos ya cargados');
  afirmar(llamar(ctx, { accion: 'productos', token }).ok, 'la sesión sigue viva');
});

console.log('\nCatálogo (stock y precios)');

/* Planilla con las columnas comerciales ya cargadas. */
function entornoCatalogo() {
  const hojas = hojasDePrueba();
  hojas[0] = new HojaFalsa('Lista de Productos', [
    ['NOMBRES', 'Categoría', 'Unidad', 'Activo', 'Stock', 'Costo', 'Precio'],
    ['Almendras',  'Almacén',    '1 kg',  'SI', 12, 1000, 1800],
    ['Nuez pecán', 'Almacén',    '500 g', 'SI',  0,  2000, 3000],
    ['Tofu',       'Frescos',    '400 g', 'NO',  5,  800,  1200],
  ]);
  const ctx = construirContexto({
    hojas, respuestaToken: { codigo: 200, cuerpo: { id_token: jwt(cargaValida('juana@ejemplo.com')) } },
  });
  ctx.props.set('CLIENT_ID', CLIENT_ID);
  ctx.props.set('CLIENT_SECRET', 'secreto');
  return { ctx, hojas };
}

probar('devuelve el catálogo completo, inactivos incluidos', () => {
  const { ctx } = entornoCatalogo();
  const token = login(ctx).token;
  const r = llamar(ctx, { accion: 'catalogo', token });

  igual(r.productos.length, 3, 'el inactivo también tiene que venir');
  igual(r.productos[0], {
    fila: 2, codigo: '', nombre: 'Almendras', categoria: 'Almacén', unidad: '1 kg',
    activo: true, orden: null, stock: 12, costo: 1000, precio: 1800,
  });
  igual(r.productos[2].activo, false, 'Tofu está inactivo');
  igual(r.columnas.stock, true, 'debería informar qué columnas existen');
  igual(r.columnas.orden, false, 'esta planilla no tiene columna de orden');
});

probar('crea las columnas comerciales si no están', () => {
  const { ctx, hojas } = nuevoEntorno();     // catálogo sin stock ni precios
  const token = login(ctx).token;
  const r = llamar(ctx, { accion: 'catalogo', token });

  igual(hojas[0].datos[0].slice(-3), ['Stock', 'Costo', 'Precio'],
    'debería haberlas agregado al final');
  igual(r.columnas.costo, true);
  igual(r.productos[0].costo, null, 'sin valor cargado viene en null');
});

probar('guarda stock, costo y precio', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  const r = llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 2, nombreOriginal: 'Almendras',
    campos: { stock: 20, costo: 1100, precio: '2200' },
  });
  afirmar(r.ok, r.error);
  igual([valorDe(hojas[0], 2, 'Stock'), valorDe(hojas[0], 2, 'Costo'), valorDe(hojas[0], 2, 'Precio')],
    [20, 1100, 2200]);
});

probar('guarda el nombre y lo deja como nueva referencia', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 2, nombreOriginal: 'Almendras', campos: { nombre: 'Almendras tostadas' },
  });
  igual(valorDe(hojas[0], 2, 'NOMBRES'), 'Almendras tostadas');

  /* El segundo guardado tiene que ir con el nombre nuevo. */
  igual(llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 2, nombreOriginal: 'Almendras', campos: { stock: 1 },
  }).codigo, 'CONFLICTO', 'con el nombre viejo debería rechazar');

  afirmar(llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 2, nombreOriginal: 'Almendras tostadas', campos: { stock: 1 },
  }).ok, 'con el nombre nuevo debería aceptar');
});

probar('rechaza escribir sobre una fila que cambió', () => {
  const { ctx } = entornoCatalogo();
  const token = login(ctx).token;
  const r = llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 2, nombreOriginal: 'Otra cosa', campos: { stock: 5 },
  });
  igual(r.codigo, 'CONFLICTO');
  afirmar(/Actualizá la página/.test(r.error), 'el mensaje debería decir qué hacer');
});

probar('rechaza números inválidos y nombre vacío', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  const base = { accion: 'guardarProducto', token, fila: 2, nombreOriginal: 'Almendras' };

  igual(llamar(ctx, { ...base, campos: { stock: -3 } }).codigo, 'DATOS_INVALIDOS', 'stock negativo');
  igual(llamar(ctx, { ...base, campos: { costo: 'gratis' } }).codigo, 'DATOS_INVALIDOS', 'texto');
  igual(llamar(ctx, { ...base, campos: { nombre: '   ' } }).codigo, 'DATOS_INVALIDOS', 'nombre vacío');
  igual(valorDe(hojas[0], 2, 'Stock'), 12, 'nada de eso debería haber tocado la planilla');
});

probar('vaciar una celda numérica la deja vacía, no en cero', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 2, nombreOriginal: 'Almendras', campos: { costo: '' },
  });
  igual(valorDe(hojas[0], 2, 'Costo'), '', 'sin costo no es lo mismo que costo cero');
});

probar('activar y desactivar saca al producto del listado de pedidos', () => {
  const { ctx } = entornoCatalogo();
  const token = login(ctx).token;
  const nombres = () => llamar(ctx, { accion: 'productos', token }).productos.map((p) => p.nombre);

  igual(nombres(), ['Almendras', 'Nuez pecán'], 'Tofu está inactivo');
  llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 4, nombreOriginal: 'Tofu', campos: { activo: true },
  });
  igual(nombres(), ['Almendras', 'Nuez pecán', 'Tofu'], 'al activarlo debería aparecer');
});

probar('sin sesión no se puede leer ni escribir el catálogo', () => {
  const { ctx } = entornoCatalogo();
  igual(llamar(ctx, { accion: 'catalogo', token: '' }).codigo, 'SIN_AUTORIZACION');
  igual(llamar(ctx, {
    accion: 'guardarProducto', token: 'x'.repeat(64),
    fila: 2, nombreOriginal: 'Almendras', campos: { costo: 1 },
  }).codigo, 'SIN_AUTORIZACION');
});

probar('inserta la columna de código antes del nombre', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });

  igual(hojas[0].datos[0].slice(0, 2), ['Código', 'NOMBRES'],
    'el código va antes del nombre, no al final');
  igual(hojas[0].datos[1].slice(0, 2), ['', 'Almendras'],
    'los datos de la fila se corren con la columna');
  igual([valorDe(hojas[0], 2, 'Stock'), valorDe(hojas[0], 2, 'Costo'), valorDe(hojas[0], 2, 'Precio')],
    [12, 1000, 1800], 'stock, costo y precio siguen en su lugar');
});

probar('con código cargado, el id del producto sale del código', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  hojas[0].datos[1][0] = 'ALM-01';           // la columna Código quedó primera

  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  igual(productos[0].id, 'alm01', 'el id deriva del código');
  igual(productos[0].codigo, 'ALM-01');
  afirmar(productos[1].id.length > 0, 'sin código sigue derivando del nombre');
});

probar('renombrar no cambia el id si hay código', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  hojas[0].datos[1][0] = 'ALM-01';           // la columna Código quedó primera

  const antes = llamar(ctx, { accion: 'productos', token }).productos[0].id;
  llamar(ctx, {
    accion: 'guardarProducto', token,
    fila: 2, nombreOriginal: 'Almendras', campos: { nombre: 'Almendras peladas' },
  });
  igual(llamar(ctx, { accion: 'productos', token }).productos[0].id, antes,
    'el id tiene que sobrevivir al cambio de nombre');
});

console.log('\nAlta de productos');

probar('crea un producto al final del catálogo', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });

  const r = llamar(ctx, {
    accion: 'crearProducto', token,
    campos: { codigo: 'MIE-01', nombre: 'Miel', categoria: 'Almacén', stock: 6, costo: 500, precio: 900 },
  });
  afirmar(r.ok, r.error);
  igual(r.producto.fila, 5);
  igual(hojas[0].datos[4], ['MIE-01', 'Miel', 'Almacén', '', 'SI', 6, 500, 900]);
  igual(valorDe(hojas[0], 5, 'Precio'), 900);
});

probar('el producto nuevo nace activo y aparece en los pedidos', () => {
  const { ctx } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  llamar(ctx, { accion: 'crearProducto', token, campos: { nombre: 'Miel' } });

  const nombres = llamar(ctx, { accion: 'productos', token }).productos.map((p) => p.nombre);
  afirmar(nombres.indexOf('Miel') >= 0, 'debería estar disponible para pedir: ' + nombres);
});

probar('sin nombre no se crea nada', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  const filasAntes = hojas[0].getLastRow();

  igual(llamar(ctx, { accion: 'crearProducto', token, campos: { codigo: 'X-1', stock: 3 } }).codigo,
    'DATOS_INVALIDOS');
  igual(hojas[0].getLastRow(), filasAntes, 'no debería haber escrito la fila');
});

probar('rechaza un código repetido', () => {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  hojas[0].datos[1][0] = 'ALM-01';           // la columna Código quedó primera

  const r = llamar(ctx, { accion: 'crearProducto', token, campos: { codigo: 'alm-01', nombre: 'Otra cosa' } });
  igual(r.codigo, 'DATOS_INVALIDOS');
  afirmar(/ya hay un producto con el código/i.test(r.error), r.error);
});

probar('crear sin sesión válida se rechaza', () => {
  const { ctx } = entornoCatalogo();
  igual(llamar(ctx, { accion: 'crearProducto', token: '', campos: { nombre: 'Miel' } }).codigo,
    'SIN_AUTORIZACION');
});

console.log('\nEtiquetas');

probar('crea la solapa apuntando a las columnas correctas', () => {
  const { ctx, hojas } = nuevoEntorno();
  ctx.prepararEtiquetas();

  const etiquetas = hojas.find((h) => h.nombre === 'Etiquetas');
  afirmar(etiquetas, 'debería haber creado la solapa Etiquetas');
  igual(etiquetas.datos[0], ['Nombre', 'Detalle']);

  const formula = etiquetas.formulas['2:1'];
  afirmar(formula.indexOf("'Pedidos'!D2:D") >= 0, 'debería leer Nombre de la columna D: ' + formula);
  afirmar(formula.indexOf("'Pedidos'!E2:E") >= 0, 'debería leer Detalle de la columna E');
  afirmar(formula.indexOf("'Pedidos'!G2:G") >= 0, 'debería filtrar por la columna G (Status)');
  afirmar(formula.indexOf('="Pendiente"') >= 0, 'debería filtrar por Pendiente');
  afirmar(formula.indexOf('CHAR(10)') >= 0, 'debería partir el detalle en renglones');
});

probar('sigue las columnas aunque estén en otro orden', () => {
  const { ctx, hojas } = nuevoEntorno();
  hojas[1].datos[0] = ['Status', 'ID', 'Fecha', 'Hora', 'Detalle', 'Nombre', 'Total', 'Email'];
  ctx.prepararEtiquetas();

  const formula = hojas.find((h) => h.nombre === 'Etiquetas').formulas['2:1'];
  afirmar(formula.indexOf("'Pedidos'!F2:F") >= 0, 'Nombre está ahora en F: ' + formula);
  afirmar(formula.indexOf("'Pedidos'!E2:E") >= 0, 'Detalle sigue en E');
  afirmar(formula.indexOf("'Pedidos'!A2:A") >= 0, 'Status está ahora en A');
});

probar('rehacerla no duplica la solapa', () => {
  const { ctx, hojas } = nuevoEntorno();
  ctx.prepararEtiquetas();
  ctx.prepararEtiquetas();
  igual(hojas.filter((h) => h.nombre === 'Etiquetas').length, 1);
});

probar('avisa si falta la columna de status', () => {
  const { ctx, hojas } = nuevoEntorno();
  hojas[1].datos[0] = ['ID', 'Fecha', 'Hora', 'Nombre', 'Detalle', 'Total', 'Email'];
  let mensaje = '';
  try { ctx.prepararEtiquetas(); } catch (e) { mensaje = e.message; }
  afirmar(/status/.test(mensaje), 'debería explicar qué columna falta: ' + mensaje);
});

probar('las letras de columna se calculan bien más allá de la Z', () => {
  igual([0, 25, 26, 27, 51, 52].map(ctx0._letraColumna), ['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
});

probar('exporta los pendientes y los pasa a Impreso', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  pedidoDe(ctx, token, 'Marcelo', 'k2');
  hojas[1].datos[2][6] = 'Listo';        // el segundo ya no está pendiente

  const r = ctx._exportarEtiquetas();
  igual(r.cantidad, 1);
  igual(r.ids, ['P-0001']);

  const hoja = ctx.creadas[0].getSheets()[0];
  igual(hoja.datos[0], ['Nombre', 'Detalle']);
  igual(hoja.datos[1][0], 'Gimena');
  igual(hoja.datos[1][1], 'Milanesa de soja x3\nPan integral x2',
    'el detalle debería venir en renglones');

  igual(hojas[1].datos[1][6], 'Impreso', 'el status debería haber cambiado');
  igual(hojas[1].datos[2][6], 'Listo', 'el otro pedido no se toca');
  igual(hojas[1].datos[1].length, 8, 'no debería agregar ninguna columna');
});

probar('exportar de nuevo no reimprime lo ya impreso', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');

  igual(ctx._exportarEtiquetas().cantidad, 1, 'primera corrida');
  igual(ctx._exportarEtiquetas().cantidad, 0, 'segunda corrida: nada nuevo');
  igual(ctx.creadas[0].getSheets()[0].getLastRow(), 1, 'el archivo queda con solo encabezados');

  pedidoDe(ctx, token, 'Marcelo', 'k2');
  const tercera = ctx._exportarEtiquetas();
  igual(tercera.cantidad, 1, 'tercera corrida: solo el pedido nuevo');
  igual(ctx.creadas[0].getSheets()[0].datos[1][0], 'Marcelo');
});

probar('deshacer devuelve el lote al estado pendiente', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');

  ctx._exportarEtiquetas();
  igual(hojas[1].datos[1][6], 'Impreso');

  igual(ctx._deshacerUltimoLote().cantidad, 1);
  igual(hojas[1].datos[1][6], 'Pendiente', 'debería volver a pendiente');
  igual(ctx._exportarEtiquetas().cantidad, 1, 'y volver a salir en la próxima');
});

probar('deshacer dos veces no rompe nada', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  ctx._exportarEtiquetas();
  ctx._deshacerUltimoLote();
  igual(ctx._deshacerUltimoLote(), { ok: true, cantidad: 0, vacio: true });
});

probar('deshacer no toca una fila cuyo ID ya no coincide', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  ctx._exportarEtiquetas();
  hojas[1].datos[1][0] = 'P-9999';        // alguien reordenó las filas
  igual(ctx._deshacerUltimoLote().cantidad, 0, 'no debería tocar nada');
  igual(hojas[1].datos[1][6], 'Impreso', 'el status queda como estaba');
});

probar('exportar dos veces reutiliza el mismo archivo', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  const primera = ctx._exportarEtiquetas().url;
  const segunda = ctx._exportarEtiquetas().url;
  igual(segunda, primera, 'el enlace no debería cambiar');
  igual(ctx.creadas.length, 1, 'no debería crear un archivo por corrida');
});

probar('la app puede generar etiquetas con su sesión', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');

  const r = llamar(ctx, { accion: 'etiquetas', token });
  igual([r.ok, r.cantidad], [true, 1]);
  afirmar(r.url, 'debería devolver el enlace del archivo');
  igual(hojas[1].datos[1][6], 'Impreso');

  igual(llamar(ctx, { accion: 'deshacer', token }).cantidad, 1);
  igual(hojas[1].datos[1][6], 'Pendiente');
});

probar('generar etiquetas sin sesión válida se rechaza', () => {
  const { ctx } = nuevoEntorno();
  igual(llamar(ctx, { accion: 'etiquetas', token: '' }).codigo, 'SIN_AUTORIZACION');
  igual(llamar(ctx, { accion: 'deshacer', token: 'x'.repeat(64) }).codigo, 'SIN_AUTORIZACION');
});

probar('la vista viva filtra solo por status', () => {
  const { ctx, hojas } = nuevoEntorno();
  ctx.prepararEtiquetas();
  const formula = hojas.find((h) => h.nombre === 'Etiquetas').formulas['2:1'];
  afirmar(formula.indexOf('="Pendiente"') >= 0, 'debería filtrar por Pendiente: ' + formula);
  afirmar(formula.indexOf('I2:I') < 0, 'ya no debería mirar ninguna columna extra');
});

console.log('\nPedidos: listado y estados');

/* Un pedido cargado sobre el entorno de catálogo, listo para operar. */
function conPedido(cantidad = 3) {
  const { ctx, hojas } = entornoCatalogo();
  const token = login(ctx).token;
  llamar(ctx, { accion: 'catalogo', token });
  const productos = llamar(ctx, { accion: 'productos', token }).productos;
  llamar(ctx, {
    accion: 'pedido', token, nombre: 'Gimena', clave: 'k1',
    items: [{ id: productos[0].id, cantidad }],
  });
  return { ctx, hojas, token };
}

const stockDe = (hojas, nombre) => {
  const f = hojas[0].datos.findIndex((fila) => fila[1] === nombre);
  return valorDe(hojas[0], f + 1, 'Stock');
};

probar('lista los pedidos con su detalle desarmado', () => {
  const { ctx, token } = conPedido();
  const r = llamar(ctx, { accion: 'pedidos', token });

  igual(r.pedidos.length, 1);
  igual(r.pedidos[0].id, 'P-0001');
  igual(r.pedidos[0].nombre, 'Gimena');
  igual(r.pedidos[0].status, 'Pendiente');
  igual(r.pedidos[0].items, [{ nombre: 'Almendras', cantidad: 3 }]);
  afirmar(/^\d{2}\/\d{2}\/\d{4}$/.test(r.pedidos[0].fecha), 'fecha formateada: ' + r.pedidos[0].fecha);
});

probar('entregar descuenta el stock', () => {
  const { ctx, hojas, token } = conPedido(3);
  const r = llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  igual(r.status, 'Entregado');
  igual(stockDe(hojas, 'Almendras'), 9, '12 - 3');
  igual(valorDe(hojas[1], 2, 'Status'), 'Entregado');
});

probar('deshacer la entrega repone el stock y el status anterior', () => {
  const { ctx, hojas, token } = conPedido(3);
  llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  const r = llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'deshacer' });

  igual(r.status, 'Pendiente', 'vuelve al estado que tenía');
  igual(stockDe(hojas, 'Almendras'), 12, 'el stock vuelve a como estaba');
});

probar('el stock nunca queda negativo, y avisa del faltante', () => {
  const { ctx, hojas, token } = conPedido(12);
  hojas[0].datos[1][5] = 2;        // alguien se llevó mercadería sin registrarla

  const r = llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  igual(r.status, 'Entregado', 'la entrega no se frena');
  igual(stockDe(hojas, 'Almendras'), 0, 'frena en cero, no en -10');
  igual(r.recortados, [{ nombre: 'Almendras', pedido: 12, habia: 2 }], 'informa el descuadre');
});

probar('deshacer repone lo descontado, no lo pedido', () => {
  const { ctx, hojas, token } = conPedido(12);
  hojas[0].datos[1][5] = 2;
  llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'deshacer' });

  igual(stockDe(hojas, 'Almendras'), 2, 'repone los 2 que había, no los 12 del pedido');
});

probar('un producto que ya no está en el catálogo se informa', () => {
  const { ctx, hojas, token } = conPedido(3);
  hojas[0].datos[1][1] = 'Almendras peladas';      // se renombró después del pedido

  const r = llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  igual(r.status, 'Entregado');
  igual(r.faltantes, ['Almendras'], 'debería nombrar lo que no pudo descontar');
});

probar('no se entrega dos veces', () => {
  const { ctx, token } = conPedido();
  llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  igual(llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' }).codigo,
    'CONFLICTO');
});

probar('cancelar no toca el stock', () => {
  const { ctx, hojas, token } = conPedido(3);
  const r = llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'cancelar' });
  igual(r.status, 'Cancelado');
  igual(stockDe(hojas, 'Almendras'), 12, 'no salió del depósito, no se descuenta');
});

probar('un entregado no se cancela sin deshacer antes', () => {
  const { ctx, token } = conPedido();
  llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  const r = llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'cancelar' });
  igual(r.codigo, 'CONFLICTO');
  afirmar(/Deshacé la entrega/.test(r.error), r.error);
});

probar('un cancelado sale de la cola de etiquetas', () => {
  const { ctx, token } = conPedido();
  llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'cancelar' });
  igual(llamar(ctx, { accion: 'etiquetas', token }).cantidad, 0);
});

probar('rechaza operar sobre una fila cuyo ID no coincide', () => {
  const { ctx, token } = conPedido();
  igual(llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-9999', operacion: 'entregar' }).codigo,
    'CONFLICTO');
});

console.log('\nPedidos: edición del detalle');

probar('editar recalcula el detalle y el total', () => {
  const { ctx, hojas, token } = conPedido(3);
  const r = llamar(ctx, {
    accion: 'editarPedido', token, fila: 2, id: 'P-0001',
    items: [{ nombre: 'Almendras', cantidad: 5 }, { nombre: 'Nuez pecán', cantidad: 2 }],
  });
  igual(r.detalle, 'Almendras x5; Nuez pecán x2');
  igual(r.total, 7);
  igual(valorDe(hojas[1], 2, 'Detalle'), 'Almendras x5; Nuez pecán x2');
  igual(valorDe(hojas[1], 2, 'Total'), 7);
});

probar('poner una cantidad en cero saca el producto del pedido', () => {
  const { ctx, hojas, token } = conPedido(3);
  llamar(ctx, {
    accion: 'editarPedido', token, fila: 2, id: 'P-0001',
    items: [{ nombre: 'Almendras', cantidad: 0 }, { nombre: 'Nuez pecán', cantidad: 4 }],
  });
  igual(valorDe(hojas[1], 2, 'Detalle'), 'Nuez pecán x4');
});

probar('un pedido no puede quedar vacío', () => {
  const { ctx, token } = conPedido();
  const r = llamar(ctx, {
    accion: 'editarPedido', token, fila: 2, id: 'P-0001',
    items: [{ nombre: 'Almendras', cantidad: 0 }],
  });
  igual(r.codigo, 'DATOS_INVALIDOS');
  afirmar(/Cancelalo/.test(r.error), r.error);
});

probar('no se edita un pedido ya entregado', () => {
  const { ctx, token } = conPedido();
  llamar(ctx, { accion: 'estadoPedido', token, fila: 2, id: 'P-0001', operacion: 'entregar' });
  const r = llamar(ctx, {
    accion: 'editarPedido', token, fila: 2, id: 'P-0001',
    items: [{ nombre: 'Almendras', cantidad: 1 }],
  });
  igual(r.codigo, 'CONFLICTO');
});

probar('sin sesión no se opera sobre los pedidos', () => {
  const { ctx } = conPedido();
  igual(llamar(ctx, { accion: 'pedidos', token: '' }).codigo, 'SIN_AUTORIZACION');
  igual(llamar(ctx, { accion: 'estadoPedido', token: '', fila: 2, id: 'P-0001', operacion: 'entregar' }).codigo,
    'SIN_AUTORIZACION');
});

console.log('\nMargen (página de catálogo)');

/* Las fórmulas viven dentro de un IIFE en admin.js, así que se extraen del
   archivo real y se evalúan: probar una copia no probaría nada. */
const fuenteAdmin = fs.readFileSync(path.join(RAIZ, 'docs', 'admin', 'admin.js'), 'utf8');
const bloqueMargen = fuenteAdmin.slice(
  fuenteAdmin.indexOf('const margenDe'),
  fuenteAdmin.indexOf('const $  ='));
const { margenDe, ventaDe } = new Function(bloqueMargen + '; return { margenDe, ventaDe };')();

const redondear = (n, d = 6) => (n === null ? null : Number(n.toFixed(d)));

probar('margen = (venta - costo) / venta', () => {
  igual(redondear(margenDe(100, 200)), 0.5,   'costo 100, venta 200 → 50 %');
  igual(redondear(margenDe(100, 180)), 0.444444);
  igual(redondear(margenDe(100, 100)), 0,     'vender al costo es margen cero');
});

probar('venta = costo / (1 - margen), tal como la definiste', () => {
  igual(redondear(ventaDe(100, 0.5)), 200);
  igual(redondear(ventaDe(1000, 0.35)), 1538.461538);
  igual(redondear(ventaDe(100, 0)), 100);
});

probar('la ida y vuelta no pierde precisión', () => {
  [[1000, 1800], [847.5, 1299.99], [12, 100], [99999, 123456]].forEach(([costo, venta]) => {
    const m = margenDe(costo, venta);
    igual(redondear(ventaDe(costo, m), 4), redondear(venta, 4),
      'costo ' + costo + ', venta ' + venta);
  });
});

probar('los casos imposibles devuelven null en vez de infinito', () => {
  igual(ventaDe(100, 1), null, 'margen 100 % sería precio infinito');
  igual(ventaDe(100, 1.5), null, 'margen mayor a 100 % no existe');
  igual(ventaDe(null, 0.5), null, 'sin costo no hay venta que calcular');
  igual(margenDe(100, 0), null, 'venta cero no tiene margen definido');
  igual(margenDe(null, 200), null);
});

probar('un margen negativo es válido: se vende a pérdida', () => {
  igual(redondear(margenDe(200, 100)), -1, 'costo 200 y venta 100 → -100 %');
  igual(redondear(ventaDe(200, -1)), 100, 'y vuelve');
});

console.log('\n' + (fallas === 0
  ? `Todo verde: ${ok} pruebas.\n`
  : `${ok} pruebas pasaron, ${fallas} fallaron.\n`));
process.exit(fallas === 0 ? 0 : 1);

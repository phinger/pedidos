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

probar('exporta solo los pendientes y los marca como impresos', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  pedidoDe(ctx, token, 'Marcelo', 'k2');
  hojas[1].datos[2][6] = 'Listo';        // el segundo ya no está pendiente

  ctx.exportarEtiquetas();
  const hoja = ctx.creadas[0].getSheets()[0];
  igual(hoja.datos[0], ['Nombre', 'Detalle']);
  igual(hoja.datos[1][0], 'Gimena');
  igual(hoja.datos[1][1], 'Milanesa de soja x3\nPan integral x2',
    'el detalle debería venir en renglones');
  igual(hoja.getLastRow(), 2, 'el que ya no está pendiente no debería salir');

  const colImpreso = 8;   // 0-based: se agrega después de Email
  afirmar(hojas[1].datos[1][colImpreso], 'el pedido exportado debería quedar marcado');
});

probar('exportar de nuevo no reimprime lo ya impreso', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');

  ctx.exportarEtiquetas();
  igual(ctx.creadas[0].getSheets()[0].getLastRow(), 2, 'primera corrida: un pedido');

  ctx.exportarEtiquetas();
  igual(ctx.creadas[0].getSheets()[0].getLastRow(), 1,
    'segunda corrida: solo encabezados, no hay nada nuevo');

  pedidoDe(ctx, token, 'Marcelo', 'k2');
  ctx.exportarEtiquetas();
  const hoja = ctx.creadas[0].getSheets()[0];
  igual(hoja.getLastRow(), 2, 'tercera corrida: solo el pedido nuevo');
  igual(hoja.datos[1][0], 'Marcelo');
});

probar('deshacerUltimoLote devuelve los pedidos a la cola', () => {
  const { ctx, hojas } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');

  ctx.exportarEtiquetas();
  ctx.deshacerUltimoLote();
  igual(hojas[1].datos[1][8], '', 'la marca debería haberse borrado');

  ctx.exportarEtiquetas();
  igual(ctx.creadas[0].getSheets()[0].datos[1][0], 'Gimena', 'debería volver a salir');
});

probar('deshacer dos veces no rompe nada', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  ctx.exportarEtiquetas();
  ctx.deshacerUltimoLote();
  ctx.deshacerUltimoLote();
  igual(ctx.registro[ctx.registro.length - 1], 'No hay ningún lote para deshacer.');
});

probar('exportar dos veces reutiliza el mismo archivo', () => {
  const { ctx } = nuevoEntorno();
  const token = login(ctx).token;
  pedidoDe(ctx, token, 'Gimena', 'k1');
  const primera = ctx.exportarEtiquetas();
  const segunda = ctx.exportarEtiquetas();
  igual(segunda, primera, 'el enlace no debería cambiar');
  igual(ctx.creadas.length, 1, 'no debería crear un archivo por corrida');
});

probar('la vista viva también excluye lo impreso', () => {
  const { ctx, hojas } = nuevoEntorno();
  ctx.prepararEtiquetas();
  const formula = hojas.find((h) => h.nombre === 'Etiquetas').formulas['2:1'];
  afirmar(formula.indexOf('="Pendiente"') >= 0, 'debería filtrar por Pendiente: ' + formula);
  afirmar(formula.indexOf('I2:I=""') >= 0, 'debería excluir los que tienen fecha de impresión');
});

console.log('\n' + (fallas === 0
  ? `Todo verde: ${ok} pruebas.\n`
  : `${ok} pruebas pasaron, ${fallas} fallaron.\n`));
process.exit(fallas === 0 ? 0 : 1);

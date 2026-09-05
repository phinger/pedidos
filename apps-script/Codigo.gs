/* ═══════════════════════════════════════════════════════════════════════
   Pedidos — API del Web App.

   Se pega en el editor de Apps Script de la planilla
   (Extensiones → Apps Script) y se despliega como aplicación web.

   Las credenciales NO van acá: se cargan en
   Configuración del proyecto → Propiedades del script:

     CLIENT_ID       ← Client ID del cliente OAuth 2.0 (tipo Web)
     CLIENT_SECRET   ← Client secret de ese mismo cliente

   Para ver cómo quedó detectada la estructura de la planilla, ejecutar
   la función probarEstructura() desde el editor y mirar el registro.
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = {
  /* ── Solapas ──────────────────────────────────────────────────────── */
  HOJA_PRODUCTOS: 'Lista de Productos',
  HOJA_PEDIDOS:   'Pedidos',
  HOJA_USUARIOS:  'Usuarios',        // allowlist: una columna de emails

  /* ── Encabezados ──────────────────────────────────────────────────────
     Cada campo lista los nombres de columna aceptados. La comparación
     ignora mayúsculas, acentos y espacios, y si no hay coincidencia exacta
     prueba por "contiene". Para adaptarlo a la planilla real alcanza con
     agregar el nombre verdadero al principio de la lista.                */
  COLS_PRODUCTOS: {
    nombre:    ['nombres', 'producto', 'nombre', 'descripcion'],   // requerida
    categoria: ['categoria', 'rubro', 'familia', 'grupo'],
    unidad:    ['unidad', 'presentacion', 'medida', 'envase'],
    activo:    ['activo', 'habilitado', 'visible', 'vigente'],
    orden:     ['orden', 'posicion'],
  },
  COLS_PEDIDOS: {
    id:      ['id', 'idpedido', 'pedido', 'numero'],               // requerida
    fecha:   ['fecha'],                                            // requerida
    hora:    ['hora'],                                             // requerida
    nombre:  ['nombre', 'cliente', 'destinatario'],                // requerida
    detalle: ['detalle', 'productos', 'items', 'pedido'],          // requerida
    total:   ['total', 'cantidad', 'totalitems', 'unidades'],
    email:   ['email', 'usuario', 'cargadopor', 'mail'],
  },
  COL_STATUS: ['status', 'estado'],

  /* ── Cómo se completa la columna de status ─────────────────────────────
     'valor'  → el script escribe STATUS_INICIAL y otro proceso lo actualiza
                después. Es el modo en uso.
     'auto'   → la fórmula es un ARRAYFORMULA en el encabezado: el script no
                toca la columna y se llena sola.
     'copiar' → la fórmula está celda por celda: se copia desde la fila
                anterior conservando las referencias relativas.           */
  MODO_STATUS: 'valor',
  STATUS_INICIAL: 'Pendiente',

  /* ── Otros ────────────────────────────────────────────────────────── */
  PREFIJO_ID:   'P-',
  DIGITOS_ID:   4,
  SESION_DIAS:  180,
  MAX_ITEMS:    300,
  MAX_CANTIDAD: 999,
  HORA_FORMATO: 'HH:mm',
};


/* ═══════════════════════════════════════════════════════════════════════
   Puntos de entrada
   ═══════════════════════════════════════════════════════════════════════ */

function doGet() {
  return _salida({ ok: true, servicio: 'pedidos' });
}

function doPost(e) {
  try {
    const cuerpo = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const accion = String(cuerpo.accion || '');

    if (accion === 'login')    return _salida(accionLogin(cuerpo));
    if (accion === 'vincular') return _salida(accionVincular(cuerpo));

    /* Todo lo demás exige sesión válida. */
    const sesion = _verificarSesion(cuerpo.token);

    if (accion === 'productos')  return _salida(accionProductos());
    if (accion === 'pedido')     return _salida(accionPedido(cuerpo, sesion));
    if (accion === 'estructura') return _salida(accionEstructura());

    throw _error('Acción desconocida: ' + accion, 'ACCION_INVALIDA');
  } catch (err) {
    return _salida({
      ok: false,
      error: err && err.message ? err.message : 'Error inesperado.',
      codigo: (err && err.codigo) || 'ERROR',
    });
  }
}

function _salida(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _error(mensaje, codigo) {
  const e = new Error(mensaje);
  e.codigo = codigo || 'ERROR';
  return e;
}


/* ═══════════════════════════════════════════════════════════════════════
   Autenticación
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Canjea el código de OAuth por un id_token, valida el email contra la
 * allowlist y abre una sesión de larga duración.
 */
function accionLogin(p) {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('CLIENT_ID');
  const clientSecret = props.getProperty('CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw _error('Faltan CLIENT_ID y CLIENT_SECRET en las propiedades del script.', 'SIN_CONFIG');
  }
  if (!p.code || !p.code_verifier || !p.redirect_uri) {
    throw _error('Faltan datos del ingreso.', 'DATOS_INVALIDOS');
  }

  const respuesta = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      code: p.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: p.redirect_uri,
      grant_type: 'authorization_code',
      code_verifier: p.code_verifier,
    },
    muteHttpExceptions: true,
  });

  const datos = JSON.parse(respuesta.getContentText() || '{}');
  if (respuesta.getResponseCode() !== 200 || !datos.id_token) {
    throw _error('Google rechazó el ingreso' +
      (datos.error_description ? ': ' + datos.error_description : '.'), 'LOGIN_FALLIDO');
  }

  const perfil = _leerIdToken(datos.id_token, clientId);
  const email = String(perfil.email || '').toLowerCase();

  if (!email || perfil.email_verified === false) {
    throw _error('La cuenta de Google no tiene un email verificado.', 'SIN_AUTORIZACION');
  }
  if (!_estaAutorizado(email)) {
    throw _error('La cuenta ' + email + ' no está autorizada para cargar pedidos.', 'SIN_AUTORIZACION');
  }

  const nombre = perfil.name || perfil.given_name || email;
  const token = _crearSesion(email, nombre);

  /* Código corto para pasar la sesión a la app instalada cuando iOS
     terminó el login en Safari (almacenamientos separados). */
  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put('vinc_' + codigo, token, 600);

  return { ok: true, token: token, nombre: nombre, email: email, codigoVinculacion: codigo };
}

/**
 * El id_token viene directo del endpoint de Google sobre TLS, así que
 * según la especificación de OIDC no hace falta verificar la firma; sí
 * validamos destinatario, emisor y vencimiento.
 */
function _leerIdToken(idToken, clientId) {
  const partes = String(idToken).split('.');
  if (partes.length !== 3) throw _error('El token de Google es inválido.', 'LOGIN_FALLIDO');

  const json = Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[1])).getDataAsString();
  const carga = JSON.parse(json);

  const emisorOk = carga.iss === 'https://accounts.google.com' || carga.iss === 'accounts.google.com';
  if (!emisorOk) throw _error('El token de Google tiene un emisor inesperado.', 'LOGIN_FALLIDO');
  if (carga.aud !== clientId) throw _error('El token de Google es de otra aplicación.', 'LOGIN_FALLIDO');
  if (Number(carga.exp) * 1000 < Date.now()) throw _error('El token de Google venció.', 'LOGIN_FALLIDO');

  return carga;
}

function accionVincular(p) {
  const codigo = String(p.codigo || '').replace(/\D/g, '');
  if (codigo.length !== 6) throw _error('El código tiene que ser de 6 dígitos.', 'DATOS_INVALIDOS');

  const cache = CacheService.getScriptCache();
  const token = cache.get('vinc_' + codigo);
  if (!token) throw _error('El código no existe o ya venció.', 'CODIGO_INVALIDO');
  cache.remove('vinc_' + codigo);

  const sesion = _verificarSesion(token);
  return { ok: true, token: token, nombre: sesion.nombre, email: sesion.email };
}

function _hash(texto) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b & 0xFF) + 0x100).toString(16).slice(1); }).join('');
}

/** Guarda solo el hash del token: si alguien lee las propiedades, no sirve. */
function _crearSesion(email, nombre) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const vence = Date.now() + CFG.SESION_DIAS * 24 * 60 * 60 * 1000;
  PropertiesService.getScriptProperties()
    .setProperty('s_' + _hash(token), JSON.stringify({ email: email, nombre: nombre, vence: vence }));
  return token;
}

function _verificarSesion(token) {
  if (!token) throw _error('Necesitás iniciar sesión.', 'SIN_AUTORIZACION');

  const props = PropertiesService.getScriptProperties();
  const clave = 's_' + _hash(String(token));
  const crudo = props.getProperty(clave);
  if (!crudo) throw _error('La sesión no es válida. Ingresá de nuevo.', 'SIN_AUTORIZACION');

  const sesion = JSON.parse(crudo);
  if (Date.now() > sesion.vence) {
    props.deleteProperty(clave);
    throw _error('La sesión venció. Ingresá de nuevo.', 'SIN_AUTORIZACION');
  }
  /* Se rechequea la allowlist en cada llamada: sacar a alguien de la
     planilla lo deja afuera al instante, sin esperar el vencimiento. */
  if (!_estaAutorizado(sesion.email)) {
    props.deleteProperty(clave);
    throw _error('Tu cuenta ya no está autorizada.', 'SIN_AUTORIZACION');
  }
  return sesion;
}

/** Lee la solapa de usuarios (cacheada 5 minutos). Falla cerrado. */
function _estaAutorizado(email) {
  const cache = CacheService.getScriptCache();
  let lista = cache.get('allowlist');

  if (!lista) {
    const hoja = _hoja(CFG.HOJA_USUARIOS);
    const valores = hoja.getDataRange().getValues();
    if (valores.length < 1) throw _error('La solapa ' + CFG.HOJA_USUARIOS + ' está vacía.', 'SIN_CONFIG');

    const encabezados = valores[0].map(_normalizar);
    const colEmail  = _buscarColumna(encabezados, ['email', 'mail', 'correo', 'usuario']);
    const colActivo = _buscarColumna(encabezados, ['activo', 'habilitado', 'vigente']);
    if (colEmail < 0) {
      throw _error('La solapa ' + CFG.HOJA_USUARIOS + ' necesita una columna "email".', 'SIN_CONFIG');
    }

    const emails = [];
    for (let i = 1; i < valores.length; i++) {
      const mail = String(valores[i][colEmail] || '').trim().toLowerCase();
      if (!mail) continue;
      if (colActivo >= 0 && !_esVerdadero(valores[i][colActivo])) continue;
      emails.push(mail);
    }
    lista = JSON.stringify(emails);
    cache.put('allowlist', lista, 300);
  }

  return JSON.parse(lista).indexOf(String(email).toLowerCase()) >= 0;
}


/* ═══════════════════════════════════════════════════════════════════════
   Planilla
   ═══════════════════════════════════════════════════════════════════════ */

function _hoja(nombre) {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  if (!hoja) throw _error('No existe la solapa "' + nombre + '" en la planilla.', 'SIN_CONFIG');
  return hoja;
}

function _normalizar(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Busca por coincidencia exacta y, si no encuentra, por "contiene". */
function _buscarColumna(encabezados, alias) {
  for (let a = 0; a < alias.length; a++) {
    const objetivo = _normalizar(alias[a]);
    for (let i = 0; i < encabezados.length; i++) {
      if (encabezados[i] === objetivo) return i;
    }
  }
  for (let a = 0; a < alias.length; a++) {
    const objetivo = _normalizar(alias[a]);
    for (let i = 0; i < encabezados.length; i++) {
      if (encabezados[i] && encabezados[i].indexOf(objetivo) >= 0) return i;
    }
  }
  return -1;
}

function _mapearColumnas(encabezados, definicion) {
  const mapa = {};
  for (const campo in definicion) {
    mapa[campo] = _buscarColumna(encabezados, definicion[campo]);
  }
  return mapa;
}

function _esVerdadero(valor) {
  if (valor === true) return true;
  if (valor === false || valor === '' || valor === null || valor === undefined) return false;
  const t = _normalizar(valor);
  return ['si', 'sí', 'true', 'verdadero', 'x', '1', 'ok', 'activo'].indexOf(t) >= 0;
}

/** Identificador estable por nombre: sobrevive a que se reordenen las filas. */
function _idProducto(nombre, usados) {
  let base = _normalizar(nombre).slice(0, 40) || 'producto';
  let id = base;
  let n = 2;
  while (usados[id]) { id = base + '_' + n; n++; }
  usados[id] = true;
  return id;
}

function accionProductos() {
  const hoja = _hoja(CFG.HOJA_PRODUCTOS);
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return { ok: true, productos: [] };

  const encabezados = valores[0].map(_normalizar);
  const col = _mapearColumnas(encabezados, CFG.COLS_PRODUCTOS);
  if (col.nombre < 0) {
    throw _error('No encontré la columna de nombre de producto en "' + CFG.HOJA_PRODUCTOS +
      '". Revisá CFG.COLS_PRODUCTOS.', 'SIN_CONFIG');
  }

  /* Una columna "Activo" recién agregada y todavía sin completar dejaría el
     catálogo en cero. Si no hay un solo valor cargado, se ignora la columna;
     apenas aparece uno, se respeta al pie de la letra. */
  let filtrarPorActivo = false;
  if (col.activo >= 0) {
    for (let i = 1; i < valores.length; i++) {
      if (String(valores[i][col.activo] || '').trim()) { filtrarPorActivo = true; break; }
    }
  }

  const usados = {};
  const productos = [];

  for (let i = 1; i < valores.length; i++) {
    const fila = valores[i];
    const nombre = String(fila[col.nombre] || '').trim();
    if (!nombre) continue;
    if (filtrarPorActivo && !_esVerdadero(fila[col.activo])) continue;

    productos.push({
      id: _idProducto(nombre, usados),
      nombre: nombre,
      categoria: col.categoria >= 0 ? String(fila[col.categoria] || '').trim() : '',
      unidad: col.unidad >= 0 ? String(fila[col.unidad] || '').trim() : '',
      orden: col.orden >= 0 ? Number(fila[col.orden]) || 0 : i,
    });
  }

  /* Orden explícito si existe la columna; si no, se respeta el de la planilla.
     Dentro de cada categoría se mantiene el orden original. */
  if (col.orden >= 0) productos.sort(function (a, b) { return a.orden - b.orden; });
  if (col.categoria >= 0) {
    const categorias = [];
    productos.forEach(function (p) {
      if (categorias.indexOf(p.categoria) < 0) categorias.push(p.categoria);
    });
    productos.sort(function (a, b) {
      const d = categorias.indexOf(a.categoria) - categorias.indexOf(b.categoria);
      return d !== 0 ? d : a.orden - b.orden;
    });
  }

  return { ok: true, productos: productos };
}

function accionPedido(p, sesion) {
  const nombre = String(p.nombre || '').trim();
  if (!nombre) throw _error('Falta el nombre del pedido.', 'DATOS_INVALIDOS');
  if (nombre.length > 120) throw _error('El nombre del pedido es demasiado largo.', 'DATOS_INVALIDOS');

  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw _error('El pedido no tiene productos.', 'DATOS_INVALIDOS');
  if (items.length > CFG.MAX_ITEMS) throw _error('El pedido tiene demasiados productos.', 'DATOS_INVALIDOS');

  const clave = String(p.clave || '').slice(0, 64);
  if (!clave) throw _error('Falta la clave del envío.', 'DATOS_INVALIDOS');

  /* El nombre de cada producto se toma del catálogo, no de lo que mandó el
     cliente: la planilla queda consistente aunque el borrador esté viejo. */
  const catalogo = {};
  accionProductos().productos.forEach(function (prod) { catalogo[prod.id] = prod.nombre; });

  const lineas = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const cantidad = Math.floor(Number(items[i].cantidad));
    if (!(cantidad >= 1 && cantidad <= CFG.MAX_CANTIDAD)) {
      throw _error('Cantidad inválida en el pedido.', 'DATOS_INVALIDOS');
    }
    const nombreProducto = catalogo[items[i].id] || String(items[i].nombre || '').trim();
    if (!nombreProducto) throw _error('Hay un producto que ya no está en el catálogo.', 'DATOS_INVALIDOS');
    lineas.push(nombreProducto + ' x' + cantidad);
    total += cantidad;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw _error('El servidor está ocupado. Probá de nuevo.', 'OCUPADO');

  try {
    const props = PropertiesService.getScriptProperties();
    const claveIdem = 'k_' + _hash(clave);
    const yaGuardado = props.getProperty(claveIdem);
    if (yaGuardado) return { ok: true, id: yaGuardado, repetido: true };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = _hoja(CFG.HOJA_PEDIDOS);
    const encabezados = hoja.getRange(1, 1, 1, Math.max(1, hoja.getLastColumn()))
      .getValues()[0].map(_normalizar);

    const col = _mapearColumnas(encabezados, CFG.COLS_PEDIDOS);
    const colStatus = _buscarColumna(encabezados, CFG.COL_STATUS);
    ['id', 'fecha', 'hora', 'nombre', 'detalle'].forEach(function (campo) {
      if (col[campo] < 0) {
        throw _error('No encontré la columna "' + campo + '" en la solapa "' + CFG.HOJA_PEDIDOS +
          '". Revisá CFG.COLS_PEDIDOS.', 'SIN_CONFIG');
      }
    });

    const filaNueva = hoja.getLastRow() + 1;
    const zona = ss.getSpreadsheetTimeZone();
    const ahora = new Date();
    const id = _proximoId(hoja, col.id);

    /* Se escribe celda por celda a propósito: en los modos 'auto' y 'copiar'
       la columna de status queda intacta y su fórmula sigue calculando. */
    const aEscribir = {};
    aEscribir[col.id] = id;
    aEscribir[col.fecha] = new Date(
      Utilities.formatDate(ahora, zona, 'yyyy/MM/dd') + ' 00:00:00');
    aEscribir[col.hora] = Utilities.formatDate(ahora, zona, CFG.HORA_FORMATO);
    aEscribir[col.nombre] = nombre;
    aEscribir[col.detalle] = lineas.join('; ');
    if (col.total >= 0) aEscribir[col.total] = total;
    if (col.email >= 0) aEscribir[col.email] = sesion.email;

    /* El pedido nace pendiente; el proceso de etiquetas lo actualiza después. */
    if (CFG.MODO_STATUS === 'valor') {
      if (colStatus < 0) {
        throw _error('No encontré la columna de status en la solapa "' + CFG.HOJA_PEDIDOS +
          '". Revisá CFG.COL_STATUS.', 'SIN_CONFIG');
      }
      aEscribir[colStatus] = CFG.STATUS_INICIAL;
    }

    for (const indice in aEscribir) {
      hoja.getRange(filaNueva, Number(indice) + 1).setValue(aEscribir[indice]);
    }

    if (CFG.MODO_STATUS === 'copiar') _copiarStatus(hoja, encabezados, filaNueva);

    props.setProperty(claveIdem, id);
    SpreadsheetApp.flush();
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

/** Correlativo P-0001 leyendo el mayor número ya usado en la columna de ID. */
function _proximoId(hoja, colId) {
  const ultima = hoja.getLastRow();
  let maximo = 0;

  if (ultima > 1) {
    const valores = hoja.getRange(2, colId + 1, ultima - 1, 1).getValues();
    for (let i = 0; i < valores.length; i++) {
      const m = String(valores[i][0] || '').match(/(\d+)\s*$/);
      if (m) maximo = Math.max(maximo, parseInt(m[1], 10));
    }
  }

  let numero = String(maximo + 1);
  while (numero.length < CFG.DIGITOS_ID) numero = '0' + numero;
  return CFG.PREFIJO_ID + numero;
}

/** Arrastra la fórmula de status desde la fila anterior. */
function _copiarStatus(hoja, encabezados, filaNueva) {
  const colStatus = _buscarColumna(encabezados, CFG.COL_STATUS);
  if (colStatus < 0 || filaNueva < 3) return;
  hoja.getRange(filaNueva - 1, colStatus + 1)
      .copyTo(hoja.getRange(filaNueva, colStatus + 1));
}


/* ═══════════════════════════════════════════════════════════════════════
   Diagnóstico
   ═══════════════════════════════════════════════════════════════════════ */

function accionEstructura() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const detalle = { ok: true, planilla: ss.getName(), zona: ss.getSpreadsheetTimeZone(), solapas: [] };

  ss.getSheets().forEach(function (hoja) {
    const columnas = hoja.getLastColumn();
    detalle.solapas.push({
      nombre: hoja.getName(),
      filas: hoja.getLastRow(),
      encabezados: columnas ? hoja.getRange(1, 1, 1, columnas).getValues()[0] : [],
    });
  });

  return detalle;
}

/**
 * Ejecutar a mano desde el editor de Apps Script: muestra las solapas, sus
 * encabezados y cómo quedó resuelto el mapeo de CFG. Es la forma rápida de
 * confirmar la configuración sin tocar el frontend.
 */
function probarEstructura() {
  const info = accionEstructura();
  Logger.log('Planilla: %s  (zona horaria: %s)', info.planilla, info.zona);

  info.solapas.forEach(function (s) {
    Logger.log('\n── Solapa "%s"  (%s filas)\n   Encabezados: %s',
      s.nombre, s.filas, JSON.stringify(s.encabezados));
  });

  [[CFG.HOJA_PRODUCTOS, CFG.COLS_PRODUCTOS], [CFG.HOJA_PEDIDOS, CFG.COLS_PEDIDOS]]
    .forEach(function (par) {
      const solapa = info.solapas.filter(function (s) { return s.nombre === par[0]; })[0];
      if (!solapa) {
        Logger.log('\n⚠️  No existe la solapa "%s" configurada en CFG.', par[0]);
        return;
      }
      const encabezados = solapa.encabezados.map(_normalizar);
      const mapa = _mapearColumnas(encabezados, par[1]);
      Logger.log('\n── Mapeo para "%s"', par[0]);
      for (const campo in mapa) {
        Logger.log('   %s → %s', campo,
          mapa[campo] >= 0 ? 'columna ' + (mapa[campo] + 1) + ' ("' + solapa.encabezados[mapa[campo]] + '")'
                           : '⚠️ NO ENCONTRADA');
      }
      if (par[0] === CFG.HOJA_PRODUCTOS) {
        try {
          const productos = accionProductos().productos;
          Logger.log('   → la app va a mostrar %s productos: %s…',
            productos.length,
            productos.slice(0, 5).map(function (x) { return x.nombre; }).join(' · '));
          if (!productos.length) {
            Logger.log('   ⚠️ Ninguno. Revisá la columna "Activo": si tiene algún valor ' +
              'cargado, las filas vacías se toman como dadas de baja.');
          }
        } catch (e) {
          Logger.log('   ⚠️ %s', e.message);
        }
      }
      if (par[0] === CFG.HOJA_PEDIDOS) {
        const cs = _buscarColumna(encabezados, CFG.COL_STATUS);
        Logger.log('   status → %s', cs >= 0
          ? 'columna ' + (cs + 1) + ' ("' + solapa.encabezados[cs] + '") — ' +
            (CFG.MODO_STATUS === 'valor'
              ? 'se escribe "' + CFG.STATUS_INICIAL + '" en cada pedido'
              : 'no se escribe, modo ' + CFG.MODO_STATUS)
          : '⚠️ NO ENCONTRADA');
      }
    });
}

/**
 * Deja la planilla lista para la app. Es idempotente: si algo ya está bien,
 * no lo toca. Ejecutar a mano desde el editor, una sola vez.
 *
 * - Solapa de pedidos: crea la fila de encabezados si está vacía.
 * - Solapa de usuarios: si los emails arrancan en la fila 1, inserta arriba
 *   la fila de encabezados y marca como activos los que ya estaban.
 */
function prepararPlanilla() {
  const informe = [];

  /* ── Pedidos ── */
  const pedidos = _hoja(CFG.HOJA_PEDIDOS);
  if (pedidos.getLastRow() === 0) {
    const encabezados = ['ID', 'Fecha', 'Hora', 'Nombre', 'Detalle', 'Total', 'Status', 'Email'];
    pedidos.getRange(1, 1, 1, encabezados.length).setValues([encabezados]).setFontWeight('bold');
    pedidos.setFrozenRows(1);
    pedidos.getRange('B:B').setNumberFormat('dd/MM/yyyy');
    pedidos.setColumnWidth(5, 420);   // "Detalle" es la columna larga
    informe.push('Pedidos: encabezados creados.');
  } else {
    informe.push('Pedidos: ya tenía contenido, no se tocó nada.');
  }

  /* ── Usuarios ── */
  const usuarios = _hoja(CFG.HOJA_USUARIOS);
  const primeraFila = usuarios.getRange(1, 1, 1, Math.max(1, usuarios.getLastColumn()))
    .getValues()[0].map(_normalizar);

  if (_buscarColumna(primeraFila, ['email', 'mail', 'correo', 'usuario']) < 0) {
    usuarios.insertRowBefore(1);
    usuarios.getRange(1, 1, 1, 2).setValues([['Email', 'Activo']]).setFontWeight('bold');
    usuarios.setFrozenRows(1);

    /* Los emails que ya estaban quedan activos: si la columna quedara vacía,
       el script los leería como dados de baja y nadie podría entrar. */
    const cuantos = usuarios.getLastRow() - 1;
    if (cuantos > 0) {
      const emails = usuarios.getRange(2, 1, cuantos, 1).getValues();
      usuarios.getRange(2, 2, cuantos, 1).setValues(
        emails.map(function (f) { return [String(f[0]).trim() ? 'SI' : '']; }));
    }
    informe.push('Usuarios: se insertó la fila de encabezados y se marcaron ' +
      cuantos + ' email(s) como activos.');
  } else {
    informe.push('Usuarios: ya tenía encabezados.');
  }

  CacheService.getScriptCache().remove('allowlist');
  SpreadsheetApp.flush();

  /* ── Control de lo que va a ver la app ── */
  const productos = accionProductos().productos;
  informe.push('Catálogo: ' + productos.length + ' productos.');
  informe.push('Primeros: ' + productos.slice(0, 6).map(function (p) { return p.nombre; }).join(' · '));

  Logger.log(informe.join('\n'));
}

/** Borra sesiones vencidas y claves de idempotencia viejas. Opcional: activador diario. */
function limpiarSesionesVencidas() {
  const props = PropertiesService.getScriptProperties();
  const todas = props.getProperties();
  let borradas = 0;

  for (const clave in todas) {
    if (clave.indexOf('s_') !== 0) continue;
    try {
      if (Date.now() > JSON.parse(todas[clave]).vence) { props.deleteProperty(clave); borradas++; }
    } catch (e) {
      props.deleteProperty(clave);
      borradas++;
    }
  }
  Logger.log('Sesiones borradas: %s', borradas);
}

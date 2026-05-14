"use strict";

const net = require("net");

// Plantilla de modelo que se usa al crear el nodo si no se configuró ningún JSON válido
// o si el JSON almacenado no puede parsearse. Proporciona un punto de partida coherente.
const DEFAULT_JSON = {
  defaults: {
    type: "float32",
    byteOrder: "ABCD",
    missingRegister: "exception"
  }
};

// Convierte un valor de configuración a entero. Node-RED puede entregar números como
// strings (desde campos de formulario HTML), por lo que parseInt es necesario incluso
// cuando se espera un número. Si el resultado no es finito, se devuelve el fallback.
function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Node.js en modo dual-stack (IPv4+IPv6) reporta clientes IPv4 con el prefijo
// '::ffff:' (p.ej. '::ffff:192.168.1.5'). Esta función elimina ese prefijo para
// que las comparaciones de IP siempre trabajen con formato IPv4 puro.
function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}

// Convierte una dirección IPv4 a un entero de 32 bits sin signo para poder
// aplicar máscaras CIDR con operaciones bit a bit. El `>>> 0` al final fuerza
// la interpretación como unsigned (JavaScript trata los enteros en operaciones
// bitwise como int32 con signo; sin el shift, valores ≥ 128.0.0.0 serían negativos).
function ipv4ToInt(ip) {
  const parts = String(ip).split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

// Comprueba si la IP de un cliente encaja con el patrón registrado en model.remotes.
// Soporta tres formas:
//   "*"           → coincide con cualquier remoto.
//   "x.x.x.x"    → coincidencia exacta de IPv4.
//   "x.x.x.x/nn" → red CIDR: se comparan los 'nn' bits más significativos.
//                   La máscara se calcula como (~0 << (32-bits)) >>> 0 para
//                   obtener un entero sin signo correcto en JavaScript.
function matchesRemote(pattern, remoteIp) {
  const ip = normalizeIp(remoteIp);
  if (!pattern || pattern === "*" || pattern === ip) return true;

  if (pattern.includes("/")) {
    const [network, bitsText] = pattern.split("/");
    const bits = Number.parseInt(bitsText, 10);
    const ipInt = ipv4ToInt(ip);
    const netInt = ipv4ToInt(network);
    if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      return false;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (netInt & mask);
  }

  return false;
}

// Parsea un valor que puede ser un string JSON, un objeto ya parseado, o estar vacío.
// - Si ya es un objeto, lo devuelve tal cual (Node-RED a veces almacena JSON preparse).
// - Si es string vacío o nulo, devuelve el fallback en lugar de lanzar un error.
// - En cualquier otro caso delega en JSON.parse (puede lanzar SyntaxError que el
//   llamador debe capturar).
function safeJsonParse(text, fallback) {
  if (typeof text === "object" && text !== null) return text;
  if (typeof text !== "string" || text.trim() === "") return fallback;
  return JSON.parse(text);
}

// Guardián de tipo: verifica que el valor sea un objeto plano {} y no null ni un array.
// Se usa en toda la lógica de merge y validación para evitar accesos a null/undefined.
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Duck-typing para distinguir un modelo de datos del nodo de cualquier otro objeto.
// Si el payload tiene al menos una de estas claves raíz, se trata como modelo parcial
// y se hace merge en lugar de intentar ejecutarlo como acción.
function isModelShape(value) {
  if (!isPlainObject(value)) return false;
  return ["defaults", "registers", "coils", "unitIds", "remotes"].some((k) => Object.prototype.hasOwnProperty.call(value, k));
}

// Clonación profunda vía serialización JSON. Suficiente para el modelo de datos porque
// todos sus valores son primitivos u objetos planos (sin funciones ni referencias circulares).
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Merge profundo de dos objetos planos: los valores hoja del source sobreescriben/añaden
// en el target; si ambos tienen la misma clave con objeto plano, se mezclan recursivamente.
// Arrays se tratan como valores hoja (se reemplazan, no se concatenan).
function mergePlainObjects(target, source) {
  const result = isPlainObject(target) ? target : {};
  if (!isPlainObject(source)) return result;

  for (const [key, sourceValue] of Object.entries(source)) {
    if (isPlainObject(sourceValue)) {
      result[key] = mergePlainObjects(isPlainObject(result[key]) ? result[key] : {}, sourceValue);
    } else {
      result[key] = clone(sourceValue);
    }
  }

  return result;
}

// Aplica un patch parcial sobre el modelo activo. Permite enviar sólo las claves
// que cambian sin destruir el resto del modelo (p.ej. actualizar un remote sin
// borrar los unitIds globales).
function mergeModel(targetModel, patchModel) {
  return mergePlainObjects(targetModel || {}, patchModel || {});
}

// Devuelve true si un grupo lógico (global, unitId o remote) tiene al menos una
// dirección definida en registers o coils. Se usa para decidir si ese grupo merece
// un timestamp de actividad: grupos vacíos no necesitan seguimiento de timeout.
function hasGroupData(group) {
  if (!isPlainObject(group)) return false;
  const registers = group.registers;
  const coils = group.coils;
  const hasRegisters = isPlainObject(registers) && Object.keys(registers).length > 0;
  const hasCoils = isPlainObject(coils) && Object.keys(coils).length > 0;
  return hasRegisters || hasCoils;
}

// Construye la estructura de actividad que registra el último instante en que cada
// grupo lógico fue actualizado. La forma del objeto devuelto es:
//   {
//     global: <timestamp | null>,       // grupo de registers/coils raíz
//     unitIds: { "17": <timestamp>, ...},
//     remotes: {
//       "192.168.1.0/24": {
//         ts: <timestamp>,              // actividad del remote en sí
//         unitIds: { "17": <timestamp> } // actividad de cada unit dentro del remote
//       }
//     }
//   }
// Solo se marca actividad en grupos que ya tienen datos (hasGroupData = true),
// porque grupos vacíos no deben caducar ni emitir eventos de expiración.
function buildActivityState(model, now = Date.now()) {
  const activity = {
    global: null,
    unitIds: {},
    remotes: {}
  };

  if (hasGroupData(model)) {
    activity.global = now;
  }

  if (isPlainObject(model.unitIds)) {
    for (const [unitKey, unitCfg] of Object.entries(model.unitIds)) {
      if (hasGroupData(unitCfg)) {
        activity.unitIds[unitKey] = now;
      }
    }
  }

  if (isPlainObject(model.remotes)) {
    for (const [remoteKey, remoteCfg] of Object.entries(model.remotes)) {
      let remoteActivity = null;

      if (hasGroupData(remoteCfg)) {
        remoteActivity = { ts: now, unitIds: {} };
      }

      if (isPlainObject(remoteCfg.unitIds)) {
        for (const [unitKey, unitCfg] of Object.entries(remoteCfg.unitIds)) {
          if (!hasGroupData(unitCfg)) continue;
          if (!remoteActivity) {
            remoteActivity = { ts: now, unitIds: {} };
          }
          remoteActivity.unitIds[unitKey] = now;
        }
      }

      if (remoteActivity) {
        activity.remotes[remoteKey] = remoteActivity;
      }
    }
  }

  return activity;
}

// Actualiza la actividad de los grupos afectados por un patch de modelo (merge parcial).
// El patch puede tener cualquier profundidad de anidamiento (unitIds, remotes, remotes[x].unitIds),
// por lo que la función se llama recursivamente con el scope correcto en cada nivel.
// El parámetro `scope` indica el ámbito actual durante la recursión:
//   "global"     → patch raíz del modelo
//   "unit"       → dentro de model.unitIds
//   "remote"     → dentro de model.remotes[remote]
//   "remoteUnit" → dentro de model.remotes[remote].unitIds[unit]
function markPatchActivity(activity, patch, now = Date.now(), scope = "global", remoteKey, unitKey) {
  if (!activity || !isPlainObject(patch)) return;

  const hasOwnData = Object.prototype.hasOwnProperty.call(patch, "registers") || Object.prototype.hasOwnProperty.call(patch, "coils");

  if (hasOwnData) {
    if (scope === "global") {
      activity.global = now;
    } else if (scope === "unit") {
      activity.unitIds[unitKey] = now;
    } else if (scope === "remote") {
      activity.remotes[remoteKey] = activity.remotes[remoteKey] || { ts: now, unitIds: {} };
      activity.remotes[remoteKey].ts = now;
      activity.remotes[remoteKey].unitIds = activity.remotes[remoteKey].unitIds || {};
    } else if (scope === "remoteUnit") {
      activity.remotes[remoteKey] = activity.remotes[remoteKey] || { ts: now, unitIds: {} };
      activity.remotes[remoteKey].ts = now;
      activity.remotes[remoteKey].unitIds = activity.remotes[remoteKey].unitIds || {};
      activity.remotes[remoteKey].unitIds[unitKey] = now;
    }
  }

  if (isPlainObject(patch.unitIds)) {
    for (const [nestedUnitKey, nestedUnitPatch] of Object.entries(patch.unitIds)) {
      markPatchActivity(activity, nestedUnitPatch, now, scope === "remote" || scope === "remoteUnit" ? "remoteUnit" : "unit", remoteKey, nestedUnitKey);
    }
  }

  if (isPlainObject(patch.remotes)) {
    for (const [nestedRemoteKey, nestedRemotePatch] of Object.entries(patch.remotes)) {
      markPatchActivity(activity, nestedRemotePatch, now, "remote", nestedRemoteKey);
      if (isPlainObject(nestedRemotePatch.unitIds)) {
        for (const [nestedUnitKey, nestedUnitPatch] of Object.entries(nestedRemotePatch.unitIds)) {
          markPatchActivity(activity, nestedUnitPatch, now, "remoteUnit", nestedRemoteKey, nestedUnitKey);
        }
      }
    }
  }
}

// Versión ligera para operaciones puntuales (setValue). A diferencia de markPatchActivity,
// no necesita recorrer el objeto: el llamador ya conoce exactamente qué scope se modificó
// y pasa el `updateInfo` que devolvió patchRegisterValue.
function touchGroupActivity(activity, updateInfo, now = Date.now()) {
  if (!activity || !updateInfo) return;

  if (updateInfo.scope === "global") {
    activity.global = now;
    return;
  }

  if (updateInfo.scope === "unit") {
    activity.unitIds[updateInfo.unitKey] = now;
    return;
  }

  if (updateInfo.scope === "remote") {
    activity.remotes[updateInfo.remoteKey] = activity.remotes[updateInfo.remoteKey] || { ts: now, unitIds: {} };
    activity.remotes[updateInfo.remoteKey].ts = now;
    activity.remotes[updateInfo.remoteKey].unitIds = activity.remotes[updateInfo.remoteKey].unitIds || {};
    return;
  }

  if (updateInfo.scope === "remoteUnit") {
    activity.remotes[updateInfo.remoteKey] = activity.remotes[updateInfo.remoteKey] || { ts: now, unitIds: {} };
    activity.remotes[updateInfo.remoteKey].ts = now;
    activity.remotes[updateInfo.remoteKey].unitIds = activity.remotes[updateInfo.remoteKey].unitIds || {};
    activity.remotes[updateInfo.remoteKey].unitIds[updateInfo.unitKey] = now;
  }
}

// Elimina del modelo todos los grupos cuya actividad no se haya actualizado
// dentro de la ventana de tiempo `timeoutMs`. La eliminación es en cascada:
//   - Si expira el global, se borran registers y coils raíz.
//   - Si expira un unitId, se borra ese unit completo.
//   - Si expira un remote (por su .ts), se borra el remote completo.
//   - Si expira un unitId dentro de un remote, solo se borra ese sub-unit.
// Tras cada borrado se limpian ramas vacías ({}) para evitar residuos en el modelo.
// El callback `onExpired` recibe un objeto { scope, remoteKey?, unitKey? } y se
// invoca una vez por cada grupo eliminado (lo usa el runtime para emitir el evento).
function pruneExpiredGroups(model, activity, timeoutMs, now = Date.now(), onExpired) {
  if (!timeoutMs || timeoutMs <= 0 || !activity) return;

  if (activity.global !== null && (now - activity.global) >= timeoutMs) {
    delete model.registers;
    delete model.coils;
    activity.global = null;
    if (typeof onExpired === "function") {
      onExpired({ scope: "global" });
    }
  }

  if (isPlainObject(model.unitIds)) {
    for (const [unitKey, unitTs] of Object.entries(activity.unitIds || {})) {
      if ((now - unitTs) >= timeoutMs) {
        delete model.unitIds[unitKey];
        delete activity.unitIds[unitKey];
        if (typeof onExpired === "function") {
          onExpired({ scope: "unit", unitKey });
        }
      }
    }

    if (Object.keys(model.unitIds).length === 0) {
      delete model.unitIds;
    }
  }

  if (isPlainObject(model.remotes)) {
    for (const [remoteKey, remoteActivity] of Object.entries(activity.remotes || {})) {
      const remoteCfg = model.remotes[remoteKey];
      if (!remoteCfg) {
        delete activity.remotes[remoteKey];
        continue;
      }

      if ((now - remoteActivity.ts) >= timeoutMs) {
        delete model.remotes[remoteKey];
        delete activity.remotes[remoteKey];
        if (typeof onExpired === "function") {
          onExpired({ scope: "remote", remoteKey });
        }
        continue;
      }

      if (isPlainObject(remoteCfg.unitIds)) {
        for (const [unitKey, unitTs] of Object.entries(remoteActivity.unitIds || {})) {
          if ((now - unitTs) >= timeoutMs) {
            delete remoteCfg.unitIds[unitKey];
            delete remoteActivity.unitIds[unitKey];
            if (typeof onExpired === "function") {
              onExpired({ scope: "remoteUnit", remoteKey, unitKey });
            }
          }
        }

        if (Object.keys(remoteCfg.unitIds).length === 0) {
          delete remoteCfg.unitIds;
        }
      }

      if (!hasGroupData(remoteCfg) && (!isPlainObject(remoteCfg.unitIds) || Object.keys(remoteCfg.unitIds).length === 0)) {
        delete model.remotes[remoteKey];
        delete activity.remotes[remoteKey];
      }
    }

    if (Object.keys(model.remotes).length === 0) {
      delete model.remotes;
    }
  }
}

// Resuelve el valor de una dirección aplicando las 4 prioridades contextuales.
// Se itera model.remotes dos veces de forma intencional:
//   - Primera pasada: busca remote + unitId (máxima especificidad).
//   - Segunda pasada: busca remote sin unitId (fallback por IP).
// Separar las dos pasadas garantiza que una coincidencia por remote+unit siempre
// gana sobre cualquier entrada remote-only, incluso si los patrones CIDR se
// evalúan en orden de inserción del objeto.
// `mapName` es "registers" o "coils"; la misma lógica sirve para FC1 y FC3.
function lookupAddress(model, remoteIp, unitId, address, mapName) {
  const addressKey = String(address);
  const unitKey = String(unitId);
  const remoteMap = model.remotes || {};

  // Priority 1: remote + unitId
  for (const [pattern, remoteCfg] of Object.entries(remoteMap)) {
    if (!matchesRemote(pattern, remoteIp)) continue;
    const remoteUnit = remoteCfg.unitIds && remoteCfg.unitIds[unitKey];
    if (remoteUnit && remoteUnit[mapName] && Object.prototype.hasOwnProperty.call(remoteUnit[mapName], addressKey)) {
      return remoteUnit[mapName][addressKey];
    }
  }

  // Priority 2: remote-only
  for (const [pattern, remoteCfg] of Object.entries(remoteMap)) {
    if (!matchesRemote(pattern, remoteIp)) continue;
    if (remoteCfg[mapName] && Object.prototype.hasOwnProperty.call(remoteCfg[mapName], addressKey)) {
      return remoteCfg[mapName][addressKey];
    }
  }

  // Priority 3: unitId-only
  if (model.unitIds && model.unitIds[unitKey] && model.unitIds[unitKey][mapName]) {
    const unitMap = model.unitIds[unitKey][mapName];
    if (Object.prototype.hasOwnProperty.call(unitMap, addressKey)) {
      return unitMap[addressKey];
    }
  }

  // Priority 4: global register map
  if (model[mapName] && Object.prototype.hasOwnProperty.call(model[mapName], addressKey)) {
    return model[mapName][addressKey];
  }

  return null;
}

// Wrappers de conveniencia que fijan el mapName para registro o coil.
function lookupRegister(model, remoteIp, unitId, address) {
  return lookupAddress(model, remoteIp, unitId, address, "registers");
}

function lookupCoil(model, remoteIp, unitId, address) {
  return lookupAddress(model, remoteIp, unitId, address, "coils");
}

// Convierte cualquier valor de entrada a boolean con tolerancia a los formatos
// habituales en SCADA/IoT: valores numéricos (0=false, cualquier otro=true),
// y strings case-insensitive para integración con nodos Inject de Node-RED.
function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "on", "yes"].includes(text)) return true;
    if (["0", "false", "off", "no", ""].includes(text)) return false;
  }
  return Boolean(value);
}

// Codifica una definición de coil como un bit booleano. El orden de comprobación
// es deliberado y de mayor a menor prioridad:
//   1. `exception` definido → lanza error para que el servidor responda con excepción
//      Modbus. Útil para simular puntos en falla o en modo manual de error.
//   2. `enabled === false` → el punto existe pero está deshabilitado (excepción 0x02).
//   3. `value` → el valor bool del coil interpretado por parseBooleanLike.
// Si coilDef es un primitivo (no objeto), se parsea directamente como booleano.
function encodeCoilBit(coilDef) {
  if (coilDef && typeof coilDef === "object") {
    if (coilDef.exception !== undefined) {
      const code = Number.parseInt(coilDef.exception, 10);
      const err = new Error(`Forced Modbus exception ${code}`);
      err.modbusException = Number.isInteger(code) ? code : 0x04;
      throw err;
    }

    if (coilDef.enabled === false) {
      const err = new Error("Coil disabled");
      err.modbusException = 0x02;
      throw err;
    }

    if (Object.prototype.hasOwnProperty.call(coilDef, "value")) {
      return parseBooleanLike(coilDef.value);
    }
  }

  return parseBooleanLike(coilDef);
}

// Reordena los 4 bytes de un registro según la convención de byte-order del PLC.
// El raw buffer siempre se genera en big-endian (ABCD) por las funciones writeXxxBE;
// esta función aplica la permutación necesaria según el formato del dispositivo:
//   ABCD → big-endian estándar            [A, B, C, D]
//   CDAB → word-swap (mid-big)            [C, D, A, B]
//   BADC → byte-swap dentro de cada word  [B, A, D, C]
//   DCBA → little-endian completo         [D, C, B, A]
function orderBytes(raw, byteOrder) {
  const order = String(byteOrder || "ABCD").toUpperCase();
  switch (order) {
    case "ABCD": return Buffer.from([raw[0], raw[1], raw[2], raw[3]]);
    case "CDAB": return Buffer.from([raw[2], raw[3], raw[0], raw[1]]);
    case "BADC": return Buffer.from([raw[1], raw[0], raw[3], raw[2]]);
    case "DCBA": return Buffer.from([raw[3], raw[2], raw[1], raw[0]]);
    default: return Buffer.from([raw[0], raw[1], raw[2], raw[3]]);
  }
}

// Serializa un punto de registro a un Buffer de 4 bytes listo para incluir
// en la respuesta FC3. El flujo es: escribir el valor en big-endian en `raw`
// (que siempre tiene 4 bytes) y luego permutar según byteOrder con orderBytes.
// Para hex32/raw32 el string hexadecimal se normaliza (elimina '0x', rellena
// a 8 dígitos) antes de decodificarlo como bytes.
// Los flags `exception` y `enabled` se evalúan antes que el valor para que
// un punto "en falla" nunca devuelva datos, incluso si tiene un `value` definido.
function encode32(registerDef, defaults) {
  const def = registerDef || {};
  const type = String(def.type || defaults.type || "float32").toLowerCase();
  const byteOrder = def.byteOrder || defaults.byteOrder || "ABCD";
  const raw = Buffer.alloc(4);

  if (def.exception !== undefined) {
    const code = Number.parseInt(def.exception, 10);
    const err = new Error(`Forced Modbus exception ${code}`);
    err.modbusException = Number.isInteger(code) ? code : 0x04;
    throw err;
  }

  if (def.enabled === false) {
    const err = new Error("Register disabled");
    err.modbusException = 0x02;
    throw err;
  }

  if (type === "float" || type === "float32" || type === "real") {
    raw.writeFloatBE(Number(def.value ?? 0), 0);
  } else if (type === "int32" || type === "long") {
    raw.writeInt32BE(Number(def.value ?? 0), 0);
  } else if (type === "uint32" || type === "ulong") {
    raw.writeUInt32BE(Number(def.value ?? 0), 0);
  } else if (type === "hex32" || type === "raw32") {
    const clean = String(def.value ?? "00000000").replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "");
    const padded = clean.padStart(8, "0").slice(-8);
    Buffer.from(padded, "hex").copy(raw, 0);
  } else {
    const err = new Error(`Unsupported register type: ${type}`);
    err.modbusException = 0x04;
    throw err;
  }

  return orderBytes(raw, byteOrder);
}

// Construye una respuesta de excepción Modbus TCP. Diseño del frame (9 bytes):
//   [0-1] Transaction ID   - copiado de la solicitud (para correlación del cliente)
//   [2-3] Protocol ID      - 0x0000 (Modbus)
//   [4-5] Length           - 0x0003 (3 bytes restantes: Unit + ExFC + Code)
//   [6]   Unit ID
//   [7]   Function Code | 0x80   (bit 7 seteado indica excepción)
//   [8]   Exception Code
function buildExceptionResponse(req, unitId, fc, exceptionCode) {
  const transactionId = req.readUInt16BE(0);
  const protocolId = req.readUInt16BE(2);
  const res = Buffer.alloc(9);
  res.writeUInt16BE(transactionId, 0);
  res.writeUInt16BE(protocolId, 2);
  res.writeUInt16BE(3, 4); // Unit ID + Exception FC + exception code
  res.writeUInt8(unitId, 6);
  res.writeUInt8(fc | 0x80, 7);
  res.writeUInt8(exceptionCode, 8);
  return res;
}

// Construye la respuesta FC3 (Read Holding Registers). Diseño del frame:
//   [0-1] Transaction ID   - copiado de la solicitud
//   [2-3] Protocol ID      - 0x0000
//   [4-5] Length           - 3 + byteCount  (Unit ID + FC + ByteCount + data)
//   [6]   Unit ID
//   [7]   0x03 (Function Code)
//   [8]   Byte Count       - quantity * 4  (Enron: 4 bytes por registro)
//   [9..] Data bytes
// Nota: startAddress y quantity no se incluyen en la respuesta (solo en la solicitud).
function buildFc3Response(req, unitId, startAddress, quantity, dataBuffer) {
  const transactionId = req.readUInt16BE(0);
  const protocolId = req.readUInt16BE(2);
  const byteCount = dataBuffer.length;
  const res = Buffer.alloc(9 + byteCount);

  res.writeUInt16BE(transactionId, 0);
  res.writeUInt16BE(protocolId, 2);
  res.writeUInt16BE(3 + byteCount, 4); // Unit ID + FC + byteCount + data
  res.writeUInt8(unitId, 6);
  res.writeUInt8(0x03, 7);
  res.writeUInt8(byteCount, 8);
  dataBuffer.copy(res, 9);
  return res;
}

// Construye la respuesta FC1 (Read Coils). Diseño del frame idéntico a FC3
// salvo que [7] es 0x01 y los datos son coils bit-packed:
//   [8]   Byte Count       - ceil(quantity / 8)
//   [9..] Coil bytes       - bit 0 del byte 0 = primer coil solicitado (LSB-first)
function buildFc1Response(req, unitId, dataBuffer) {
  const transactionId = req.readUInt16BE(0);
  const protocolId = req.readUInt16BE(2);
  const byteCount = dataBuffer.length;
  const res = Buffer.alloc(9 + byteCount);

  res.writeUInt16BE(transactionId, 0);
  res.writeUInt16BE(protocolId, 2);
  res.writeUInt16BE(3 + byteCount, 4); // Unit ID + FC + byteCount + data
  res.writeUInt8(unitId, 6);
  res.writeUInt8(0x01, 7);
  res.writeUInt8(byteCount, 8);
  dataBuffer.copy(res, 9);
  return res;
}

// Genera el payload de datos para una respuesta FC3.
// En Enron Modbus cada dirección lógica produce 4 bytes (un registro de 32 bits),
// a diferencia del Modbus estándar donde un registro es 2 bytes.
// Por eso quantity=1 → byteCount=4; quantity=3 → byteCount=12.
// Si una dirección no existe en el modelo:
//   - missingRegister="zero"      → se devuelven 4 bytes en 0.
//   - missingRegister="exception" → se lanza error con modbusException=0x02
//     y processFrame responde con una excepción Modbus en lugar de datos parciales.
function buildDataBuffer(model, remoteIp, unitId, startAddress, quantity, nodeDefaults) {
  const defaults = Object.assign({}, nodeDefaults, model.defaults || {});
  const chunks = [];

  for (let i = 0; i < quantity; i += 1) {
    const address = startAddress + i;
    const reg = lookupRegister(model, remoteIp, unitId, address);

    if (!reg) {
      if ((defaults.missingRegister || "exception") === "zero") {
        chunks.push(encode32({ value: 0, type: defaults.type, byteOrder: defaults.byteOrder }, defaults));
      } else {
        const err = new Error(`Missing register ${address}`);
        err.modbusException = 0x02;
        throw err;
      }
    } else {
      chunks.push(encode32(reg, defaults));
    }
  }

  return Buffer.concat(chunks);
}

// Genera el payload de datos para una respuesta FC1 (coils digitales).
// Los coils se empaquetan LSB-first dentro de cada byte: el primer coil solicitado
// ocupa el bit 0 del primer byte, el segundo coil el bit 1, y así sucesivamente.
// Ejemplo: coils [1,0,1,1,0,0,0,0] → byte 0 = 0b00001101 = 0x0D.
// Si un coil no existe, el comportamiento es idéntico a buildDataBuffer:
//   "zero" → bit en 0 (continue saltea el seteo); "exception" → error Modbus 0x02.
function buildCoilsBuffer(model, remoteIp, unitId, startAddress, quantity, nodeDefaults) {
  const defaults = Object.assign({}, nodeDefaults, model.defaults || {});
  const byteCount = Math.ceil(quantity / 8);
  const data = Buffer.alloc(byteCount, 0);

  for (let i = 0; i < quantity; i += 1) {
    const address = startAddress + i;
    const coil = lookupCoil(model, remoteIp, unitId, address);

    if (!coil) {
      if ((defaults.missingRegister || "exception") === "zero") {
        continue;
      }
      const err = new Error(`Missing coil ${address}`);
      err.modbusException = 0x02;
      throw err;
    }

    if (encodeCoilBit(coil)) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      data[byteIndex] |= (1 << bitIndex);
    }
  }

  return data;
}

// Borra un grupo lógico o un punto individual del modelo. La granularidad del
// borrado depende de qué combinación de campos esté presente en el payload.
// El `mapName` ("registers" o "coils") se infiere del hint explícito (pointType,
// map, etc.) o automáticamente por rango: si address cae en [minCoilAddress,
// maxCoilAddress] se asume coil; si no, se asume register.
// Después de cada borrado se limpian los mapas que queden vacíos ({}) para
// mantener el modelo compacto y evitar colisión con isModelShape/hasGroupData.
function deleteNode(model, payload, minCoilAddress, maxCoilAddress) {
  const remoteKey = payload.remote !== undefined ? String(payload.remote) : null;
  const unitKey = payload.unitId !== undefined ? String(payload.unitId) : null;
  const addressStr = payload.address ?? payload.register;
  const addressKey = addressStr !== undefined ? String(addressStr) : null;
  const mapHint = String(payload.map ?? payload.area ?? payload.pointType ?? payload.dataType ?? payload.kind ?? "").toLowerCase();
  const addressNum = addressKey !== null ? Number.parseInt(addressKey, 10) : NaN;
  const mapName = (mapHint === "coil" || mapHint === "coils" || mapHint === "digital" || mapHint === "discrete")
    || (Number.isInteger(addressNum) && addressNum >= minCoilAddress && addressNum <= maxCoilAddress)
    ? "coils"
    : "registers";

  // remote + unitId + address → delete one register/coil
  if (remoteKey !== null && unitKey !== null && addressKey !== null) {
    const unitCfg = model.remotes && model.remotes[remoteKey] && model.remotes[remoteKey].unitIds && model.remotes[remoteKey].unitIds[unitKey];
    if (unitCfg && unitCfg[mapName]) {
      delete unitCfg[mapName][addressKey];
      if (Object.keys(unitCfg[mapName]).length === 0) delete unitCfg[mapName];
    }
    return { scope: "remoteUnit", remoteKey, unitKey };
  }

  // remote + unitId → delete entire unitId inside that remote
  if (remoteKey !== null && unitKey !== null) {
    if (model.remotes && model.remotes[remoteKey] && model.remotes[remoteKey].unitIds) {
      delete model.remotes[remoteKey].unitIds[unitKey];
      if (Object.keys(model.remotes[remoteKey].unitIds).length === 0) {
        delete model.remotes[remoteKey].unitIds;
      }
    }
    return { scope: "remoteUnit", remoteKey, unitKey };
  }

  // remote + address → delete one register/coil inside the remote (no unitId)
  if (remoteKey !== null && addressKey !== null) {
    const remoteCfg = model.remotes && model.remotes[remoteKey];
    if (remoteCfg && remoteCfg[mapName]) {
      delete remoteCfg[mapName][addressKey];
      if (Object.keys(remoteCfg[mapName]).length === 0) delete remoteCfg[mapName];
    }
    return { scope: "remote", remoteKey };
  }

  // remote only → delete the entire remote
  if (remoteKey !== null) {
    if (model.remotes) {
      delete model.remotes[remoteKey];
      if (Object.keys(model.remotes).length === 0) delete model.remotes;
    }
    return { scope: "remote", remoteKey };
  }

  // unitId + address → delete one register/coil inside global unitId
  if (unitKey !== null && addressKey !== null) {
    const unitCfg = model.unitIds && model.unitIds[unitKey];
    if (unitCfg && unitCfg[mapName]) {
      delete unitCfg[mapName][addressKey];
      if (Object.keys(unitCfg[mapName]).length === 0) delete unitCfg[mapName];
    }
    return { scope: "unit", unitKey };
  }

  // unitId only → delete entire unitId group
  if (unitKey !== null) {
    if (model.unitIds) {
      delete model.unitIds[unitKey];
      if (Object.keys(model.unitIds).length === 0) delete model.unitIds;
    }
    return { scope: "unit", unitKey };
  }

  // address only → delete from global registers/coils
  if (addressKey !== null) {
    if (model[mapName]) {
      delete model[mapName][addressKey];
      if (Object.keys(model[mapName]).length === 0) delete model[mapName];
    }
    return { scope: "global" };
  }

  throw new Error("deleteNode requires at least one of: remote, unitId, address");
}

// Crea o actualiza un único punto en el modelo a partir de un payload setValue.
// La lógica de selección de ámbito es:
//   - Si payload.remote está definido → target = model.remotes[remoteKey]
//     (si también hay unitId, escribe en .unitIds[unitKey] dentro del remote).
//   - Si solo hay unitId → target = model.unitIds[unitKey].
//   - Si ninguno → escribe directamente en model.registers o model.coils.
// El mapName ("registers"/"coils") se determina por hint explícito o por rango;
// el valueDef se construye con solo los campos definidos (los undefined se eliminan
// para no sobreescribir propiedades existentes con basura).
function patchRegisterValue(model, payload, minCoilAddress, maxCoilAddress) {
  const target = payload.remote ? "remotes" : (payload.unitId !== undefined ? "unitIds" : "registers");
  const remoteKey = payload.remote !== undefined ? String(payload.remote) : null;
  const unitKey = payload.unitId !== undefined ? String(payload.unitId) : null;
  const addressKey = String(payload.address ?? payload.register);
  const addressNum = Number.parseInt(addressKey, 10);
  const mapHint = String(payload.map ?? payload.area ?? payload.pointType ?? payload.dataType ?? payload.kind ?? "").toLowerCase();
  const mapName = (mapHint === "coil" || mapHint === "coils" || mapHint === "digital" || mapHint === "discrete")
    || (Number.isInteger(addressNum) && addressNum >= minCoilAddress && addressNum <= maxCoilAddress)
    ? "coils"
    : "registers";
  if (!addressKey || addressKey === "undefined") {
    throw new Error("setValue requires payload.address or payload.register");
  }

  const valueDef = mapName === "coils"
    ? {
      value: parseBooleanLike(payload.value),
      enabled: payload.enabled,
      exception: payload.exception,
      description: payload.description
    }
    : {
      value: payload.value,
      type: payload.type,
      byteOrder: payload.byteOrder,
      unit: payload.unit,
      description: payload.description,
      enabled: payload.enabled,
      exception: payload.exception
    };
  Object.keys(valueDef).forEach((k) => valueDef[k] === undefined && delete valueDef[k]);

  if (target === "remotes") {
    model.remotes = model.remotes || {};
    model.remotes[remoteKey] = model.remotes[remoteKey] || {};

    if (payload.unitId !== undefined) {
      model.remotes[remoteKey].unitIds = model.remotes[remoteKey].unitIds || {};
      model.remotes[remoteKey].unitIds[unitKey] = model.remotes[remoteKey].unitIds[unitKey] || {};
      model.remotes[remoteKey].unitIds[unitKey][mapName] = model.remotes[remoteKey].unitIds[unitKey][mapName] || {};
      model.remotes[remoteKey].unitIds[unitKey][mapName][addressKey] = valueDef;
      return { scope: "remoteUnit", remoteKey, unitKey };
    } else {
      model.remotes[remoteKey][mapName] = model.remotes[remoteKey][mapName] || {};
      model.remotes[remoteKey][mapName][addressKey] = valueDef;
      return { scope: "remote", remoteKey };
    }
  }

  if (target === "unitIds") {
    model.unitIds = model.unitIds || {};
    model.unitIds[unitKey] = model.unitIds[unitKey] || {};
    model.unitIds[unitKey][mapName] = model.unitIds[unitKey][mapName] || {};
    model.unitIds[unitKey][mapName][addressKey] = valueDef;
    return { scope: "unit", unitKey };
  }

  model[mapName] = model[mapName] || {};
  model[mapName][addressKey] = valueDef;
  return { scope: "global" };
}

module.exports = function register(RED) {
  function EnronModbusServerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Parámetros operativos del servidor TCP y límites de rangos Modbus.
    // maxQuantity se clampea a 62 para que byteCount (quantity*4) no supere 248 bytes,
    // manteniendo el mensaje dentro del tamaño máximo del campo Length de MBAP (16-bit).
    node.name = config.name;
    node.host = config.host || "0.0.0.0";
    node.port = toInt(config.port, 502);
    node.minAddress = toInt(config.minAddress, 7000);
    node.maxAddress = toInt(config.maxAddress, 7999);
    node.maxQuantity = Math.min(toInt(config.maxQuantity, 60), 62);
    node.minCoilAddress = toInt(config.minCoilAddress, 1000);
    node.maxCoilAddress = toInt(config.maxCoilAddress, 1999);
    node.maxCoilQuantity = toInt(config.maxCoilQuantity, 2000);
    node.defaultType = config.defaultType || "float32";
    node.defaultByteOrder = config.defaultByteOrder || "ABCD";
    node.missingRegister = config.missingRegister || "exception";
    // groupTimeoutMs soporta la propiedad legada groupTimeoutSeconds (convertida a minutos)
    // para retrocompatibilidad. El valor 0 desactiva completamente la limpieza automática.
    const timeoutMinutes = config.groupTimeoutMinutes !== undefined
      ? toInt(config.groupTimeoutMinutes, 0)
      : Math.ceil(Math.max(0, toInt(config.groupTimeoutSeconds, 0)) / 60);
    node.groupTimeoutMinutes = Math.max(0, timeoutMinutes);
    node.groupTimeoutMs = node.groupTimeoutMinutes * 60000;
    node.emitEvents = config.emitEvents !== false && config.emitEvents !== "false";

    // Modelo de datos activo en memoria (arranca con defaults y puede ser reemplazado).
    node.model = clone(DEFAULT_JSON);
    try {
      node.model = clone(safeJsonParse(config.dataJson, DEFAULT_JSON));
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "invalid JSON" });
      node.error(`Invalid Enron register JSON: ${err.message}`);
    }

    node.server = null;
    node.connections = new Set();
    // Estructura auxiliar para timeout por grupo lógico.
    node.groupActivity = buildActivityState(node.model);
    node.groupCleanupTimer = null;

    // Defaults efectivos del nodo usados como fallback durante la codificación.
    function nodeDefaults() {
      return {
        type: node.defaultType,
        byteOrder: node.defaultByteOrder,
        missingRegister: node.missingRegister
      };
    }

    // Recalcula actividad completa, útil tras reemplazo integral del modelo.
    function refreshGroupActivity() {
      node.groupActivity = buildActivityState(node.model);
      pruneExpiredGroups(node.model, node.groupActivity, node.groupTimeoutMs, Date.now(), emitGroupExpired);
    }

    // Programa (o cancela) el recolector periódico de grupos expirados.
    // El intervalo se fija en timeout/4 para que un grupo detecte su expiración
    // con una latencia máxima del 25 % del tiempo configurado, con un piso de
    // 1 segundo y un techo de 5 minutos para evitar intervalos demasiado cortos
    // o demasiado largos. `unref()` evita que el timer impida que el proceso Node.js
    // termine si no hay más trabajo pendiente (importante en reinicios de Node-RED).
    function maybeScheduleCleanup() {
      if (node.groupCleanupTimer) {
        clearInterval(node.groupCleanupTimer);
        node.groupCleanupTimer = null;
      }

      if (node.groupTimeoutMs <= 0) return;

      const intervalMs = Math.max(1000, Math.min(Math.floor(node.groupTimeoutMs / 4), 300000));
      node.groupCleanupTimer = setInterval(() => {
        try {
          // Limpieza incremental: recorre actividad y podará ramas inactivas.
          pruneExpiredGroups(node.model, node.groupActivity, node.groupTimeoutMs, Date.now(), emitGroupExpired);
        } catch (err) {
          node.warn(`Group cleanup failed: ${err.message}`);
        }
      }, intervalMs);

      if (node.groupCleanupTimer.unref) {
        node.groupCleanupTimer.unref();
      }
    }

    // Envía un mensaje a la salida del nodo para trazabilidad de eventos en el flujo.
    // Si emitEvents está desactivado (configuración UI), todos los eventos se suprimen;
    // esto evita inundar el flujo en despliegues de producción con tráfico alto.
    function emit(event, payload) {
      if (!node.emitEvents) return;
      node.send({
        topic: `enron-modbus/${event}`,
        payload: Object.assign({ event, ts: new Date().toISOString() }, payload || {})
      });
    }

    function emitGroupExpired(info) {
      emit("group_expired", info);
    }

    // Centraliza la escritura de la excepción al socket y el evento de salida,
    // garantizando que ambos siempre ocurran juntos y con el mismo formato.
    function sendException(socket, frame, unitId, fc, exceptionCode, details) {
      socket.write(buildExceptionResponse(frame, unitId, fc, exceptionCode));
      emit("exception", {
        remoteIp: normalizeIp(socket.remoteAddress),
        remotePort: socket.remotePort,
        unitId,
        functionCode: fc,
        exceptionCode,
        details
      });
    }

    // Procesa una trama Modbus TCP completa (MBAP + PDU) leida del buffer rx.
    // El orden de validaciones es de mayor a menor costo: primero cheques baratos
    // (tamaño, protocolId, FC) antes de buscar en el modelo o codificar datos.
    function processFrame(socket, frame) {
      if (frame.length < 12) {
        // 6 bytes MBAP + 1 Unit + 1 FC + 2 StartAddr + 2 Quantity = 12 bytes mínimos
        emit("malformed", { remoteIp: normalizeIp(socket.remoteAddress), length: frame.length });
        return;
      }

      const protocolId = frame.readUInt16BE(2);
      const unitId = frame.readUInt8(6);
      const fc = frame.readUInt8(7);
      const startAddress = frame.readUInt16BE(8);
      const quantity = frame.readUInt16BE(10);
      const remoteIp = normalizeIp(socket.remoteAddress);

      emit("request", {
        remoteIp,
        remotePort: socket.remotePort,
        unitId,
        functionCode: fc,
        startAddress,
        quantity
      });

      if (protocolId !== 0) {
        // Protocol ID distinto de 0 indica un protocolo diferente (no Modbus).
        // Se destruye el socket para no dejar la conexión en estado indefinido.
        emit("malformed", { remoteIp, reason: "protocolId != 0", protocolId });
        socket.destroy();
        return;
      }

      if (fc !== 0x03 && fc !== 0x01) {
        sendException(socket, frame, unitId, fc, 0x01, "Only function code 1 and 3 are supported");
        return;
      }

      const isFc3 = fc === 0x03;
      const maxQuantity = isFc3 ? node.maxQuantity : node.maxCoilQuantity;
      const minAddress = isFc3 ? node.minAddress : node.minCoilAddress;
      const maxAddress = isFc3 ? node.maxAddress : node.maxCoilAddress;

      if (quantity < 1 || quantity > maxQuantity) {
        sendException(socket, frame, unitId, fc, 0x03, `Invalid quantity ${quantity}`);
        return;
      }

      if (startAddress < minAddress || (startAddress + quantity - 1) > maxAddress) {
        sendException(socket, frame, unitId, fc, 0x02, `Address out of range: ${startAddress}..${startAddress + quantity - 1}`);
        return;
      }

      let data;
      try {
        // FC3 arma registros de 32 bits; FC1 arma bits de coils.
        data = isFc3
          ? buildDataBuffer(node.model, remoteIp, unitId, startAddress, quantity, nodeDefaults())
          : buildCoilsBuffer(node.model, remoteIp, unitId, startAddress, quantity, nodeDefaults());
      } catch (err) {
        const code = err.modbusException || 0x04;
        sendException(socket, frame, unitId, fc, code, err.message);
        return;
      }

      const response = isFc3 ? buildFc3Response(frame, unitId, startAddress, quantity, data) : buildFc1Response(frame, unitId, data);
      socket.write(response);
      emit("response", {
        remoteIp,
        remotePort: socket.remotePort,
        unitId,
        functionCode: fc,
        startAddress,
        quantity,
        byteCount: data.length
      });
    }

    // Gestiona el ciclo de vida de una conexión TCP entrante y el reensamblado
    // de tramas Modbus desde el stream de bytes.
    // Problema a resolver: TCP es un protocolo de stream, no de mensajes. Un evento
    // 'data' puede contener una trama parcial, múltiples tramas, o cualquier combinación.
    // Solución: acumular bytes en `rx` y extraer tramas completas usando el campo
    // Length del MBAP: totalFrameLength = 6 (MBAP header) + mbapLength.
    function handleSocket(socket) {
      node.connections.add(socket);
      emit("client_connected", {
        remoteIp: normalizeIp(socket.remoteAddress),
        remotePort: socket.remotePort
      });

      let rx = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        rx = Buffer.concat([rx, chunk]);
        // El stream puede traer varias tramas o tramas parciales; se procesa por MBAP length.
        while (rx.length >= 7) {
          const mbapLength = rx.readUInt16BE(4);
          const totalFrameLength = 6 + mbapLength;

          if (mbapLength < 2 || mbapLength > 260) {
            emit("malformed", {
              remoteIp: normalizeIp(socket.remoteAddress),
              reason: "invalid MBAP length",
              mbapLength
            });
            socket.destroy();
            return;
          }

          if (rx.length < totalFrameLength) break;

          const frame = rx.subarray(0, totalFrameLength);
          rx = rx.subarray(totalFrameLength);
          processFrame(socket, frame);
        }
      });

      socket.on("error", (err) => {
        emit("client_error", {
          remoteIp: normalizeIp(socket.remoteAddress),
          remotePort: socket.remotePort,
          error: err.message
        });
      });

      socket.on("close", () => {
        node.connections.delete(socket);
        emit("client_disconnected", {
          remoteIp: normalizeIp(socket.remoteAddress),
          remotePort: socket.remotePort
        });
      });
    }

    // Levanta el servidor TCP. Si el puerto está ocupado o el host no existe,
    // el evento 'error' actualiza el status del nodo con el mensaje de error.
    function startServer() {
      node.server = net.createServer(handleSocket);

      node.server.on("error", (err) => {
        node.status({ fill: "red", shape: "ring", text: err.message });
        node.error(`Enron Modbus server error: ${err.message}`);
        emit("server_error", { error: err.message });
      });

      node.server.listen(node.port, node.host, () => {
        node.status({ fill: "green", shape: "dot", text: `${node.host}:${node.port}` });
        emit("server_started", { host: node.host, port: node.port });
      });
    }

    maybeScheduleCleanup();

    node.on("input", (msg, send, done) => {
      try {
        const payload = msg.payload;
        const action = msg.action || (isPlainObject(payload) ? payload.action : undefined);

        // Modo 1: borrado granular de grupos/puntos.
        if (action === "deleteNode") {
          if (!isPlainObject(payload)) {
            throw new Error("deleteNode requires msg.payload as object");
          }
          const deleteInfo = deleteNode(node.model, Object.assign({}, payload, msg), node.minCoilAddress, node.maxCoilAddress);
          // Limpia el registro de actividad del grupo borrado para que el timer
          // de limpieza no intente evaluar un grupo que ya no existe en el modelo.
          if (deleteInfo.scope === "global") {
            node.groupActivity.global = null;
          } else if (deleteInfo.scope === "unit") {
            delete node.groupActivity.unitIds[deleteInfo.unitKey];
          } else if (deleteInfo.scope === "remote") {
            delete node.groupActivity.remotes[deleteInfo.remoteKey];
          } else if (deleteInfo.scope === "remoteUnit") {
            if (node.groupActivity.remotes[deleteInfo.remoteKey]) {
              delete node.groupActivity.remotes[deleteInfo.remoteKey].unitIds[deleteInfo.unitKey];
            }
          }
          emit("config_updated", { mode: "deleteNode", ...deleteInfo });
        // Modo 2: actualización puntual de un valor (setValue).
        // La acción puede venir como msg.action o como payload.action porque
        // el nodo Inject de Node-RED puede enviar el JSON completo en msg.payload.
        } else if (action === "setValue") {
          // action can come from msg.action or msg.payload.action (Inject node sends JSON to payload)
          if (!isPlainObject(payload)) {
            throw new Error("setValue requires msg.payload as object with {address, value, remote, unitId, ...}");
          }
          const updateInfo = patchRegisterValue(node.model, Object.assign({}, payload, msg), node.minCoilAddress, node.maxCoilAddress);
          touchGroupActivity(node.groupActivity, updateInfo);
          pruneExpiredGroups(node.model, node.groupActivity, node.groupTimeoutMs, Date.now(), emitGroupExpired);
          emit("config_updated", { mode: "setValue" });
        // Modo 3: reemplazo total del modelo enviado como string JSON.
        } else if (typeof payload === "string") {
          // JSON string model
          node.model = safeJsonParse(payload, node.model);
          refreshGroupActivity();
          emit("config_updated", { mode: "replace" });
        // Modo 4: patch/merge de modelo con forma compatible.
        } else if (isPlainObject(payload) && isModelShape(payload)) {
          // Object model with proper shape (defaults/registers/coils/unitIds/remotes)
          node.model = mergeModel(node.model, payload);
          markPatchActivity(node.groupActivity, payload);
          pruneExpiredGroups(node.model, node.groupActivity, node.groupTimeoutMs, Date.now(), emitGroupExpired);
          emit("config_updated", { mode: "replace" });
        } else {
          // Reject ambiguous input
          throw new Error("Invalid input: msg.payload must be model JSON OR contain action='setValue'. Check your Inject node.");
        }

        node.status({ fill: "green", shape: "dot", text: `${node.host}:${node.port} updated` });
        if (done) done();
      } catch (err) {
        // Ante error se notifica al runtime y se deja traza visible en estado del nodo.
        node.error(err, msg);
        node.status({ fill: "yellow", shape: "ring", text: err.message });
        if (done) done(err);
      }
    });

    node.on("close", (removed, done) => {
      // Liberación ordenada: primero el timer, luego los sockets activos (para que no
      // lleguen nuevas tramas mientras se cierra el servidor), y finalmente el servidor.
      // node.server.close() deja de aceptar conexiones nuevas pero espera a que las
      // existentes terminen; como ya destruimos los sockets, el callback se llama pronto.
      if (node.groupCleanupTimer) {
        clearInterval(node.groupCleanupTimer);
        node.groupCleanupTimer = null;
      }

      for (const socket of node.connections) {
        socket.destroy();
      }
      node.connections.clear();

      if (node.server) {
        node.server.close(() => {
          node.server = null;
          node.status({});
          if (done) done();
        });
      } else if (done) {
        done();
      }
    });

    startServer();
  }

  RED.nodes.registerType("enron-modbus-server", EnronModbusServerNode);

  // Endpoint REST para que la pestaña "Modelo activo" del panel de edición
  // pueda consultar el estado en tiempo real del modelo en memoria sin necesidad
  // de redeployar el flujo. Requiere el permiso 'enron-modbus-server.read'.
  RED.httpAdmin.get("/enron-modbus-server/:id/model",
    RED.auth.needsPermission("flows.read"),
    function(req, res) {
      const node = RED.nodes.getNode(req.params.id);
      if (!node || !node.model) {
        return res.status(404).json({ error: "Node not found or not running" });
      }
      res.json(node.model);
    }
  );
};

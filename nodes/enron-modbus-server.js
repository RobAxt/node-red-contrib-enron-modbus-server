"use strict";

const net = require("net");

const DEFAULT_JSON = {
  defaults: {
    type: "float32",
    byteOrder: "ABCD",
    missingRegister: "exception"
  },
  coils: {
    "1000": { value: true },
    "1001": { value: false }
  }
};

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}

function ipv4ToInt(ip) {
  const parts = String(ip).split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

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

function safeJsonParse(text, fallback) {
  if (typeof text === "object" && text !== null) return text;
  if (typeof text !== "string" || text.trim() === "") return fallback;
  return JSON.parse(text);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelShape(value) {
  if (!isPlainObject(value)) return false;
  return ["defaults", "registers", "coils", "unitIds", "remotes"].some((k) => Object.prototype.hasOwnProperty.call(value, k));
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

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

function mergeModel(targetModel, patchModel) {
  return mergePlainObjects(targetModel || {}, patchModel || {});
}

function hasGroupData(group) {
  if (!isPlainObject(group)) return false;
  const registers = group.registers;
  const coils = group.coils;
  const hasRegisters = isPlainObject(registers) && Object.keys(registers).length > 0;
  const hasCoils = isPlainObject(coils) && Object.keys(coils).length > 0;
  return hasRegisters || hasCoils;
}

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

function lookupRegister(model, remoteIp, unitId, address) {
  return lookupAddress(model, remoteIp, unitId, address, "registers");
}

function lookupCoil(model, remoteIp, unitId, address) {
  return lookupAddress(model, remoteIp, unitId, address, "coils");
}

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
    const timeoutMinutes = config.groupTimeoutMinutes !== undefined
      ? toInt(config.groupTimeoutMinutes, 0)
      : Math.ceil(Math.max(0, toInt(config.groupTimeoutSeconds, 0)) / 60);
    node.groupTimeoutMinutes = Math.max(0, timeoutMinutes);
    node.groupTimeoutMs = node.groupTimeoutMinutes * 60000;
    node.emitEvents = config.emitEvents !== false && config.emitEvents !== "false";

    node.model = clone(DEFAULT_JSON);
    try {
      node.model = clone(safeJsonParse(config.dataJson, DEFAULT_JSON));
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "invalid JSON" });
      node.error(`Invalid Enron register JSON: ${err.message}`);
    }

    node.server = null;
    node.connections = new Set();
    node.groupActivity = buildActivityState(node.model);
    node.groupCleanupTimer = null;

    function nodeDefaults() {
      return {
        type: node.defaultType,
        byteOrder: node.defaultByteOrder,
        missingRegister: node.missingRegister
      };
    }

    function refreshGroupActivity() {
      node.groupActivity = buildActivityState(node.model);
      pruneExpiredGroups(node.model, node.groupActivity, node.groupTimeoutMs, Date.now(), emitGroupExpired);
    }

    function maybeScheduleCleanup() {
      if (node.groupCleanupTimer) {
        clearInterval(node.groupCleanupTimer);
        node.groupCleanupTimer = null;
      }

      if (node.groupTimeoutMs <= 0) return;

      const intervalMs = Math.max(1000, Math.min(Math.floor(node.groupTimeoutMs / 4), 300000));
      node.groupCleanupTimer = setInterval(() => {
        try {
          pruneExpiredGroups(node.model, node.groupActivity, node.groupTimeoutMs, Date.now(), emitGroupExpired);
        } catch (err) {
          node.warn(`Group cleanup failed: ${err.message}`);
        }
      }, intervalMs);

      if (node.groupCleanupTimer.unref) {
        node.groupCleanupTimer.unref();
      }
    }

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

    function processFrame(socket, frame) {
      if (frame.length < 12) {
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

    function handleSocket(socket) {
      node.connections.add(socket);
      emit("client_connected", {
        remoteIp: normalizeIp(socket.remoteAddress),
        remotePort: socket.remotePort
      });

      let rx = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        rx = Buffer.concat([rx, chunk]);
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

        if (action === "deleteNode") {
          if (!isPlainObject(payload)) {
            throw new Error("deleteNode requires msg.payload as object");
          }
          const deleteInfo = deleteNode(node.model, Object.assign({}, payload, msg), node.minCoilAddress, node.maxCoilAddress);
          // remove the deleted group from activity tracking so it doesn't linger
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
        } else if (action === "setValue") {
          // action can come from msg.action or msg.payload.action (Inject node sends JSON to payload)
          if (!isPlainObject(payload)) {
            throw new Error("setValue requires msg.payload as object with {address, value, remote, unitId, ...}");
          }
          const updateInfo = patchRegisterValue(node.model, Object.assign({}, payload, msg), node.minCoilAddress, node.maxCoilAddress);
          touchGroupActivity(node.groupActivity, updateInfo);
          pruneExpiredGroups(node.model, node.groupActivity, node.groupTimeoutMs, Date.now(), emitGroupExpired);
          emit("config_updated", { mode: "setValue" });
        } else if (typeof payload === "string") {
          // JSON string model
          node.model = safeJsonParse(payload, node.model);
          refreshGroupActivity();
          emit("config_updated", { mode: "replace" });
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
        node.error(err, msg);
        node.status({ fill: "yellow", shape: "ring", text: err.message });
        if (done) done(err);
      }
    });

    node.on("close", (removed, done) => {
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

  RED.httpAdmin.get("/enron-modbus-server/:id/model",
    RED.auth.needsPermission("enron-modbus-server.read"),
    function(req, res) {
      const node = RED.nodes.getNode(req.params.id);
      if (!node || !node.model) {
        return res.status(404).json({ error: "Node not found or not running" });
      }
      res.json(node.model);
    }
  );
};

# Explicación técnica: `nodes/enron-modbus-server.js`

Este documento explica el diseño interno y el flujo de ejecución del nodo Node-RED que implementa un servidor **Modbus TCP estilo Enron/Daniels**.

---

## 1. Qué hace el nodo

Implementa un servidor Modbus TCP con las siguientes características diferenciadoras:

| Característica | Detalle |
|---|---|
| FC3 (0x03) | Cada dirección lógica devuelve **4 bytes** (entero o float de 32 bits) |
| FC1 (0x01) | Coils digitales empaquetados en bits, LSB-first por byte |
| Resolución contextual | La respuesta puede variar según la IP del cliente, su Unit ID, o ambos |
| Actualización dinámica | El modelo de datos se puede modificar en caliente desde el flujo |
| Timeout por grupo | Los grupos sin actividad se eliminan automáticamente |

---

## 2. Organización del archivo

El archivo se divide en cinco bloques funcionales claramente delimitados:

```
enron-modbus-server.js
│
├── [BLOQUE 1] Utilidades generales
│   ├── toInt, safeJsonParse
│   ├── isPlainObject, isModelShape, clone
│   └── mergePlainObjects, mergeModel
│
├── [BLOQUE 2] Utilidades de red / IP
│   ├── normalizeIp       — elimina prefijo ::ffff: de IPv4-mapped IPv6
│   ├── ipv4ToInt         — convierte IPv4 a entero de 32 bits (para CIDR)
│   └── matchesRemote     — compara IP contra exacto / * / CIDR
│
├── [BLOQUE 3] Gestión de actividad y timeout de grupos
│   ├── hasGroupData      — ¿tiene datos el grupo?
│   ├── buildActivityState — inicializa timestamps por grupo
│   ├── markPatchActivity  — marca actividad tras merge parcial
│   ├── touchGroupActivity — marca actividad tras setValue
│   └── pruneExpiredGroups — elimina grupos vencidos
│
├── [BLOQUE 4] Resolución de direcciones y codificación
│   ├── lookupAddress / lookupRegister / lookupCoil
│   ├── parseBooleanLike, encodeCoilBit
│   ├── orderBytes, encode32
│   ├── buildExceptionResponse
│   ├── buildFc3Response, buildFc1Response
│   ├── buildDataBuffer, buildCoilsBuffer
│   ├── deleteNode
│   └── patchRegisterValue
│
└── [BLOQUE 5] Runtime Node-RED
    ├── EnronModbusServerNode (constructor del nodo)
    │   ├── nodeDefaults, refreshGroupActivity, maybeScheduleCleanup
    │   ├── emit, emitGroupExpired, sendException
    │   ├── processFrame, handleSocket, startServer
    │   └── Handlers: input, close
    └── RED.httpAdmin.get  — endpoint de administración
```

---

## 3. Modelo de datos en memoria (`node.model`)

El nodo mantiene un único objeto JavaScript como fuente de verdad en tiempo de ejecución. Su estructura completa es:

```json
{
  "defaults": {
    "type": "float32",
    "byteOrder": "ABCD",
    "missingRegister": "exception"
  },
  "registers": {
    "7001": { "value": 12.34, "type": "float32" }
  },
  "coils": {
    "1000": { "value": true }
  },
  "unitIds": {
    "17": {
      "registers": { "7001": { "value": 99.0 } },
      "coils":     { "1000": { "value": false } }
    }
  },
  "remotes": {
    "192.168.3.100": {
      "registers": { "7001": { "value": 1.11 } },
      "unitIds": {
        "17": {
          "registers": { "7001": { "value": 333.44 } }
        }
      }
    },
    "192.168.3.0/24": {
      "registers": { "7002": { "value": 22.22 } }
    }
  }
}
```

Cada nivel puede definir `registers` y/o `coils`. La clave de cada dirección es un **string** (aunque se accede con número, se convierte internamente con `String(address)`).

### Campos de un punto

Un punto puede ser un objeto con propiedades de control o directamente un valor primitivo:

| Campo | Tipo | Efecto |
|---|---|---|
| `value` | number / boolean / string | Valor a codificar |
| `type` | string | Tipo de codificación (`float32`, `int32`, `uint32`, `hex32`) |
| `byteOrder` | string | Orden de bytes (`ABCD`, `CDAB`, `BADC`, `DCBA`) |
| `enabled` | boolean | Si es `false`, la dirección responde excepción 0x02 |
| `exception` | number | Fuerza respuesta de excepción con ese código Modbus |
| `unit` | string | Metadato descriptivo (no afecta la respuesta) |
| `description` | string | Metadato descriptivo (no afecta la respuesta) |

---

## 4. Prioridad de resolución de direcciones

Cuando llega una petición con `remoteIp = 192.168.3.100` y `unitId = 17`, la búsqueda de la dirección 7001 sigue este árbol:

```
lookupAddress(model, "192.168.3.100", 17, 7001, "registers")
│
├── Prioridad 1 — remotes[patrón coincidente].unitIds["17"].registers["7001"]
│   └── Verifica: model.remotes["192.168.3.100"].unitIds["17"].registers["7001"]  ✓ usa este si existe
│
├── Prioridad 2 — remotes[patrón coincidente].registers["7001"]
│   └── Verifica: model.remotes["192.168.3.100"].registers["7001"]
│               model.remotes["192.168.3.0/24"].registers["7001"]  (evaluado por CIDR)
│
├── Prioridad 3 — unitIds["17"].registers["7001"]
│   └── Verifica: model.unitIds["17"].registers["7001"]
│
└── Prioridad 4 — registers["7001"] (global)
    └── Verifica: model.registers["7001"]
```

**Nota sobre CIDR:** `matchesRemote` itera todos los patrones registrados en `model.remotes`. Cuando el patrón contiene `/`, convierte ambas IPs a enteros de 32 bits y aplica la máscara:

```
mask = (0xFFFFFFFF << (32 - bits)) >>> 0
match = (ipInt & mask) === (netInt & mask)
```

El `>>> 0` es obligatorio porque JavaScript hace las operaciones bitwise en int32 con signo; sin él, las IPs ≥ 128.0.0.0 producirían valores negativos que nunca coincidirían.

---

## 5. Formato de trama Modbus TCP

### 5.1 Solicitud de entrada (FC1 / FC3)

```
Byte offset:  0    1    2    3    4    5    6    7    8    9   10   11
              ├────┴────┼────┴────┼────┴────┼────┼────┼────┴────┼────┴────┤
Contenido:    Transaction ID     Protocol  Length  UnitID  FC   StartAddr  Quantity
              (copiado en resp)   0x0000   0x0006
```

- **Length** (bytes 4-5): número de bytes desde `UnitID` en adelante = 6 para solicitudes FC1/FC3.
- `totalFrameLength = 6 + mbapLength`; con `mbapLength = 6` eso da 12 bytes.

### 5.2 Respuesta normal

```
Byte offset:  0    1    2    3    4    5    6    7    8   [9 .. 9+N-1]
              ├────┴────┼────┴────┼────┴────┼────┼────┼────────────────┤
Contenido:    Transaction ID     Protocol  Length  Unit  FC  ByteCount  Data...
              (igual que req)    0x0000   3+N
```

- **FC3:** `N = quantity × 4` (4 bytes por registro, estilo Enron).
- **FC1:** `N = ceil(quantity / 8)` (bits empaquetados LSB-first).

### 5.3 Respuesta de excepción

```
Byte offset:  0    1    2    3    4    5    6    7    8
              ├────┴────┼────┴────┼────┴────┼────┼────┼────┤
Contenido:    Transaction ID     Protocol  0x3  Unit  FC|80  ExCode
```

- `FC | 0x80` señaliza al cliente que es una excepción.
- Longitud fija de 9 bytes.

---

## 6. Codificación de valores

### 6.1 Registros FC3 (`encode32`)

El valor se escribe en big-endian en un buffer de 4 bytes y luego se permutan los bytes según `byteOrder`:

| Tipo | Función Node.js | Ejemplo (valor = 1.0) |
|---|---|---|
| `float32` / `float` / `real` | `writeFloatBE` | `3F 80 00 00` |
| `int32` / `long` | `writeInt32BE` | `00 00 00 01` |
| `uint32` / `ulong` | `writeUInt32BE` | `00 00 00 01` |
| `hex32` / `raw32` | parse hex string | según el string |

#### Permutaciones de byte order (`orderBytes`)

| Nombre | Posiciones en wire | Uso típico |
|---|---|---|
| `ABCD` | `[A, B, C, D]` | Big-endian estándar (IEC 61131, PLCs Siemens) |
| `CDAB` | `[C, D, A, B]` | Word-swap / mid-big (Modicon legacy) |
| `BADC` | `[B, A, D, C]` | Byte-swap dentro de cada word |
| `DCBA` | `[D, C, B, A]` | Little-endian completo (x86 nativo) |

### 6.2 Coils FC1 (`encodeCoilBit` + `buildCoilsBuffer`)

El empaquetado es **LSB-first** dentro de cada byte, igual que en Modbus estándar:

```
Coils solicitados:   [addr+0, addr+1, addr+2, addr+3, addr+4, addr+5, addr+6, addr+7]
Valores booleanos:   [  1,      0,      1,      1,      0,      0,      0,      0   ]
Byte resultante:      bit7=0 bit6=0 bit5=0 bit4=0 bit3=1 bit2=1 bit1=0 bit0=1 = 0x0D
```

`parseBooleanLike` acepta como `true`: `true`, `1`, `"1"`, `"true"`, `"on"`, `"yes"`.

---

## 7. Reensamblado de tramas TCP (`handleSocket`)

TCP es un protocolo de stream: un mismo evento `data` puede contener múltiples tramas o una trama parcial. La función `handleSocket` acumula bytes en `rx` y extrae tramas completas usando el campo Length del MBAP:

```
[datos acumulados en rx]
│
├── rx.length < 7 → esperar más datos
│
├── leer mbapLength = rx.readUInt16BE(4)
│   totalFrameLength = 6 + mbapLength
│
├── mbapLength fuera de rango [2, 260] → "malformed", socket.destroy()
│
├── rx.length < totalFrameLength → esperar más datos (break)
│
└── extraer frame = rx.subarray(0, totalFrameLength)
    rx = rx.subarray(totalFrameLength)
    → processFrame(socket, frame)
    → repetir con el resto del buffer
```

---

## 8. Validaciones en `processFrame`

El orden está optimizado: primero los chequeos más baratos antes de tocar el modelo:

```
1. frame.length < 12        → "malformed" (trama demasiado corta)
2. protocolId !== 0         → "malformed" + socket.destroy() (no es Modbus)
3. fc !== 0x01 && fc !== 0x03 → excepción 0x01 (Function Code no soportado)
4. quantity fuera de rango  → excepción 0x03 (Illegal Data Value)
5. dirección fuera de rango → excepción 0x02 (Illegal Data Address)
6. buildDataBuffer / buildCoilsBuffer lanza error → excepción con código del error
7. Todo OK → socket.write(response) + emit("response", ...)
```

### Excepciones Modbus usadas

| Código | Nombre estándar | Cuándo se usa |
|---|---|---|
| `0x01` | Illegal Function | FC distinto de 01 y 03 |
| `0x02` | Illegal Data Address | Dirección fuera de rango, registro faltante (si `exception`), coil deshabilitado |
| `0x03` | Illegal Data Value | Quantity fuera de rango |
| `0x04` | Slave Device Failure | Tipo de registro no soportado, u otros errores internos |

---

## 9. Mensajes de entrada al nodo (handler `input`)

El nodo distingue cuatro modos de operación por el contenido de `msg`:

### Modo 1 — `action: "deleteNode"`

Borra un grupo lógico o un punto individual. La granularidad depende de qué campos incluya el payload:

| Campos presentes | Qué se borra |
|---|---|
| `remote` + `unitId` + `address` | Un punto en `remotes[r].unitIds[u]` |
| `remote` + `unitId` | El unitId completo dentro del remote |
| `remote` + `address` | Un punto en `remotes[r]` (nivel remote) |
| `remote` | El remote completo |
| `unitId` + `address` | Un punto en `unitIds[u]` global |
| `unitId` | El unitId global completo |
| `address` | Un punto en `registers` / `coils` global |

### Modo 2 — `action: "setValue"`

Crea o actualiza un único punto. La inferencia del ámbito es:

```
¿payload.remote definido?
  ├── Sí  → model.remotes[remote]
  │         ¿también payload.unitId?
  │           ├── Sí → model.remotes[remote].unitIds[unitId].[registers|coils][address]
  │           └── No → model.remotes[remote].[registers|coils][address]
  └── No  → ¿payload.unitId definido?
              ├── Sí → model.unitIds[unitId].[registers|coils][address]
              └── No → model.[registers|coils][address]  (global)
```

El `mapName` (`"registers"` o `"coils"`) se deduce por:
1. Hint explícito en campos `pointType`, `map`, `area`, `dataType`, `kind`.
2. Si `address` cae en `[minCoilAddress, maxCoilAddress]` → `"coils"`.
3. En cualquier otro caso → `"registers"`.

### Modo 3 — payload es un string JSON

Reemplaza el modelo completo. Se parsea con `safeJsonParse` y se recalcula la actividad desde cero.

### Modo 4 — payload es un objeto con forma de modelo

Hace un merge profundo sobre el modelo existente. Solo se sobrescriben las claves que vienen en el payload; el resto permanece intacto.

---

## 10. Timeout de grupos y limpieza automática

### Estructura de actividad (`node.groupActivity`)

```js
{
  global: 1747123456789,          // timestamp de última actualización del grupo global
  unitIds: {
    "17": 1747123456789
  },
  remotes: {
    "192.168.3.100": {
      ts: 1747123456789,          // actividad del remote en sí
      unitIds: {
        "17": 1747123456789       // actividad del unit dentro del remote
      }
    }
  }
}
```

### Intervalo del timer (`maybeScheduleCleanup`)

```
intervalMs = clamp(floor(groupTimeoutMs / 4), 1000, 300000)
```

Esto garantiza que un grupo detecte su expiración con una latencia máxima del 25 % del tiempo configurado, con un mínimo de 1 segundo y un máximo de 5 minutos. Se llama `timer.unref()` para que el timer no bloquee la salida del proceso Node.js durante reinicios de Node-RED.

### Cascade de borrado en `pruneExpiredGroups`

```
Para cada grupo con actividad registrada:
│
├── (now - ts) < timeoutMs → grupo vigente, continuar
│
└── (now - ts) >= timeoutMs → EXPIRADO
    ├── Si scope = global → delete model.registers + model.coils
    ├── Si scope = unit   → delete model.unitIds[unitKey]
    ├── Si scope = remote → delete model.remotes[remoteKey]
    └── Si scope = remoteUnit → delete model.remotes[r].unitIds[u]
    └── En todos los casos: limpiar ramas vacías {} + llamar onExpired(info)
```

---

## 11. Eventos emitidos por salida

Si `emitEvents` está activo, cada evento genera un mensaje con `msg.topic = "enron-modbus/<evento>"` y `msg.payload` con los siguientes campos mínimos:

| Evento | Cuándo | Campos en payload |
|---|---|---|
| `server_started` | El servidor TCP inicia | `host`, `port` |
| `server_error` | Error en el servidor | `error` |
| `client_connected` | Nueva conexión TCP | `remoteIp`, `remotePort` |
| `client_disconnected` | Conexión cerrada | `remoteIp`, `remotePort` |
| `client_error` | Error de socket | `remoteIp`, `remotePort`, `error` |
| `request` | Trama válida recibida | `remoteIp`, `remotePort`, `unitId`, `functionCode`, `startAddress`, `quantity` |
| `response` | Respuesta enviada | igual que `request` + `byteCount` |
| `exception` | Excepción Modbus enviada | igual que `request` + `exceptionCode`, `details` |
| `malformed` | Trama inválida | `remoteIp`, `reason` / `length` / `mbapLength` |
| `config_updated` | Modelo modificado | `mode` (`deleteNode`/`setValue`/`replace`) + scope info |
| `group_expired` | Grupo eliminado por timeout | `scope`, `remoteKey?`, `unitKey?` |

Todos incluyen `event` (nombre del evento) y `ts` (ISO timestamp).

---

## 12. Ciclo de vida del nodo

```
CREAR NODO
│
├── Leer config → node.host, port, ranges, defaults, timeout, emitEvents
├── Parsear node.model (desde config.dataJson o DEFAULT_JSON)
├── buildActivityState(node.model) → node.groupActivity
├── maybeScheduleCleanup() → setInterval si timeout > 0
└── startServer() → net.createServer → server.listen → status "green"

RECIBIR MENSAJE (node.on "input")
│
└── Identificar modo → deleteNode / setValue / string / mergeModel
    → Mutar node.model → Actualizar actividad → Podar expirados → emit "config_updated"

CERRAR NODO (node.on "close")
│
├── clearInterval(groupCleanupTimer)
├── socket.destroy() para cada socket activo
├── server.close(callback)
└── callback → node.server = null, node.status({})
```

---

## 13. Endpoint HTTP de administración

```
GET /enron-modbus-server/:id/model
```

- Requiere permiso `enron-modbus-server.read` (gestionado por Node-RED).
- Devuelve `node.model` serializado como JSON.
- Si el nodo no existe o no está activo, responde `404`.
- La UI del nodo llama a este endpoint al abrir el panel de edición y al pulsar el botón "Actualizar".

---

## 14. Referencia rápida de funciones

| Función | Bloque | Propósito |
|---|---|---|
| `toInt(value, fallback)` | Utils | Convierte string/number a entero con fallback |
| `normalizeIp(ip)` | Red | Elimina prefijo `::ffff:` de IPs IPv4-mapped |
| `ipv4ToInt(ip)` | Red | Convierte IPv4 a uint32 para operaciones CIDR |
| `matchesRemote(pattern, ip)` | Red | Compara IP contra exacto / `*` / CIDR |
| `safeJsonParse(text, fallback)` | Utils | Parsea JSON con tolerancia a objetos y strings vacíos |
| `isPlainObject(value)` | Utils | Guarda de tipo: objeto plano no-null no-array |
| `isModelShape(value)` | Utils | Duck-typing para distinguir modelos de acciones |
| `clone(obj)` | Utils | Copia profunda vía JSON |
| `mergePlainObjects(target, source)` | Utils | Merge profundo sin arrays |
| `mergeModel(target, patch)` | Utils | Wrapper de `mergePlainObjects` para modelos |
| `hasGroupData(group)` | Actividad | ¿Tiene el grupo al menos un coil o registro? |
| `buildActivityState(model)` | Actividad | Inicializa timestamps de actividad desde el modelo |
| `markPatchActivity(activity, patch)` | Actividad | Marca actividad para un merge parcial |
| `touchGroupActivity(activity, info)` | Actividad | Marca actividad para un setValue puntual |
| `pruneExpiredGroups(model, activity, ...)` | Actividad | Elimina grupos vencidos y llama onExpired |
| `lookupAddress(model, ip, unit, addr, map)` | Resolución | Busca una dirección con las 4 prioridades |
| `lookupRegister(model, ip, unit, addr)` | Resolución | Wrapper FC3 de `lookupAddress` |
| `lookupCoil(model, ip, unit, addr)` | Resolución | Wrapper FC1 de `lookupAddress` |
| `parseBooleanLike(value)` | Codif. | Interpreta bool desde primitivos y strings |
| `encodeCoilBit(coilDef)` | Codif. | Convierte definición de coil a bit con control de exception/enabled |
| `orderBytes(raw, byteOrder)` | Codif. | Permuta los 4 bytes según ABCD/CDAB/BADC/DCBA |
| `encode32(registerDef, defaults)` | Codif. | Codifica un registro a 4 bytes |
| `buildExceptionResponse(req, ...)` | Respuestas | Construye trama de excepción Modbus (9 bytes) |
| `buildFc3Response(req, ...)` | Respuestas | Construye trama de respuesta FC3 |
| `buildFc1Response(req, ...)` | Respuestas | Construye trama de respuesta FC1 |
| `buildDataBuffer(model, ...)` | Respuestas | Genera payload FC3 (quantity × 4 bytes) |
| `buildCoilsBuffer(model, ...)` | Respuestas | Genera payload FC1 (bits LSB-first) |
| `deleteNode(model, payload, ...)` | Mutación | Borra grupo o punto del modelo |
| `patchRegisterValue(model, payload, ...)` | Mutación | Crea/actualiza un punto en el modelo |
| `processFrame(socket, frame)` | Runtime | Valida y responde una trama Modbus completa |
| `handleSocket(socket)` | Runtime | Gestiona una conexión TCP y el stream de bytes |
| `startServer()` | Runtime | Levanta el servidor TCP |


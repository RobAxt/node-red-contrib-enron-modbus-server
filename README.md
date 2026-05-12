# @axt/node-red-contrib-enron-modbus-server

Nodo de paleta para Node-RED que implementa un servidor **Modbus TCP estilo Enron/Daniels** para lecturas **FC3** en registros numéricos de 32 bits y **FC1** para datos digitales.

En Enron Modbus, una dirección lógica numérica puede devolver **4 bytes por variable**. Por ejemplo, una lectura FC3 de `quantity = 1` sobre `7021` responde con `byte count = 04`.

## Funcionalidad incluida

- Servidor TCP para múltiples clientes simultáneos.
- Puerto configurable, por defecto `502`.
- Rango configurable, por defecto `7000..7999`.
- Function Codes soportados: `01` (coils) y `03`.
- Respuesta de 32 bits por variable: `quantity × 4 bytes`.
- Coils digitales en rango fijo `1000..1999` (respuesta empaquetada por bits).
- Valores configurables por:
  1. IP remota + Unit ID.
  2. IP remota.
  3. Unit ID.
  4. Registro global.
- Caducidad automática de grupos lógicos por inactividad, configurable desde la UI en minutos.
- Evento `enron-modbus/group_expired` cuando un grupo se borra por timeout.
- Coincidencia por IP exacta o CIDR, por ejemplo `192.168.3.100` o `192.168.3.0/24`.
- Tipos soportados:
  - `float32`
  - `int32`
  - `uint32`
  - `hex32` / `raw32`
- Órdenes de bytes soportados:
  - `ABCD`
  - `CDAB`
  - `BADC`
  - `DCBA`
- Respuestas de excepción Modbus cuando corresponde.
- Actualización dinámica de datos mediante mensajes de entrada.

## Instalación local

Desde el directorio de usuario de Node-RED:

```bash
cd ~/.node-red
npm install /ruta/al/proyecto/node-red-contrib-enron-modbus-server
node-red-restart
```

O generando primero el paquete `.tgz`:

```bash
cd node-red-contrib-enron-modbus-server
npm pack
cd ~/.node-red
npm install /ruta/al/paquete/axt-node-red-contrib-enron-modbus-server-0.1.0.tgz
node-red-restart
```

En Docker:

```bash
docker exec -it <contenedor-node-red> sh
cd /data
npm install /data/node-red-contrib-enron-modbus-server
```

Después reiniciar el contenedor.

## Uso básico

Agregar el nodo **enron modbus server** desde la categoría `network`.

Configuración recomendada inicial:

- `Listen host`: `0.0.0.0`
- `Port`: `1502` para pruebas o `502` si el proceso tiene permiso.
- `Min address`: `7000`
- `Max address`: `7999`
- `Max quantity`: `60`
- `Default type`: `float32`
- `Byte order`: `ABCD`
- `Missing register`: `Exception 02`
- `Group timeout (min)`: `0` desactiva el borrado automático; cualquier valor mayor borra el contenedor lógico si no recibe nuevas actualizaciones durante ese tiempo.

## Uso del puerto 502

En Linux, los puertos menores a 1024 pueden requerir privilegios especiales. Para Docker conviene configurar el nodo en `1502` y mapear el puerto estándar afuera:

```yaml
services:
  node-red:
    image: nodered/node-red:latest
    ports:
      - "1880:1880"
      - "502:1502"
    volumes:
      - ./data:/data
```

## Estructura del JSON de datos

```json
{
  "defaults": {
    "type": "float32",
    "byteOrder": "ABCD",
    "missingRegister": "exception"
  },
  "coils": {
    "1000": { "value": true },
    "1001": { "value": false }
  },
  "registers": {
    "7001": { "value": 12.34, "type": "float32", "unit": "bar" },
    "7002": { "value": 56.78, "type": "float32", "unit": "degC" },
    "7021": { "value": 60500.0, "type": "float32", "unit": "m3" }
  },
  "unitIds": {
    "17": {
      "coils": {
        "1000": { "value": true }
      },
      "registers": {
        "7021": { "value": 60500.0, "type": "float32" }
      }
    }
  },
  "remotes": {
    "192.168.3.100": {
      "unitIds": {
        "17": {
          "coils": {
            "1000": { "value": false }
          },
          "registers": {
            "7021": { "value": 333.44, "type": "float32" }
          }
        }
      },
      "coils": {
        "1001": { "value": true }
      },
      "registers": {
        "7001": { "value": 1.11, "type": "float32" }
      }
    },
    "192.168.3.0/24": {
      "registers": {
        "7002": { "value": 22.22, "type": "float32" }
      }
    }
  }
}
```

## Prioridad de resolución

Cuando llega una consulta, el nodo busca el valor en este orden:

1. `remotes[IP/CIDR].unitIds[unitId].registers[address]`
2. `remotes[IP/CIDR].registers[address]`
3. `unitIds[unitId].registers[address]`
4. `registers[address]`

Para `FC1`, se aplica la misma prioridad usando el mapa `coils` en lugar de `registers`.

Esto permite responder distinto por cliente remoto y por Unit ID.

## Ejemplo

Consulta:

```text
Unit ID: 17
FC: 03
Address: 7021
Quantity: 1
```

Respuesta esperada:

```text
Unit ID: 17
FC: 03
Byte count: 04
Data: float32 de 4 bytes
```

## Actualización dinámica desde un flujo

El nodo tiene una entrada. Se puede reemplazar todo el modelo de datos enviando el JSON completo en `msg.payload`.

También se puede modificar un único registro:

```json
{
  "action": "setValue",
  "remote": "192.168.3.100",
  "unitId": 17,
  "address": 7021,
  "value": 44.55,
  "type": "float32",
  "byteOrder": "ABCD"
}
```

Para actualizar un coil digital en el rango `1000..1999`:

```json
{
  "action": "setValue",
  "remote": "*",
  "unitId": 160,
  "address": 1000,
  "value": true,
  "pointType": "coil"
}
```

Si se omite `remote`, se actualiza por `unitId`. Si también se omite `unitId`, se actualiza el mapa global `registers`.

## Borrado de grupos o direcciones

Para eliminar una agrupación lógica o una dirección puntual usa `action: deleteNode`.
La granularidad depende de los campos que incluyas:

| Campos presentes | Qué se borra |
|---|---|
| `remote` + `unitId` + `address` | Una dirección dentro de `remotes[remote].unitIds[unitId]` |
| `remote` + `unitId` | El `unitId` completo dentro de ese remote |
| `remote` + `address` | Una dirección en `remotes[remote]` (sin unitId) |
| `remote` | El remote completo |
| `unitId` + `address` | Una dirección en `unitIds[unitId]` global |
| `unitId` | El `unitId` global completo |
| `address` | Una dirección del mapa global (`registers` o `coils`) |

Para indicar si la dirección es coil o register se usa el mismo campo `pointType` que en `setValue`.

Ejemplos:

```json
{ "action": "deleteNode", "remote": "*", "unitId": 200 }
```

```json
{ "action": "deleteNode", "remote": "*", "unitId": 200, "address": 1000, "pointType": "coil" }
```

```json
{ "action": "deleteNode", "unitId": 17 }
```

```json
{ "action": "deleteNode", "address": 7021 }
```

Al borrar un grupo su actividad de inactividad también se limpia, por lo que no dispara el evento `group_expired`.

## Excepciones Modbus implementadas

| Código | Caso |
|---:|---|
| `01` | Function code no soportado. |
| `02` | Dirección fuera de rango, registro inexistente o registro deshabilitado. |
| `03` | Cantidad inválida. |
| `04` | Error al codificar el dato. |

Para forzar una excepción desde un registro:

```json
{
  "registers": {
    "7021": { "exception": 2 }
  }
}
```

Para deshabilitar un registro:

```json
{
  "registers": {
    "7021": { "enabled": false }
  }
}
```

## Script de prueba

El proyecto incluye un cliente de prueba:

```bash
node test/client-read-fc3.js 127.0.0.1 1502 17 7021 1
```

Para coils FC1:

```bash
node test/client-read-fc1.js 127.0.0.1 1502 160 1000 8
```

Salida esperada aproximada:

```text
Response hex: 000100000007110304476c4a00
Unit ID: 17
Function Code: 3
Byte count: 4
float32[0]: 60500
```

## Alcance

Implementado:

- Modbus TCP.
- FC3 Enron numeric variables de 32 bits.
- FC1 coils digitales en rango `1000..1999`.
- Múltiples clientes TCP.
- Diferenciación por IP remota y Unit ID.

No implementado todavía:

- Modbus RTU/ASCII.
- FC6 / FC16 Enron para escritura.
- Event logs.
- Alarm logs.
- History readout / EFM.

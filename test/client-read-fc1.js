"use strict";

const net = require("net");

const host = process.argv[2] || "127.0.0.1";
const port = Number.parseInt(process.argv[3] || "1502", 10);
const unitId = Number.parseInt(process.argv[4] || "1", 10);
const address = Number.parseInt(process.argv[5] || "1000", 10);
const quantity = Number.parseInt(process.argv[6] || "8", 10);

if (!Number.isInteger(port) || !Number.isInteger(unitId) || !Number.isInteger(address) || !Number.isInteger(quantity)) {
  console.error("Usage: node test/client-read-fc1.js <host> <port> <unitId> <address> <quantity>");
  process.exit(1);
}

const transactionId = 1;
const protocolId = 0;
const pduLength = 6; // unitId + fc + address(2) + quantity(2)

const req = Buffer.alloc(12);
req.writeUInt16BE(transactionId, 0);
req.writeUInt16BE(protocolId, 2);
req.writeUInt16BE(pduLength, 4);
req.writeUInt8(unitId, 6);
req.writeUInt8(0x01, 7);
req.writeUInt16BE(address, 8);
req.writeUInt16BE(quantity, 10);

const socket = net.createConnection({ host, port }, () => {
  socket.write(req);
});

socket.on("data", (res) => {
  console.log("Response hex:", res.toString("hex"));

  const fc = res.readUInt8(7);
  if ((fc & 0x80) !== 0) {
    const ex = res.readUInt8(8);
    console.log("Modbus exception:", ex);
    socket.end();
    return;
  }

  const byteCount = res.readUInt8(8);
  const data = res.subarray(9, 9 + byteCount);

  console.log("Unit ID:", res.readUInt8(6));
  console.log("Function Code:", fc);
  console.log("Byte count:", byteCount);

  for (let i = 0; i < quantity; i += 1) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    const isSet = ((data[byteIndex] >> bitIndex) & 0x01) === 1;
    console.log(`coil[${address + i}]:`, isSet);
  }

  socket.end();
});

socket.on("error", (err) => {
  console.error("Socket error:", err.message);
  process.exit(2);
});

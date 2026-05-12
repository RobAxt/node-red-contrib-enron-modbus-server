"use strict";

const net = require("net");

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3] || 1502);
const unitId = Number(process.argv[4] || 17);
const address = Number(process.argv[5] || 7021);
const quantity = Number(process.argv[6] || 1);

function buildRequest() {
  const tx = 1;
  const pduLength = 6; // unit + fc + address + quantity
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(tx, 0);
  buf.writeUInt16BE(0, 2); // protocol id
  buf.writeUInt16BE(pduLength, 4);
  buf.writeUInt8(unitId, 6);
  buf.writeUInt8(0x03, 7);
  buf.writeUInt16BE(address, 8);
  buf.writeUInt16BE(quantity, 10);
  return buf;
}

const socket = new net.Socket();

socket.connect({ host, port }, () => {
  socket.write(buildRequest());
});

socket.on("data", (data) => {
  console.log(`Response hex: ${data.toString("hex")}`);

  const rxUnit = data.readUInt8(6);
  const fc = data.readUInt8(7);
  console.log(`Unit ID: ${rxUnit}`);
  console.log(`Function Code: ${fc}`);

  if (fc & 0x80) {
    console.log(`Exception code: ${data.readUInt8(8)}`);
    socket.end();
    return;
  }

  const byteCount = data.readUInt8(8);
  console.log(`Byte count: ${byteCount}`);

  for (let i = 0; i < byteCount; i += 4) {
    const value = data.readFloatBE(9 + i);
    console.log(`float32[${i / 4}]: ${value}`);
  }

  socket.end();
});

socket.on("error", (err) => {
  console.error(err.message);
  process.exitCode = 1;
});

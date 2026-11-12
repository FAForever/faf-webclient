'use strict';

/**
 * A small WebSocket server (RFC 6455), for the PC link (lib/link.js).
 *
 * Written out rather than added as a package: the server has no runtime
 * dependencies, and the link needs very little of the protocol. Text messages
 * only, a size limit on every message, ping/pong to find dead connections, and
 * the close handshake. No extensions (no compression) and no subprotocols.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Refuse an upgrade with a plain HTTP answer. */
function refuse(socket, status, reason) {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

/** The handshake's answer key for a client's Sec-WebSocket-Key. */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, head, maxMessageBytes) {
    super();
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = null;
    this.fragmentBytes = 0;
    this.closed = false;
    this.alive = true;
    this.heartbeat = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.parse();
    });
    socket.on('close', () => this.finish(1006, ''));
    socket.on('error', () => this.finish(1006, ''));
    // The HTTP server allows half-open sockets, and an upgraded one keeps that:
    // when the peer is done, this side has to close too, or the socket stays.
    socket.on('end', () => {
      this.finish(1006, '');
      socket.destroy();
    });
    if (this.buffer.length) setImmediate(() => this.parse());
  }

  /** Close the connection if no pong arrives between two pings. */
  startHeartbeat(intervalMs) {
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        this.terminate();
        return;
      }
      this.alive = false;
      this.frame(OP_PING, Buffer.alloc(0));
    }, intervalMs);
    this.heartbeat.unref();
  }

  send(text) {
    if (this.closed) return false;
    this.frame(OP_TEXT, Buffer.from(String(text), 'utf8'));
    return true;
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  /** Start the close handshake: the peer answers, then the socket ends. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBytes = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.frame(OP_CLOSE, payload);
    this.finish(code, reason);
    // Give the peer a moment to answer, then make sure it is gone.
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  terminate() {
    this.finish(1006, '');
    this.socket.destroy();
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.emit('close', code, reason);
  }

  frame(opcode, payload) {
    if (this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Read every complete frame out of the buffer. */
  parse() {
    while (!this.closed) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) return this.close(1009, 'message too big');
        length = Number(big);
        offset = 10;
      }
      // Extensions were not negotiated, and a client must mask what it sends.
      if (rsv) return this.close(1002, 'unexpected extension bits');
      if (!masked) return this.close(1002, 'unmasked frame');
      if (length > this.maxMessageBytes) return this.close(1009, 'message too big');
      if (b.length < offset + 4 + length) return;

      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(offset + 4 + length);

      if (opcode >= 0x8) {
        if (!fin || length > 125) return this.close(1002, 'bad control frame');
        if (opcode === OP_CLOSE) {
          // Answer the peer's close; its reason is not ours to repeat.
          this.close(1000, '');
          return;
        }
        if (opcode === OP_PING) this.frame(OP_PONG, payload);
        if (opcode === OP_PONG) this.alive = true;
        continue;
      }

      if (opcode === OP_BINARY) return this.close(1003, 'text only');
      if (opcode === OP_TEXT) {
        if (this.fragments) return this.close(1002, 'expected a continuation');
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      } else if (opcode === OP_CONTINUATION) {
        if (!this.fragments) return this.close(1002, 'unexpected continuation');
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
      } else {
        return this.close(1002, 'unknown opcode');
      }
      if (this.fragmentBytes > this.maxMessageBytes) return this.close(1009, 'message too big');
      if (fin) {
        const text = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = null;
        this.fragmentBytes = 0;
        this.alive = true;
        this.emit('message', text);
      }
    }
  }
}

/**
 * Answer an HTTP upgrade request. Returns the connection, or null after
 * refusing the request (which then needs nothing more from the caller).
 */
function upgrade(req, socket, head, { maxMessageBytes = 64 * 1024 } = {}) {
  const key = req.headers['sec-websocket-key'];
  const valid =
    req.method === 'GET' &&
    String(req.headers.upgrade || '').toLowerCase() === 'websocket' &&
    /\bupgrade\b/i.test(String(req.headers.connection || '')) &&
    req.headers['sec-websocket-version'] === '13' &&
    typeof key === 'string' &&
    Buffer.from(key, 'base64').length === 16;
  if (!valid) {
    refuse(socket, 400, 'Bad Request');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  return new WebSocketConnection(socket, head, maxMessageBytes);
}

module.exports = { upgrade, refuse, acceptKey, WebSocketConnection };

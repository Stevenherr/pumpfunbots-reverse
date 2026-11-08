import WebSocket from "ws";
import { WS_URL } from "./config.mjs";

// Pump.fun normally emits many log lines per second. A socket that stays open
// but goes quiet is treated as dead. Positions are not stored here, so a
// reconnect does not stop the backup poll or the wall-clock timeout.

export function wsStaleMs(env = process.env) {
  const parsed = Number(env.WS_STALE_MS || 45_000);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 45_000;
}

export function isFeedStale(lastDataAt, now, staleMs) {
  if (lastDataAt == null || !(staleMs > 0)) return false;
  return Number(now) - Number(lastDataAt) >= Number(staleMs);
}

export function reconnectDelay(attempt, baseMs = 1000, capMs = 30_000) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(baseMs * 2 ** (n - 1), capMs);
}

export class SolanaWs {
  constructor(url = WS_URL, opts = {}) {
    this.url = url;
    this.Socket = opts.Socket || WebSocket;
    this.staleMs = opts.staleMs ?? wsStaleMs();
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.now = opts.now || (() => Date.now());
    this.schedule = opts.schedule || ((ms, fn) => setTimeout(fn, ms));
    this.ws = null;
    this.id = 0;
    this.subs = new Map();
    this.handlers = new Map();
    this.reconnects = 0;
    this.lastDataAt = null;
    this.shuttingDown = false;
    this.reconnectTimer = null;
    this.watchTimer = null;
    this.opened = false;
  }

  connect() {
    if (this.shuttingDown) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = new this.Socket(this.url);
      this.ws = socket;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      socket.on("open", () => {
        this.opened = true;
        this.lastDataAt = this.now();
        console.log(`[ws] connected${this.reconnects ? ` (reconnect #${this.reconnects})` : ""}`);
        for (const [id, { method, params }] of this.subs) {
          this._send(method, params, id);
        }
        this._armWatchdog();
        finish();
      });
      socket.on("message", (raw) => {
        this.lastDataAt = this.now();
        try { this._dispatch(raw); } catch { /* malformed frames do not count as a dead feed */ }
      });
      socket.on("pong", () => {
        this.lastPongAt = this.now();
      });
      socket.on("close", () => {
        if (this.ws !== socket) return;
        this.ws = null;
        this._stopWatchdog();
        if (!this.shuttingDown) this._scheduleReconnect("disconnected");
        finish(new Error("websocket closed before open"));
      });
      socket.on("error", (err) => {
        console.error("[ws] error:", err.message);
        if (!this.opened) finish(err);
      });
    });
  }

  _send(method, params, id) {
    if (this.ws?.readyState !== this.Socket.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  _armWatchdog() {
    this._stopWatchdog();
    const every = 1000;
    const tick = () => {
      this._ping();
      if (this.checkWatchdog() === "stale") this._dropStale();
    };
    this.watchTimer = this.schedule(every, () => {
      tick();
      if (!this.shuttingDown && this.ws) this._armWatchdog();
    });
    if (this.watchTimer?.unref) this.watchTimer.unref();
  }

  _stopWatchdog() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  _ping() {
    if (this.ws?.readyState === this.Socket.OPEN && typeof this.ws.ping === "function") {
      try { this.ws.ping(); } catch { /* ignore a ping on a closing socket */ }
    }
  }

  checkWatchdog(now = this.now()) {
    if (this.shuttingDown || !this.ws || this.ws.readyState !== this.Socket.OPEN) return "down";
    if (isFeedStale(this.lastDataAt, now, this.staleMs)) return "stale";
    return "ok";
  }

  _dropStale() {
    const quiet = this.lastDataAt == null ? this.staleMs : this.now() - this.lastDataAt;
    console.warn(`[ws] WARN no data for ${quiet}ms, closing socket`);
    const socket = this.ws;
    this.ws = null;
    this._stopWatchdog();
    try { socket?.terminate?.() || socket?.close?.(); } catch { /* already gone */ }
    this._scheduleReconnect(`no data for ${quiet}ms`);
  }

  _scheduleReconnect(reason) {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnects += 1;
    const delay = reconnectDelay(this.reconnects, this.baseDelayMs);
    console.warn(`[ws] ${reason}; reconnect #${this.reconnects} in ${delay}ms`);
    this.reconnectTimer = this.schedule(delay, () => {
      this.reconnectTimer = null;
      if (!this.shuttingDown) this.connect().catch((err) => console.error("[ws] reconnect failed:", err.message));
    });
    if (this.reconnectTimer?.unref) this.reconnectTimer.unref();
  }

  subscribeLogs(programId, handler, commitment = "confirmed") {
    const id = ++this.id;
    const method = "logsSubscribe";
    const params = [{ mentions: [programId] }, { commitment }];
    this.subs.set(id, { method, params, handler, unsub: "logsUnsubscribe" });
    if (this.ws?.readyState === this.Socket.OPEN) this._send(method, params, id);
    return id;
  }

  unsubscribe(localId) {
    const pending = this.subs.get(localId);
    if (!pending) return;
    this.subs.delete(localId);
    if (pending.subId) this.handlers.delete(pending.subId);
    if (pending.subId && this.ws?.readyState === this.Socket.OPEN) {
      this._send(pending.unsub || "logsUnsubscribe", [pending.subId], ++this.id);
    }
  }

  subscribeAccount(pubkey, handler, commitment = "confirmed") {
    const id = ++this.id;
    const method = "accountSubscribe";
    const params = [pubkey, { encoding: "jsonParsed", commitment }];
    this.subs.set(id, { method, params, handler, unsub: "accountUnsubscribe" });
    if (this.ws?.readyState === this.Socket.OPEN) this._send(method, params, id);
    return id;
  }

  _dispatch(raw) {
    const msg = JSON.parse(raw);
    if (msg.method === "logsNotification" || msg.method === "accountNotification") {
      const subId = msg.params?.subscription;
      const handler = this.handlers.get(subId);
      if (handler) handler(msg.params.result);
    }
    if (msg.result && typeof msg.result === "number") {
      const pending = this.subs.get(msg.id);
      if (pending) {
        this.handlers.set(msg.result, pending.handler);
        pending.subId = msg.result;
      }
    }
  }

  close() {
    this.shuttingDown = true;
    this._stopWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.ws?.terminate?.() || this.ws?.close?.(); } catch { /* ignore */ }
    this.ws = null;
  }
}

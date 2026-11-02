// WebSocket + Yjs session manager.
//
// One socket per app instance; every open document owns its own Y.Doc +
// Awareness pair (cached by path so switching files never leaks CRDT state
// between rooms). Only one room is joined on the wire at a time.
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { bytesToB64, b64ToBytes } from "../util/b64.js";
import { awarenessUser } from "../util/color.js";
import { reportUnauthorized } from "./api.js";

const INIT_TIMEOUT_MS = 8000;
const PRESENCE_THROTTLE_MS = 400;
const PING_INTERVAL_MS = 25000;
const MAX_BACKOFF_MS = 15000;

/**
 * @typedef {Object} Session
 * @property {string} path
 * @property {Y.Doc} ydoc
 * @property {Awareness} awareness
 * @property {boolean} wantJoined  UI intent
 * @property {boolean} joined      frame actually sent on the current socket
 * @property {boolean} initResolved
 * @property {boolean} pendingLocal
 * @property {Array<(res: {ok: boolean, timedOut: boolean}) => void>} initWaiters
 */

export class CollabClient {
  /**
   * @param {{
   *   user: {id?: string, username: string, color?: string},
   *   onStatus?: (status: 'connecting'|'open'|'closed') => void,
   *   onPresence?: (users: any[]) => void,
   *   onPeers?: (path: string, count: number) => void,
   *   onSaved?: (path: string, ts: number) => void,
   *   onError?: (message: string) => void,
   * }} opts
   */
  constructor(opts = {}) {
    this.user = opts.user || { username: "anonymous" };
    this.onStatus = opts.onStatus || (() => {});
    this.onPresence = opts.onPresence || (() => {});
    this.onPeers = opts.onPeers || (() => {});
    this.onSaved = opts.onSaved || (() => {});
    this.onError = opts.onError || (() => {});

    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    /** @type {WebSocket|null} */
    this.ws = null;
    this.status = "closed";
    this.currentPath = null;
    this.attempt = 0;
    this.destroyed = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.presenceTimer = null;
    this.pendingPresence = null;
    this.userState = awarenessUser({
      username: this.user.username,
      color: this.user.color,
    });
    this.#connect();
  }

  // ---------------------------------------------------------------- socket

  #connect() {
    if (this.destroyed) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    )
      return;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    this.#setStatus("connecting");

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.#setStatus("open");
      this.#startPing();
      // Re-establish every room the UI still wants (fresh socket = empty server rooms).
      for (const session of this.sessions.values()) {
        if (session.wantJoined) this.#sendJoin(session);
      }
      this.#sendPresence(true);
    };

    ws.onmessage = (ev) => this.#onMessage(ev);

    ws.onerror = () => {
      /* onclose always follows; keep it quiet */
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.#stopPing();
      for (const session of this.sessions.values()) {
        session.joined = false;
        session.initResolved = false;
      }
      if (this.destroyed) return;
      this.#setStatus("closed");
      // The browser hides the handshake status, so an expired cookie (401) or a rejected
      // Origin (403) looks exactly like a dropped connection: ask the API instead of
      // reconnecting forever.
      this.#verifySession().then((retryable) => {
        if (retryable) this.#scheduleReconnect();
      });
    };
  }

  /** @returns {Promise<boolean>} whether reconnecting makes sense. */
  async #verifySession() {
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      if (res.ok) return true;
      if (res.status === 403) {
        const body = await res.json().catch(() => null);
        this.onError(
          body?.error?.code === "forbidden_origin"
            ? "实时连接的来源校验失败，已停止重连"
            : "没有访问权限，已停止重连",
        );
      } else {
        this.onError("会话已失效，请重新登录");
      }
      this.destroyed = true;
      reportUnauthorized();
      return false;
    } catch {
      // Network failure: the server may simply be restarting, keep retrying.
      return true;
    }
  }

  #scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 400 * Math.pow(1.7, this.attempt++));
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        this.#connect();
      },
      delay + Math.random() * 250,
    );
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  #startPing() {
    this.#stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isOpen()) this.#sendRaw({ t: "ping" });
    }, PING_INTERVAL_MS);
  }

  #stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  #sendRaw(frame) {
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------- sessions

  /** @returns {Session} */
  #ensureSession(path) {
    const existing = this.sessions.get(path);
    if (existing) return existing;

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField("user", this.userState);

    /** @type {Session} */
    const session = {
      path,
      ydoc,
      awareness,
      wantJoined: false,
      joined: false,
      initResolved: false,
      pendingLocal: false,
      initWaiters: [],
    };

    ydoc.on("update", (update, origin) => {
      if (origin === "remote") return;
      session.pendingLocal = true;
      if (session.joined)
        this.#sendRaw({ t: "update", path, update: bytesToB64(update) });
    });

    awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin === "remote") return;
      const ids = [...added, ...updated, ...removed];
      if (!ids.length || !session.joined) return;
      this.#sendRaw({
        t: "awareness",
        path,
        update: bytesToB64(encodeAwarenessUpdate(awareness, ids)),
      });
    });

    this.sessions.set(path, session);
    return session;
  }

  /** Cached session lookup (used by the preview / status bar). */
  getSession(path) {
    return this.sessions.get(path) || null;
  }

  getText(path) {
    const session = this.sessions.get(path);
    return session ? session.ydoc.getText("content") : null;
  }

  #sendJoin(session) {
    session.joined = true;
    session.initResolved = false;
    this.#sendRaw({ t: "join", path: session.path });
  }

  /**
   * Join a document room and wait for the authoritative `init` payload.
   * @param {string} path
   * @returns {Promise<{session: Session, timedOut: boolean}>}
   */
  async joinFile(path) {
    const session = this.#ensureSession(path);
    session.wantJoined = true;

    if (this.status === "open") {
      if (!session.joined || !session.initResolved) this.#sendJoin(session);
    } else {
      this.#connect();
    }

    const { timedOut } = await this.#awaitInit(session);
    return { session, timedOut };
  }

  #awaitInit(session) {
    if (session.initResolved) return Promise.resolve({ timedOut: false });
    return new Promise((resolve) => {
      let done = false;
      const finish = (timedOut) => {
        if (done) return;
        done = true;
        session.initWaiters = session.initWaiters.filter((w) => w !== waiter);
        resolve({ timedOut });
      };
      const waiter = (res) => finish(res.timedOut);
      session.initWaiters.push(waiter);
      setTimeout(() => finish(true), INIT_TIMEOUT_MS);
    });
  }

  /** Leave a room but keep its Y.Doc cached for instant re-opening. */
  leaveFile(path) {
    const session = this.sessions.get(path);
    if (!session) return;
    session.wantJoined = false;
    if (session.joined) this.#sendRaw({ t: "leave", path });
    session.joined = false;
    session.initResolved = false;
  }

  /** Forget a document entirely (deleted / renamed file). */
  dropSession(path) {
    const session = this.sessions.get(path);
    if (!session) return;
    this.leaveFile(path);
    try {
      session.awareness.destroy();
    } catch {
      /* ignore */
    }
    try {
      session.ydoc.destroy();
    } catch {
      /* ignore */
    }
    this.sessions.delete(path);
    if (this.currentPath === path) this.currentPath = null;
  }

  // --------------------------------------------------------------- frames

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.t) {
      case "init": {
        const session = this.sessions.get(msg.path);
        if (!session || !msg.update) return;
        try {
          Y.applyUpdate(session.ydoc, b64ToBytes(msg.update), "remote");
        } catch (err) {
          console.warn("[collab] failed to apply init", err);
        }
        session.joined = true;
        session.initResolved = true;
        // Push our local state so edits made while offline reach the server.
        if (session.pendingLocal) {
          session.pendingLocal = false;
          this.#sendRaw({
            t: "update",
            path: msg.path,
            update: bytesToB64(Y.encodeStateAsUpdate(session.ydoc)),
          });
        }
        // Announce ourselves right away.
        this.#sendRaw({
          t: "awareness",
          path: msg.path,
          update: bytesToB64(
            encodeAwarenessUpdate(session.awareness, [
              session.awareness.clientID,
            ]),
          ),
        });
        const waiters = session.initWaiters;
        session.initWaiters = [];
        for (const waiter of waiters) waiter({ ok: true, timedOut: false });
        if (this.currentPath === msg.path) this.#sendPresence(true);
        break;
      }
      case "update": {
        const session = this.sessions.get(msg.path);
        if (!session || !msg.update) return;
        try {
          Y.applyUpdate(session.ydoc, b64ToBytes(msg.update), "remote");
        } catch (err) {
          console.warn("[collab] failed to apply remote update", err);
        }
        break;
      }
      case "awareness": {
        const session = this.sessions.get(msg.path);
        if (!session || !msg.update) return;
        try {
          applyAwarenessUpdate(
            session.awareness,
            b64ToBytes(msg.update),
            "remote",
          );
        } catch (err) {
          console.warn("[collab] failed to apply awareness", err);
        }
        break;
      }
      case "peers":
        this.onPeers(msg.path, msg.count || 0);
        break;
      case "saved":
        this.onSaved(msg.path, msg.ts || Date.now());
        break;
      case "presence":
        this.onPresence(Array.isArray(msg.users) ? msg.users : []);
        break;
      case "pong":
        break;
      case "error":
        this.onError(msg.message || "实时连接报告了一个错误");
        break;
      default:
        break;
    }
  }

  // --------------------------------------------------------------- presence

  setCurrentPath(path) {
    this.currentPath = path || null;
    // The buffered caret belongs to the previous file; keeping it would re-broadcast a
    // stale position for the file we just left.
    this.pendingPresence = null;
    this.#sendPresence(true);
  }

  /**
   * @param {{line: number, ch: number}|null} cursor
   * @param {number} [selection]
   */
  reportPresence(cursor, selection = 0) {
    this.pendingPresence = {
      path: this.currentPath,
      cursor: cursor || null,
      selection: selection || 0,
    };
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.#sendPresence(false);
    }, PRESENCE_THROTTLE_MS);
  }

  #sendPresence(immediate) {
    if (!this.isOpen()) return;
    if (immediate && this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    // `currentPath` is authoritative; the buffer only supplies a caret reported for that
    // same path.
    const path = this.currentPath;
    const pending = this.pendingPresence;
    this.pendingPresence = null;
    const fresh = Boolean(path) && Boolean(pending) && pending.path === path;
    this.#sendRaw({
      t: "presence",
      path: path || null,
      cursor: fresh ? pending.cursor : null,
      selection: fresh ? pending.selection : 0,
    });
  }

  destroy() {
    this.destroyed = true;
    this.#stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    for (const session of [...this.sessions.values()]) {
      if (session.joined) this.#sendRaw({ t: "leave", path: session.path });
      try {
        session.awareness.destroy();
      } catch {
        /* ignore */
      }
      try {
        session.ydoc.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}

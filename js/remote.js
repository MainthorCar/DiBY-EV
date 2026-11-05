// Conexión con el servidor real (Cloudflare). Misma forma que el simulador.
const TOKEN_KEY = 'diby-token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

export async function login(server, password) {
  const r = await fetch(server + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) return false;
  const j = await r.json();
  setToken(j.token);
  return true;
}

export class RemoteSource {
  constructor(cfg, onAuthFail) {
    this.cfg = cfg;
    this.onAuthFail = onAuthFail;
    this.subs = new Set();
    this.waits = new Map();
    this.eventWaits = new Set();
    this.s = null;
    this.fails = 0;
    this.connect();
    setInterval(() => { if (this.s) { this.s.now = Date.now(); this.emit(); } }, 1000);
  }

  connect() {
    const url = this.cfg.server.replace(/^http/, 'ws') + '/api/live?token=' + encodeURIComponent(getToken() || '');
    const ws = new WebSocket(url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; this.fails = 0; };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'state') {
        this.s = { ...m.state, now: Date.now(), link: 'up' };
        this.emit();
      } else if (m.type === 'reply') {
        const w = this.waits.get(m.id);
        if (w) { this.waits.delete(m.id); w(m); }
      } else if (m.type === 'event') {
        for (const fn of this.eventWaits) fn(m);
        window.dispatchEvent(new CustomEvent('diby-event', { detail: m }));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (!opened && ++this.fails >= 3 && !this.s) { this.onAuthFail && this.onAuthFail(); return; }
      if (this.s) { this.s.link = 'down'; this.s.online = false; this.s.status = 'Offline'; this.emit(); }
      setTimeout(() => this.connect(), Math.min(15000, 2000 * (this.fails || 1)));
    };
  }

  subscribe(fn) {
    this.subs.add(fn);
    if (this.s) fn(this.s);
    return () => this.subs.delete(fn);
  }

  emit() {
    for (const fn of this.subs) fn(this.s);
  }

  send(cmd, arg, timeout = 20000) {
    return new Promise((res) => {
      if (!this.ws || this.ws.readyState !== 1) return res({ ok: false, msg: 'Sin conexión con el servidor' });
      const id = Math.random().toString(36).slice(2);
      this.waits.set(id, res);
      this.ws.send(JSON.stringify({ id, cmd, arg }));
      setTimeout(() => { if (this.waits.delete(id)) res({ ok: false, msg: 'El servidor no respondió' }); }, timeout);
    });
  }

  async command(cmd, arg) {
    if (cmd !== 'learnKey') return this.send(cmd, arg);
    const r = await this.send(cmd, arg);
    if (!r.ok) return r;
    return new Promise((res) => {
      const fn = (m) => {
        if (m.event !== 'learned') return;
        this.eventWaits.delete(fn);
        clearTimeout(timer);
        res({ ok: true, msg: 'Llave nueva detectada', keyId: m.key.id });
      };
      const timer = setTimeout(() => { this.eventWaits.delete(fn); res({ ok: false, msg: 'No se detectó ninguna llave' }); }, 62000);
      this.eventWaits.add(fn);
    });
  }
}

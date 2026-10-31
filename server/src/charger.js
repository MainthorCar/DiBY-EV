// El "cerebro": un único objeto que guarda todo del cargador y habla OCPP 1.6J con él.
import { DurableObject } from 'cloudflare:workers';

const DAY = 86400000;
const NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const PANEL_TAG = 'DIBY-PANEL'; // idTag que usa la página para arrancar una carga a distancia

// Colores neón que se asignan a cada auto nuevo, en orden
const PALETTE = ['#2BFF88', '#19C8FF', '#A9B8FF', '#7DF9FF', '#B6FF3B', '#5B8CFF', '#E0E7FF', '#3DFFD0'];
const NOCAR = '_'; // energía de cargas sin auto asignado
const hk = (carId) => carId || NOCAR;

function defaults() {
  return {
    chargerId: null,
    boot: null,
    lastSeen: 0,
    status: 'Unavailable',
    connector: '—',
    faults: [],
    kw: 0,
    phases: [{ a: 0, v: 0 }, { a: 0, v: 0 }, { a: 0, v: 0 }],
    meterTotal: 0,
    txSeq: 1,
    session: null,
    soc: null,
    socByCar: {},
    reached: false,
    paused: false,
    carId: null,
    cars: [],
    tariff: null,
    tariffSince: null,
    schedule: { enabled: false, mode: 'soc', soc: 80, minutes: 120, kwh: 20, startMode: 'plug', startAt: '23:00', limitA: 32 },
    keys: [],
    tags: [],
    learning: 0,
    history: {},
    v: 3,
  };
}

export class Charger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.pending = new Map();
    this.tz = Number(env.TZ_OFFSET_MIN || -180) * 60000;
    ctx.blockConcurrencyWhile(async () => {
      const stored = (await ctx.storage.get('d')) || null;
      this.d = { ...defaults(), ...(stored || {}) };
      if (stored && (stored.v || 1) < 2) {
        // v2: sin autos de ejemplo; cada usuario crea los suyos. Carga libre por defecto.
        const fresh = defaults();
        Object.assign(this.d, { cars: [], carId: null, soc: null, socByCar: {}, history: {}, schedule: fresh.schedule, v: 2 });
        this.d.keys = (this.d.keys || []).map((k) => ({ ...k, carId: null }));
        if (this.d.session) this.d.session.carId = null;
      }
      if (stored && (stored.v || 1) < 3) {
        // v3: precio del kWh lo carga el usuario en Ajustes
        this.d.tariff = null;
        this.d.v = 3;
      }
      this.series = (await ctx.storage.get('series')) || [];
    });
  }

  /* ---------- Conexiones ---------- */

  async fetch(req) {
    const url = new URL(req.url);

    // Registro de intentos de conexión del cargador (para diagnosticar)
    if (url.pathname === '/attempt') {
      const a = await req.json().catch(() => null);
      if (a) {
        this.d.attempts = [a, ...(this.d.attempts || [])].slice(0, 5);
        await this.save();
        this.broadcast();
      }
      return new Response('ok');
    }

    const [client, server] = Object.values(new WebSocketPair());

    if (url.pathname === '/ocpp' || url.pathname.startsWith('/ocpp/')) {
      for (const old of this.ctx.getWebSockets('ocpp')) { try { old.close(1000, 'reemplazado'); } catch {} }
      this.ctx.acceptWebSocket(server, ['ocpp']);
      this.d.chargerId = decodeURIComponent(url.pathname.slice(6)) || 'cargador';
      this.d.lastSeen = Date.now();
      await this.save();
      this.broadcast();
      setTimeout(() => this.configure().catch(() => {}), 3000);
      const proto = req.headers.get('Sec-WebSocket-Protocol') || '';
      const headers = proto.includes('ocpp1.6') ? { 'Sec-WebSocket-Protocol': 'ocpp1.6' } : {};
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    this.ctx.acceptWebSocket(server, ['ui']);
    server.send(JSON.stringify({ type: 'state', state: this.snapshot() }));
    // Al abrir la página, pedir datos frescos al cargador
    if (this.ctx.getWebSockets('ocpp').length && Date.now() - (this.lastTrigger || 0) > 10000) {
      setTimeout(() => this.trigger().catch(() => {}), 100);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    if (this.ctx.getTags(ws).includes('ocpp')) return this.onOcpp(ws, msg);
    return this.onUi(ws, msg);
  }

  async webSocketClose(ws) {
    if (this.ctx.getTags(ws).includes('ocpp')) this.broadcast();
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  /* ---------- OCPP: mensajes del cargador ---------- */

  async onOcpp(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    this.d.lastSeen = Date.now();
    this.logMsg('←', raw);
    const [type, id] = m;

    if (type === 2) {
      const action = m[2];
      let res;
      try {
        res = await this.handle(action, m[3] || {});
      } catch (e) {
        ws.send(JSON.stringify([4, id, 'InternalError', String(e.message || e), {}]));
        return;
      }
      ws.send(JSON.stringify([3, id, res]));
      await this.save();
      this.broadcast();
      if (this.after) { const fn = this.after; this.after = null; fn().catch(() => {}); }
      return;
    }
    if (type === 3 || type === 4) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (type === 3) p.res(m[2] || {});
      else p.rej(new Error(m[3] || 'Error del cargador'));
    }
  }

  async handle(action, p) {
    const d = this.d;
    const now = Date.now();
    switch (action) {
      case 'BootNotification':
        d.boot = { vendor: p.chargePointVendor, model: p.chargePointModel, fw: p.firmwareVersion, serial: p.chargePointSerialNumber };
        this.after = () => this.configure();
        return { status: 'Accepted', currentTime: iso(now), interval: 60 };

      case 'Heartbeat':
        return { currentTime: iso(now) };

      case 'StatusNotification':
        if (!p.connectorId) return {};
        d.status = p.status;
        d.connector = ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'].includes(p.status) ? 'Conectado' : 'Libre';
        d.faults = p.errorCode && p.errorCode !== 'NoError' ? [p.errorCode + (p.info ? ': ' + p.info : '')] : [];
        if (p.status !== 'Charging') d.kw = 0;
        return {};

      case 'Authorize':
        return { idTagInfo: { status: this.authorize(p.idTag) } };

      case 'StartTransaction': {
        const status = this.authorize(p.idTag);
        const tx = d.txSeq++;
        const key = d.keys.find((k) => k.tag === p.idTag);
        d.carId = key ? key.carId || null : p.idTag === PANEL_TAG ? d.carId : null;
        const socStart = d.carId ? d.socByCar[d.carId] ?? null : null;
        const start = Date.parse(p.timestamp) || now;
        const day = this.day(start);
        const h = hk(d.carId);
        day['#' + h] = (day['#' + h] || 0) + 1;
        d.session = {
          tx, start, meterStart: p.meterStart || 0, energy: 0,
          socStart, carId: d.carId, keyId: key ? key.id : null, idTag: p.idTag, closed: false,
          day: this.dayKey(start), base: day[h] || 0, costBase: day['$' + h] || 0, tariff: d.tariff,
        };
        d.soc = socStart;
        d.reached = false;
        d.paused = false;
        this.series = [{ t: now, kw: 0 }];
        await this.ctx.storage.put('series', this.series);
        this.after = () => this.applyStart();
        return { transactionId: tx, idTagInfo: { status } };
      }

      case 'MeterValues':
        this.readMeter(p);
        return {};

      case 'StopTransaction': {
        const s = d.session;
        if (s && !s.closed) {
          if (typeof p.meterStop === 'number') s.energy = Math.max(0, (p.meterStop - s.meterStart) / 1000);
          s.closed = true;
          s.end = Date.parse(p.timestamp) || now;
          this.book(s);
          if (s.carId && d.soc != null) d.socByCar[s.carId] = Math.round(d.soc);
          if (typeof p.meterStop === 'number') d.meterTotal = p.meterStop / 1000;
          d.kw = 0;
        }
        return { idTagInfo: { status: 'Accepted' } };
      }

      case 'DataTransfer':
        return { status: 'Accepted' };

      default: // FirmwareStatusNotification, DiagnosticsStatusNotification, etc.
        return {};
    }
  }

  authorize(tag) {
    const d = this.d;
    if (!tag) return 'Accepted';
    if (tag === PANEL_TAG) return 'Accepted';
    const now = Date.now();
    d.tags = [{ tag, t: now }, ...d.tags.filter((x) => x.tag !== tag)].slice(0, 6);
    let key = d.keys.find((k) => k.tag === tag);
    if (!key && (d.learning > now || d.keys.length === 0)) {
      key = { id: 'k' + crypto.randomUUID().slice(0, 8), tag, name: `Llave ${d.keys.length + 1}`, carId: null, lastT: now };
      d.keys.push(key);
      d.learning = 0;
      this.event({ event: 'learned', key: { id: key.id, name: key.name } });
    }
    if (!key) return 'Invalid';
    key.lastT = now;
    return 'Accepted';
  }

  readMeter(p) {
    const d = this.d;
    const s = d.session;
    let reg = null, power = null;
    const cur = [null, null, null], volt = [null, null, null], phPow = [null, null, null];
    let socMeas = null;
    for (const mv of p.meterValue || []) {
      for (const sv of mv.sampledValue || []) {
        const meas = sv.measurand || 'Energy.Active.Import.Register';
        let v = parseFloat(sv.value);
        if (Number.isNaN(v)) continue;
        const i = phaseIdx(sv.phase);
        const unit = (sv.unit || '').toLowerCase();
        if (meas === 'Energy.Active.Import.Register') { if (unit === 'kwh') v *= 1000; if (i < 0) reg = v; }
        else if (meas === 'Power.Active.Import') { if (unit === 'kw') v *= 1000; if (i < 0) power = v; else phPow[i] = v; }
        else if (meas === 'Current.Import') { if (i >= 0) cur[i] = v; else if (cur[0] === null) cur[0] = v; }
        else if (meas === 'Voltage') { if (i >= 0) volt[i] = v; }
        else if (meas === 'SoC') socMeas = v;
      }
    }
    if (power === null && phPow.some((x) => x !== null)) power = phPow.reduce((a, b) => a + (b || 0), 0);
    if (power === null && cur.some((x) => x !== null)) power = cur.reduce((a, c, i) => a + (c || 0) * (volt[i] || 230), 0);
    if (power !== null) d.kw = Math.max(0, power / 1000);
    const hasCur = cur.some((x) => x !== null);
    d.phases = d.phases.map((ph, i) => ({ a: hasCur ? cur[i] || 0 : ph.a, v: volt[i] ?? ph.v }));
    if (reg !== null) d.meterTotal = reg / 1000;

    if (s && !s.closed && (!p.transactionId || p.transactionId === s.tx)) {
      if (reg !== null) s.energy = Math.max(0, (reg - s.meterStart) / 1000);
      const bat = this.battery(s.carId);
      d.soc = socMeas !== null ? socMeas
        : s.socStart != null && bat ? Math.min(100, s.socStart + (s.energy / bat) * 100)
        : s.socStart != null ? s.socStart : null;
      this.book(s);
      const now = Date.now();
      const last = this.series[this.series.length - 1];
      if (!last || now - last.t >= 5000) {
        this.series.push({ t: now, kw: d.kw });
        if (this.series.length > 3000) this.series.splice(0, this.series.length - 3000);
        this.ctx.storage.put('series', this.series);
      }
      this.checkTarget();
    }
  }

  checkTarget() {
    const d = this.d;
    const s = d.session;
    if (!s || s.closed || d.reached) return;
    const sch = d.schedule;
    if (!sch.enabled) return; // carga libre: corta el auto
    let hit = false;
    if (sch.mode === 'soc') hit = d.soc != null && d.soc >= sch.soc;
    else if (sch.mode === 'energy') hit = s.energy >= sch.kwh;
    else hit = (Date.now() - s.start) / 60000 >= sch.minutes;
    if (hit) {
      d.reached = true;
      this.after = () => this.setLimit(0);
    }
  }

  /* ---------- OCPP: órdenes al cargador ---------- */

  call(action, payload) {
    const ws = this.ctx.getWebSockets('ocpp')[0];
    if (!ws) return Promise.reject(new Error('El cargador no está conectado'));
    const id = crypto.randomUUID();
    const out = JSON.stringify([2, id, action, payload]);
    this.logMsg('→', out);
    ws.send(out);
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('El cargador no respondió')); }, 15000);
    });
  }

  async configure() {
    const MEAS = 'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage';
    const results = {};
    const set = async (key, value) => {
      const r = await this.call('ChangeConfiguration', { key, value }).catch((e) => ({ status: 'Error: ' + e.message }));
      results[key] = r.status;
    };
    // Mientras carga: cada 10 s
    await set('MeterValueSampleInterval', '10');
    await set('MeterValuesSampledData', MEAS);
    // Siempre (aunque no cargue): cada 15 s, para ver voltaje y fases con el cargador encendido
    await set('ClockAlignedDataInterval', '15');
    await set('MeterValuesAlignedData', MEAS);
    this.d.cfgSet = results;
    try {
      const r = await this.call('GetConfiguration', {});
      this.d.cfg = (r.configurationKey || []).map((k) => [k.key, k.value]).slice(0, 150);
    } catch {}
    await this.save();
    await this.trigger();
    this.broadcast();
  }

  // Pide al cargador los valores actuales y su estado ya mismo
  async trigger() {
    this.lastTrigger = Date.now();
    await this.call('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 }).catch(() => {});
    await this.call('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: 1 }).catch(() => {});
  }

  profile(periods) {
    return {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 100,
        transactionId: this.d.session ? this.d.session.tx : undefined,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: { startSchedule: iso(Date.now()), chargingRateUnit: 'A', chargingSchedulePeriod: periods },
      },
    };
  }

  async setLimit(a) {
    const r = await this.call('SetChargingProfile', this.profile([{ startPeriod: 0, limit: a }]));
    if (r.status && r.status !== 'Accepted') throw new Error('El cargador rechazó el cambio');
    return r;
  }

  async applyStart() {
    const sch = this.d.schedule;
    if (!sch.enabled) return null;
    if (sch.startMode === 'at') {
      const wait = this.secondsUntil(sch.startAt);
      if (wait > 60) {
        return this.call('SetChargingProfile', this.profile([{ startPeriod: 0, limit: 0 }, { startPeriod: wait, limit: sch.limitA }]));
      }
    }
    if (sch.limitA < 32) return this.setLimit(sch.limitA);
    return null;
  }

  secondsUntil(hhmm) {
    const [h, m] = String(hhmm || '00:00').split(':').map(Number);
    const local = new Date(Date.now() + this.tz);
    const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - this.tz;
    let diff = (target - Date.now()) / 1000;
    if (diff < 0) diff += 86400;
    if (diff > 16 * 3600) diff = 0; // ya estamos dentro del horario
    return Math.round(diff);
  }

  /* ---------- Página ---------- */

  async onUi(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    let r;
    try {
      r = await this.command(m.cmd, m.arg);
    } catch (e) {
      r = { ok: false, msg: e.message || 'No se pudo' };
    }
    try { ws.send(JSON.stringify({ type: 'reply', id: m.id, ...r })); } catch {}
    await this.save();
    this.broadcast();
    if (this.after) { const fn = this.after; this.after = null; fn().catch(() => {}); }
  }

  async command(cmd, arg) {
    const d = this.d;
    const s = d.session && !d.session.closed ? d.session : null;
    switch (cmd) {
      case 'toggle': {
        if (s && d.status === 'Charging') {
          await this.setLimit(0);
          d.paused = true;
          return { ok: true, msg: 'Carga en pausa' };
        }
        if (s && String(d.status).startsWith('Suspended')) {
          await this.setLimit(d.schedule.enabled ? d.schedule.limitA : 32);
          d.paused = false;
          d.reached = false;
          return { ok: true, msg: 'Carga reanudada' };
        }
        const key = d.keys.find((k) => k.carId === d.carId);
        const r = await this.call('RemoteStartTransaction', { connectorId: 1, idTag: key ? key.tag : PANEL_TAG });
        return r.status === 'Accepted' ? { ok: true, msg: 'Carga iniciada' } : { ok: false, msg: 'El cargador no aceptó iniciar' };
      }
      case 'stop': {
        if (!s) return { ok: false, msg: 'No hay una carga en curso' };
        const r = await this.call('RemoteStopTransaction', { transactionId: s.tx });
        return r.status === 'Accepted' ? { ok: true, msg: 'Carga detenida' } : { ok: false, msg: 'El cargador no aceptó detener' };
      }
      case 'unlock': {
        if (d.status === 'Charging') return { ok: false, msg: 'Primero detené la carga' };
        const r = await this.call('UnlockConnector', { connectorId: 1 });
        return r.status === 'Unlocked' ? { ok: true, msg: 'Cable liberado' } : { ok: false, msg: 'No se pudo liberar el cable' };
      }
      case 'reset': {
        const r = await this.call('Reset', { type: 'Soft' });
        return r.status === 'Accepted' ? { ok: true, msg: 'Reiniciando el cargador…' } : { ok: false, msg: 'El cargador no aceptó reiniciar' };
      }
      case 'setSchedule': {
        const n = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
        d.schedule = {
          enabled: !!arg.enabled,
          mode: ['soc', 'time', 'energy'].includes(arg.mode) ? arg.mode : 'soc',
          soc: n(arg.soc, 20, 100, 80),
          minutes: n(arg.minutes, 15, 1440, 120),
          kwh: n(arg.kwh, 1, 200, 20),
          startMode: arg.startMode === 'at' ? 'at' : 'plug',
          startAt: /^\d{2}:\d{2}$/.test(arg.startAt) ? arg.startAt : '23:00',
          limitA: n(arg.limitA, 6, 32, 32),
        };
        d.reached = false;
        const msg = d.schedule.enabled ? 'Programación activada' : 'Carga libre';
        if (s) {
          try {
            if (!d.schedule.enabled) await this.setLimit(32);
            else if (d.schedule.startMode === 'at') await this.applyStart();
            else await this.setLimit(d.schedule.limitA);
          } catch { return { ok: true, msg: msg + ' (se aplica en la próxima carga)' }; }
          this.checkTarget();
        }
        return { ok: true, msg };
      }
      case 'setCar': {
        const car = d.cars.find((c) => c.id === arg);
        if (arg && !car) return { ok: false, msg: 'Auto desconocido' };
        d.carId = car ? car.id : null;
        if (s) {
          const day = this.d.history[s.day || this.dayKey(s.start)] || this.day(s.start);
          const from = hk(s.carId), to = hk(d.carId);
          if (from !== to) {
            const cost = s.tariff != null ? s.energy * s.tariff : 0;
            day[from] = Math.max(0, (day[from] || 0) - s.energy);
            if (day['$' + from] != null) day['$' + from] = Math.max(0, day['$' + from] - cost);
            day['#' + from] = Math.max(0, (day['#' + from] || 0) - 1);
            day['#' + to] = (day['#' + to] || 0) + 1;
            s.base = day[to] || 0;
            s.costBase = day['$' + to] || 0;
          }
          s.carId = d.carId;
          this.book(s);
          if (s.socStart == null && d.carId) s.socStart = d.socByCar[d.carId] ?? null;
        }
        return { ok: true, msg: car ? 'Auto: ' + car.name : 'Sin auto asignado' };
      }
      case 'saveCar': {
        const name = String(arg?.name || '').trim().slice(0, 30);
        if (!name) return { ok: false, msg: 'Poné un nombre para el auto' };
        const bat = Number(arg.batteryKWh);
        const batteryKWh = Number.isFinite(bat) && bat > 1 && bat < 300 ? bat : null;
        let car = d.cars.find((c) => c.id === arg.id);
        if (car) Object.assign(car, { name, batteryKWh });
        else {
          car = { id: 'c' + crypto.randomUUID().slice(0, 8), name, batteryKWh, color: PALETTE[d.cars.length % PALETTE.length] };
          d.cars.push(car);
        }
        return { ok: true, msg: 'Auto guardado', carId: car.id };
      }
      case 'deleteCar':
        d.cars = d.cars.filter((c) => c.id !== arg);
        d.keys.forEach((k) => { if (k.carId === arg) k.carId = null; });
        if (d.carId === arg) d.carId = null;
        return { ok: true, msg: 'Auto borrado' };
      case 'setSoc': {
        const v = Math.min(100, Math.max(0, Number(arg)));
        if (!Number.isFinite(v)) return { ok: false, msg: 'Porcentaje inválido' };
        d.soc = v;
        const bat = s ? this.battery(s.carId) : null;
        if (s) s.socStart = bat ? Math.round(v - (s.energy / bat) * 100) : v;
        else if (d.carId) d.socByCar[d.carId] = v;
        return { ok: true, msg: `Batería corregida a ${Math.round(v)} %` };
      }
      case 'setTariff': {
        const v = Number(String(arg).replace(',', '.'));
        if (!Number.isFinite(v) || v < 0 || v > 1e6) return { ok: false, msg: 'Precio inválido' };
        d.tariff = v;
        d.tariffSince = Date.now();
        if (s) { s.tariff = v; this.book(s); }
        return { ok: true, msg: 'Precio guardado' };
      }
      case 'learnKey':
        d.learning = Date.now() + 60000;
        return { ok: true, msg: 'Apoyá la llave en el cargador', learning: true };
      case 'editKey': {
        const k = d.keys.find((x) => x.id === arg?.id);
        if (!k) return { ok: false, msg: 'Llave no encontrada' };
        if (arg.name) k.name = String(arg.name).trim().slice(0, 30) || k.name;
        if ('carId' in arg) k.carId = d.cars.some((c) => c.id === arg.carId) ? arg.carId : null;
        return { ok: true, msg: 'Llave actualizada' };
      }
      case 'deleteKey':
        d.keys = d.keys.filter((x) => x.id !== arg);
        return { ok: true, msg: 'Llave borrada' };
      default:
        return { ok: false, msg: 'Comando desconocido' };
    }
  }

  /* ---------- Estado para la página ---------- */

  battery(carId) {
    const c = this.d.cars.find((x) => x.id === carId);
    return (c && c.batteryKWh) || null;
  }

  // Anota la energía y el costo de la sesión en el día en que empezó
  book(s) {
    const day = this.d.history[s.day || this.dayKey(s.start)] || this.day(s.start);
    const h = hk(s.carId);
    day[h] = (s.base || 0) + s.energy;
    if (s.tariff != null) day['$' + h] = (s.costBase || 0) + s.energy * s.tariff;
  }

  dayKey(t) {
    return new Date(t + this.tz).toISOString().slice(0, 10);
  }

  day(t) {
    const k = this.dayKey(t);
    if (!this.d.history[k]) {
      this.d.history[k] = {};
      const keys = Object.keys(this.d.history).sort();
      for (const old of keys.slice(0, Math.max(0, keys.length - 800))) delete this.d.history[old];
    }
    return this.d.history[k];
  }

  lastLabel(t) {
    if (!t) return '—';
    const today = this.dayKey(Date.now());
    const k = this.dayKey(t);
    if (k === today) return 'hoy';
    if (k === this.dayKey(Date.now() - DAY)) return 'ayer';
    if (Date.now() - t < 6 * DAY) return NAMES[new Date(t + this.tz).getUTCDay()].toLowerCase();
    return k.slice(8, 10) + '/' + k.slice(5, 7);
  }

  snapshot() {
    const d = this.d;
    const now = Date.now();
    const online = this.ctx.getWebSockets('ocpp').length > 0 && now - d.lastSeen < 200000;
    const history = [];
    for (let i = 6; i >= 0; i--) {
      const t = now - i * DAY;
      const v = d.history[this.dayKey(t)] || {};
      history.push({
        label: i === 0 ? 'Hoy' : NAMES[new Date(t + this.tz).getUTCDay()],
        today: i === 0,
        kwh: Object.fromEntries([...d.cars.map((c) => [c.id, v[c.id] || 0]), [NOCAR, v[NOCAR] || 0]]),
      });
    }
    const s = d.session;
    return {
      mode: 'live',
      online,
      lastSeen: d.lastSeen,
      now,
      status: online ? d.status : 'Offline',
      reached: d.reached,
      cars: d.cars,
      carId: d.carId,
      keyId: s && !s.closed ? s.keyId : null,
      batteryKWh: this.battery(s && !s.closed ? s.carId : d.carId),
      limitA: d.schedule.limitA,
      kw: online ? d.kw : 0,
      phases: d.phases,
      session: s ? { start: s.start, end: s.end, socStart: s.socStart, energy: s.energy, closed: s.closed, carId: s.carId, tariff: s.tariff ?? null } : null,
      soc: d.soc,
      schedule: d.schedule,
      meterTotal: d.meterTotal - (s && !s.closed ? s.energy : 0),
      connector: d.connector,
      faults: d.faults,
      tariff: d.tariff,
      tariffSince: d.tariffSince,
      days: d.history,
      series: this.series,
      keys: d.keys.map((k) => ({ id: k.id, name: k.name, carId: k.carId, last: this.lastLabel(k.lastT) })),
      tags: d.tags.slice(0, 3),
      learning: d.learning > now,
      boot: d.boot,
      chargerId: d.chargerId,
      attempts: d.attempts || [],
      diag: { cfgSet: d.cfgSet || {}, cfg: d.cfg || [], log: this.log || [] },
      history,
    };
  }

  broadcast() {
    const msg = JSON.stringify({ type: 'state', state: this.snapshot() });
    for (const ws of this.ctx.getWebSockets('ui')) { try { ws.send(msg); } catch {} }
  }

  event(e) {
    const msg = JSON.stringify({ type: 'event', ...e });
    for (const ws of this.ctx.getWebSockets('ui')) { try { ws.send(msg); } catch {} }
  }

  logMsg(dir, raw) {
    this.log = this.log || [];
    this.log.unshift({ t: Date.now(), dir, m: String(raw).slice(0, 400) });
    if (this.log.length > 20) this.log.length = 20;
  }

  async save() {
    await this.ctx.storage.put('d', this.d);
  }
}

function iso(t) {
  return new Date(t).toISOString();
}

function phaseIdx(ph) {
  if (!ph) return -1;
  const m = String(ph).match(/L([123])/);
  return m ? Number(m[1]) - 1 : -1;
}

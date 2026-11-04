// Cargador simulado: se comporta como el real para probar la página sin tocar el equipo.
const DAY = 86400000;
const DEMO_CARS = [
  { id: 't1', name: 'Jetour T1 i-DM', color: '#2BFF88', batteryKWh: 26.7, chem: 'LFP', learn: { n: 3, eff: 0.91 } },
  { id: 'dolphin', name: 'BYD Dolphin', color: '#19C8FF', batteryKWh: 44.9 },
  { id: 'kangoo', name: 'Kangoo E-Tech', color: '#A9B8FF', batteryKWh: 45, chem: 'NMC' },
];
const NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export class SimSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.subs = new Set();
    const now = Date.now();
    const start = now - 46 * 60000;
    const car = DEMO_CARS[0];

    const series = [];
    for (let t = start; t <= now; t += 15000) {
      const m = (t - start) / 60000;
      series.push({ t, kw: m < 2 ? (6.62 * m) / 2 : 6.62 + wobble(t) });
    }

    this.s = {
      mode: 'sim',
      online: true,
      lastSeen: now,
      now,
      status: 'Charging',
      reached: false,
      cars: DEMO_CARS.map((c) => ({ ...c })),
      carId: car.id,
      keyId: 'k1',
      batteryKWh: car.batteryKWh,
      carMaxKw: 6.62,
      limitA: 32,
      kw: 6.62,
      phases: [{ a: 28.8, v: 230 }, { a: 0, v: 231 }, { a: 0, v: 229 }],
      session: { start, socStart: new URLSearchParams(location.search).has('sinllegada') ? null : 43, energy: 5.07, closed: false, carId: car.id, base: 0, costBase: 0, tariff: cfg.tariff, day: dkey(new Date(start)) },
      // en la demo la programación arranca apagada (carga libre), igual que en el real
      soc: 62,
      schedule: { enabled: false, mode: 'soc', soc: 80, minutes: 120, kwh: 20, startMode: 'plug', startAt: '23:00', limitA: 32 },
      meterTotal: 1279.5,
      connector: 'Bloqueado',
      faults: [],
      tariff: cfg.tariff,
      series,
      keys: [
        { id: 'k1', name: 'Teléfono Gastón', carId: 't1', last: 'hoy' },
        { id: 'k2', name: 'Tarjeta azul', carId: 'dolphin', last: 'jueves' },
        { id: 'k3', name: 'Llavero', carId: 'kangoo', last: 'viernes' },
      ],
      days: this.makeDays(now),
      tariffSince: now - 20 * DAY,
    };
    this.lastPush = now;
    setInterval(() => this.tick(), 1000);
  }

  subscribe(fn) {
    this.subs.add(fn);
    fn(this.s);
    return () => this.subs.delete(fn);
  }

  emit() {
    for (const fn of this.subs) fn(this.s);
  }

  makeDays(now) {
    const days = {};
    const ids = DEMO_CARS.map((c) => c.id);
    for (let i = 60; i >= 1; i--) {
      const d = new Date(now - i * DAY);
      const v = {};
      ids.forEach((id, j) => {
        if ((i * 7 + j * 3) % 5 < 2) {
          const k = 6 + ((i * 13 + j * 7) % 17);
          v[id] = k; v['$' + id] = k * this.cfg.tariff; v['#' + id] = 1;
        }
      });
      days[dkey(d)] = v;
    }
    days[dkey(new Date(now))] = { t1: 0, '#t1': 1 };
    return days;
  }

  targetReached() {
    const s = this.s;
    const sch = s.schedule;
    if (!s.session || !sch.enabled) return false;
    if (sch.mode === 'soc') return s.soc >= sch.soc;
    if (sch.mode === 'energy') return s.session.energy >= sch.kwh;
    return (s.now - s.session.start) / 60000 >= sch.minutes;
  }

  tick() {
    const s = this.s;
    const now = Date.now();
    s.now = now;
    if (s.online) s.lastSeen = now;

    if (s.status === 'Charging') {
      const base = Math.min(s.carMaxKw, (s.limitA * 230) / 1000);
      s.kw = Math.max(0, base + wobble(now));
      s.session.energy += s.kw / 3600;
      s.session.addedPct = (s.session.energy * 0.9 / s.batteryKWh) * 100;
      s.soc = s.session.socStart == null ? null : Math.min(100, s.session.socStart + s.session.addedPct);
      if (this.targetReached()) {
        s.status = 'SuspendedEVSE';
        s.reached = true;
        s.kw = 0;
      }
    } else {
      s.kw = 0;
    }

    s.phases[0].a = (s.kw * 1000) / 230;
    s.phases.forEach((p, i) => { p.v = 229 + ((i + Math.floor(now / 4000)) % 3); });

    if (now - this.lastPush >= 5000) {
      s.series.push({ t: now, kw: s.kw });
      this.lastPush = now;
      if (s.series.length > 4000) s.series.shift();
    }

    if (s.session && !s.session.closed) {
      const se = s.session, h = se.carId || '_';
      const day = s.days[se.day] || (s.days[se.day] = {});
      day[h] = (se.base || 0) + se.energy;
      if (se.tariff != null) day['$' + h] = (se.costBase || 0) + se.energy * se.tariff;
    }

    this.emit();
  }

  async command(name, arg) {
    const s = this.s;
    let msg = '';
    switch (name) {
      case 'toggle':
        if (s.status === 'Charging') {
          s.status = 'SuspendedEVSE'; s.kw = 0; s.reached = false; msg = 'Carga en pausa';
        } else if (s.status === 'SuspendedEVSE' || s.status === 'SuspendedEV') {
          s.status = 'Charging'; s.reached = false; msg = 'Carga reanudada';
        } else if (['Preparing', 'Finishing', 'Available'].includes(s.status)) {
          const k = dkey(new Date()), h = s.carId || '_';
          const day = s.days[k] || (s.days[k] = {});
          day['#' + h] = (day['#' + h] || 0) + 1;
          s.session = { start: Date.now(), socStart: Math.round(s.soc), energy: 0, closed: false, carId: s.carId, base: day[h] || 0, costBase: day['$' + h] || 0, tariff: s.tariff, day: k };
          s.series = [{ t: Date.now(), kw: 0 }];
          s.status = 'Charging'; s.reached = false; msg = 'Carga iniciada';
        }
        break;
      case 'stop':
        if (s.session && !s.session.closed) {
          s.meterTotal += s.session.energy;
          s.session.closed = true;
          s.session.end = Date.now();
          s.status = 'Finishing'; s.kw = 0; msg = 'Carga detenida';
        }
        break;
      case 'unlock':
        if (s.status === 'Charging') return { ok: false, msg: 'Primero detené la carga' };
        s.connector = 'Liberado';
        setTimeout(() => { s.connector = 'Bloqueado'; this.emit(); }, 8000);
        msg = 'Cable liberado';
        break;
      case 'reset': {
        const wasCharging = s.status === 'Charging';
        s.online = false; s.status = 'Offline'; s.kw = 0;
        setTimeout(() => {
          s.online = true;
          s.status = wasCharging || (s.session && !s.session.closed) ? 'Charging' : 'Available';
          this.emit();
        }, 5000);
        msg = 'Reiniciando el cargador…';
        break;
      }
      case 'setSchedule':
        s.schedule = { ...arg };
        s.limitA = arg.limitA;
        if (s.reached && !this.targetReached()) { s.status = 'Charging'; s.reached = false; }
        msg = arg.enabled ? 'Programación activada' : 'Carga libre';
        break;
      case 'setCar': {
        const car = s.cars.find((c) => c.id === arg);
        if (!car) { s.carId = null; if (s.session) s.session.carId = null; msg = 'Sin auto asignado'; break; }
        s.carId = car.id;
        if (s.session && !s.session.closed) s.session.carId = car.id;
        s.batteryKWh = car.batteryKWh;
        msg = `Auto: ${car.name}`;
        break;
      }
      case 'saveCar': {
        const name = String(arg.name || '').trim();
        if (!name) return { ok: false, msg: 'Poné un nombre para el auto' };
        const bat = Number(arg.batteryKWh) > 1 ? Number(arg.batteryKWh) : null;
        let c = s.cars.find((x) => x.id === arg.id);
        if (c) Object.assign(c, { name, batteryKWh: bat, chem: arg.chem });
        else { c = { id: 'c' + Date.now(), name, batteryKWh: bat, chem: arg.chem, color: ['#7DF9FF', '#B6FF3B', '#5B8CFF'][s.cars.length % 3] }; s.cars.push(c); }
        this.emit();
        return { ok: true, msg: 'Auto guardado', carId: c.id };
      }
      case 'registerApp': {
        let k = s.keys.find((x) => x.dev === arg.dev);
        if (!k) { k = { id: 'k' + Date.now(), name: arg.name, carId: null, last: 'recién', dev: arg.dev }; s.keys.push(k); }
        this.emit();
        return { ok: true, msg: 'Teléfono registrado como llave', keyId: k.id };
      }
      case 'cancelStart':
        s.pendingStart = false;
        msg = 'Inicio cancelado';
        break;
      case 'setStartSoc':
        if (s.session) { s.session.socStart = Number(arg); s.soc = Math.min(100, Number(arg) + (s.session.addedPct || 0)); }
        msg = `Llegó con ${arg} %`;
        break;
      case 'setTariff':
        s.tariff = Number(arg);
        s.tariffSince = Date.now();
        if (s.session && !s.session.closed) s.session.tariff = s.tariff;
        msg = 'Precio guardado';
        break;
      case 'deleteCar':
        s.cars = s.cars.filter((c) => c.id !== arg);
        s.keys.forEach((k) => { if (k.carId === arg) k.carId = null; });
        msg = 'Auto borrado';
        break;
      case 'editKey': {
        const k = s.keys.find((x) => x.id === arg.id);
        if (!k) return { ok: false, msg: 'Llave no encontrada' };
        if (arg.name) k.name = arg.name;
        if ('carId' in arg) k.carId = arg.carId;
        msg = 'Llave guardada';
        break;
      }
      case 'deleteKey':
        s.keys = s.keys.filter((x) => x.id !== arg);
        msg = 'Llave borrada';
        break;
      case 'learnKey':
        await new Promise((r) => setTimeout(r, 3000));
        const id = 'k' + Date.now();
        s.keys.push({ id, name: `Llave ${s.keys.length + 1}`, carId: null, last: 'recién' });
        this.emit();
        return { ok: true, msg: 'Llave nueva detectada', keyId: id };
      case 'setSoc': {
        const v = Math.min(100, Math.max(0, Number(arg)));
        if (s.session && !s.session.closed) s.session.socStart = Math.round(v - (s.session.energy / s.batteryKWh) * 100);
        s.soc = v;
        msg = `Batería corregida a ${Math.round(v)} %`;
        break;
      }
      default:
        return { ok: false, msg: 'Comando desconocido' };
    }
    this.emit();
    return { ok: true, msg };
  }
}

function dkey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function wobble(t) {
  return Math.sin(t / 1700) * 0.03 + Math.sin(t / 4100) * 0.02 + Math.sin(t / 23000) * 0.05;
}

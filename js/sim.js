// Cargador simulado: se comporta como el real para probar la página sin tocar el equipo.
const DAY = 86400000;
const NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export class SimSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.subs = new Set();
    const now = Date.now();
    const start = now - 46 * 60000;
    const car = cfg.cars[0];

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
      cars: cfg.cars,
      carId: car.id,
      keyId: 'k1',
      batteryKWh: car.batteryKWh || cfg.simBatteryKWh,
      carMaxKw: 6.62,
      limitA: 32,
      kw: 6.62,
      phases: [{ a: 28.8, v: 230 }, { a: 0, v: 231 }, { a: 0, v: 229 }],
      session: { start, socStart: 43, energy: 5.07, closed: false, carId: car.id, base: 0 },
      soc: 62,
      schedule: { mode: 'soc', soc: 80, minutes: 120, kwh: 20, startMode: 'plug', startAt: '23:00', limitA: 32 },
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
      history: this.makeHistory(now),
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

  makeHistory(now) {
    const pat = [[0, 12, 0], [6, 0, 18], [7, 14, 0], [0, 0, 22], [8, 11, 0], [5, 0, 15]];
    const ids = this.cfg.cars.map((c) => c.id);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * DAY);
      const v = i === 0 ? [0, 0, 0] : pat[(6 - i) % pat.length];
      days.push({
        label: i === 0 ? 'Hoy' : NAMES[d.getDay()],
        today: i === 0,
        kwh: Object.fromEntries(ids.map((id, j) => [id, v[j] || 0])),
      });
    }
    return days;
  }

  targetReached() {
    const s = this.s;
    const sch = s.schedule;
    if (!s.session) return false;
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
      s.soc = Math.min(100, s.session.socStart + (s.session.energy / s.batteryKWh) * 100);
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

    const today = s.history[s.history.length - 1];
    if (s.session && !s.session.closed) today.kwh[s.session.carId] = (s.session.base || 0) + s.session.energy;

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
          s.session = { start: Date.now(), socStart: Math.round(s.soc), energy: 0, closed: false, carId: s.carId, base: s.history[s.history.length - 1].kwh[s.carId] || 0 };
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
        msg = 'Programación guardada';
        break;
      case 'setCar': {
        const car = s.cars.find((c) => c.id === arg);
        if (!car) break;
        s.carId = car.id;
        if (s.session && !s.session.closed) s.session.carId = car.id;
        s.batteryKWh = car.batteryKWh || this.cfg.simBatteryKWh;
        msg = `Auto: ${car.name}`;
        break;
      }
      case 'learnKey':
        await new Promise((r) => setTimeout(r, 3000));
        s.keys.push({ id: 'k' + Date.now(), name: `Llave ${s.keys.length + 1}`, carId: s.carId, last: 'recién' });
        msg = 'Llave nueva guardada';
        break;
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

function wobble(t) {
  return Math.sin(t / 1700) * 0.03 + Math.sin(t / 4100) * 0.02 + Math.sin(t / 23000) * 0.05;
}

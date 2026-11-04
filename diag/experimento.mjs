// Activa ISO 15118 en el cargador (para que el auto informe su %) y vuelve a pedir el SoC.
// Solo actúa si el cargador está en línea y SIN carga en curso.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const SERVER = 'wss://diby-ev.mainthorcar.workers.dev';
const token = createHash('sha256').update('diby-ev:' + process.env.PANEL_PASSWORD).digest('hex');
const MEAS = 'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage';
const out = [];
const log = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function conectar() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${SERVER}/api/live?token=${token}`);
    const waits = new Map();
    let state = null;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'state') { state = m.state; if (!ws.ready) { ws.ready = true; res(api); } }
      if (m.type === 'reply' && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    };
    ws.onerror = () => rej(new Error('sin conexión'));
    const api = {
      get state() { return state; },
      cmd: (cmd, arg) => new Promise((r) => { const id = Math.random().toString(36).slice(2); waits.set(id, r); ws.send(JSON.stringify({ id, cmd, arg })); setTimeout(() => { if (waits.delete(id)) r({ ok: false, msg: 'sin respuesta' }); }, 25000); }),
      close: () => ws.close(),
    };
  });
}

let c = await conectar();
log('Cargador:', c.state.online ? 'en línea' : 'DESCONECTADO', '| estado:', c.state.status);
if (!c.state.online || (c.state.session && !c.state.session.closed)) { log('No se toca nada (desconectado o cargando).'); writeFileSync('diag/experimento.txt', out.join('\n')); process.exit(0); }

let r = await c.cmd('setConfig', { key: 'ISO15118ChargeEnabled', value: 'true' });
log('Activar ISO 15118 →', r.status || r.msg);
r = await c.cmd('setConfig', { key: 'MeterValuesSampledData', value: MEAS + ',SoC' });
log('Pedir % (SoC) con ISO 15118 activo →', r.status || r.msg);
if (r.status !== 'Accepted') { r = await c.cmd('setConfig', { key: 'MeterValuesSampledData', value: MEAS }); log('Volver a los datos normales →', r.status || r.msg); }
// Probar uno por uno todos los datos que define OCPP 1.6
const CAND = ['SoC', 'Current.Offered', 'Power.Offered', 'Frequency', 'Temperature', 'Power.Factor', 'Current.Export',
  'Energy.Active.Export.Register', 'Energy.Reactive.Import.Register', 'Power.Reactive.Import', 'Energy.Active.Import.Interval',
  'Power.Active.Export', 'RPM'];
const ok = [];
log('--- Datos que acepta informar (probados de a uno) ---');
for (const m of CAND) {
  r = await c.cmd('setConfig', { key: 'MeterValuesAlignedData', value: MEAS + ',' + m });
  log('  ', m.padEnd(34), '→', r.status || r.msg);
  if (r.status === 'Accepted') ok.push(m);
}
// Dejar pedidos los normales + los extra aceptados (máximo 10)
const fin = [MEAS, ...ok].join(',').split(',').slice(0, 10).join(',');
r = await c.cmd('setConfig', { key: 'MeterValuesAlignedData', value: fin });
log('Datos cada 15 s →', fin, '→', r.status || r.msg);
r = await c.cmd('setConfig', { key: 'MeterValuesSampledData', value: fin });
log('Datos durante la carga →', fin, '→', r.status || r.msg);
log('--- Todos los ajustes del cargador ---');
r = await c.cmd('getConfig', {});
for (const k of r.config || []) log('  ', (k.readonly ? '[fijo]      ' : '[cambiable] ') + k.key, '=', k.value);
c.close();
writeFileSync('diag/experimento.txt', out.join('\n'));
process.exit(0);

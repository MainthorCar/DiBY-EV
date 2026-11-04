// Parte 2: reiniciar el cargador (para que tome ISO 15118) y volver a pedir el %.
// Solo si está en línea y sin carga.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const SERVER = 'wss://diby-ev.mainthorcar.workers.dev';
const token = createHash('sha256').update('diby-ev:' + process.env.PANEL_PASSWORD).digest('hex');
const BASE = 'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,Current.Offered,Power.Offered,Frequency,Energy.Reactive.Import.Register';
const out = [];
const log = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const guardar = () => writeFileSync('diag/experimento2.txt', out.join('\n'));

function conectar() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${SERVER}/api/live?token=${token}`);
    const waits = new Map();
    let state = null;
    const t = setTimeout(() => rej(new Error('tiempo')), 20000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'state') { state = m.state; if (!ws.ready) { ws.ready = true; clearTimeout(t); res(api); } }
      if (m.type === 'reply' && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    };
    ws.onerror = () => { clearTimeout(t); rej(new Error('sin conexión')); };
    const api = {
      get state() { return state; },
      cmd: (cmd, arg) => new Promise((r) => {
        const id = Math.random().toString(36).slice(2);
        waits.set(id, r);
        ws.send(JSON.stringify({ id, cmd, arg }));
        setTimeout(() => { if (waits.delete(id)) r({ ok: false, msg: 'sin respuesta' }); }, 25000);
      }),
      close: () => ws.close(),
    };
  });
}

let c = await conectar();
log('Antes:', c.state.online ? 'en línea' : 'desconectado', '|', c.state.status);
if (!c.state.online || (c.state.session && !c.state.session.closed)) { log('No se reinicia (desconectado o cargando).'); guardar(); process.exit(0); }
let r = await c.cmd('reset');
log('Reiniciar →', r.msg);
c.close();
await sleep(60000);
let ok = false;
for (let i = 0; i < 24 && !ok; i++) {
  await sleep(30000);
  try { c = await conectar(); ok = c.state.online && c.state.status !== 'Offline'; if (!ok) c.close(); } catch {}
  log('  ', new Date().toISOString().slice(11, 19), ok ? 'volvió en línea' : 'esperando que vuelva…');
}
if (!ok) { log('El cargador no volvió en 13 minutos.'); guardar(); process.exit(0); }
await sleep(20000);
r = await c.cmd('getConfig', { keys: ['ISO15118ChargeEnabled'] });
log('ISO 15118 ahora:', (r.config || []).map((k) => k.value).join(''));
r = await c.cmd('setConfig', { key: 'MeterValuesSampledData', value: BASE + ',SoC' });
log('Pedir % (SoC) con ISO 15118 ya activo →', r.status || r.msg);
if (r.status !== 'Accepted') { r = await c.cmd('setConfig', { key: 'MeterValuesSampledData', value: BASE }); log('Datos durante la carga (sin %) →', r.status || r.msg); }
r = await c.cmd('setConfig', { key: 'MeterValuesAlignedData', value: BASE });
log('Datos cada 15 s →', r.status || r.msg);
log('Estado final:', c.state.status);
c.close();
guardar();
process.exit(0);

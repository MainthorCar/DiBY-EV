// Arreglo puntual: la carga del 05/11 18:12 fue de la Kangoo (no de la Jetour).
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const SERVER = 'wss://diby-ev.mainthorcar.workers.dev';
const token = createHash('sha256').update('diby-ev:' + process.env.PANEL_PASSWORD).digest('hex');
const out = [];
const log = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const ws = new WebSocket(`${SERVER}/api/live?token=${token}`);
const waits = new Map();
let state = null, ready;
const isReady = new Promise((r) => { ready = r; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'state') { state = m.state; ready(); } if (m.type === 'reply' && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } };
const cmd = (c, arg) => new Promise((r) => { const id = Math.random().toString(36).slice(2); waits.set(id, r); ws.send(JSON.stringify({ id, cmd: c, arg })); setTimeout(() => r({ ok: false, msg: 'sin respuesta' }), 20000); });
await isReady;
const s = state.session;
log('Última carga:', new Date(s.start).toISOString(), 'auto', s.carId, 'kWh', s.energy.toFixed(2), 'llegó', s.socStart);
if (s.carId === 't1' && Math.abs(s.energy - 21.402) < 0.01) {
  log('Pasar a la Kangoo →', (await cmd('moveSession', 'kangoo')).msg);
  log('Jetour vuelve a lo aprendido en su carga →', (await cmd('setCarLearn', { id: 't1', learn: { n: 1, eff: 0.7932937181663836, last: 1793798557891, prof: { phases: null, kw: 6.8 } } })).msg);
} else log('La última carga no es la esperada: no se toca nada.');
await new Promise((r) => setTimeout(r, 1500));
for (const c of state.cars) log('  ', c.name, c.batteryKWh, c.chem, JSON.stringify(c.learn));
const today = state.days[Object.keys(state.days).sort().pop()];
log('Hoy:', JSON.stringify(today));
log('Cargador:', state.online ? 'en línea' : 'DESCONECTADO', state.status, 'último dato', new Date(state.lastSeen).toISOString());
ws.close();
writeFileSync('diag/experimento.txt', out.join('\n'));
process.exit(0);

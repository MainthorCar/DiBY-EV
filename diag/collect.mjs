// Se conecta a la página en vivo del servidor (solo lectura) y guarda todo lo que llega del cargador.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const SERVER = 'wss://diby-ev.mainthorcar.workers.dev';
const MINUTES = Number(process.env.MINUTES || 5);
const token = createHash('sha256').update('diby-ev:' + process.env.PANEL_PASSWORD).digest('hex');

const msgs = new Map();
const states = [];
let first = null;
const redact = (s) => String(s)
  .replace(/("idTag"\s*:\s*")([^"]+)/g, (_, a, t) => a + 'TAG-' + createHash('sha256').update(t).digest('hex').slice(0, 6))
  .replace(/("tag"\s*:\s*")([^"]+)/g, (_, a, t) => a + 'TAG-' + createHash('sha256').update(t).digest('hex').slice(0, 6));

const ws = new WebSocket(`${SERVER}/api/live?token=${token}`);
ws.onopen = () => console.log('conectado');
ws.onerror = (e) => console.log('error', e.message || e.type);
ws.onclose = (e) => console.log('cerrado', e.code);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type !== 'state') return;
  const st = m.state;
  if (!first) first = st;
  for (const l of st.diag?.log || []) msgs.set(l.t + l.dir + l.m, l);
  states.push({ t: Date.now(), status: st.status, kw: st.kw, phases: st.phases, soc: st.soc, session: st.session, meterTotal: st.meterTotal });
};

setTimeout(() => {
  ws.close();
  const out = {
    capturado: new Date().toISOString(),
    minutos: MINUTES,
    configuracionDelCargador: first?.diag?.cfg || [],
    ajustesPedidos: first?.diag?.cfgSet || {},
    boot: first?.boot || null,
    mensajes: [...msgs.values()].sort((a, b) => a.t - b.t).map((l) => ({ hora: new Date(l.t).toISOString(), dir: l.dir, m: l.m })),
    estados: states.filter((_, i) => i % 3 === 0),
    ultimoEstado: states.length ? { ...first, diag: undefined, series: undefined, days: undefined } : null,
  };
  writeFileSync('diag/datos.json', redact(JSON.stringify(out, null, 1)));
  console.log('mensajes', msgs.size, 'estados', states.length);
  process.exit(0);
}, MINUTES * 60000);

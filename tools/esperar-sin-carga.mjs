// Antes de publicar el servidor: espera a que no haya ninguna carga en curso,
// así la actualización no corta la conexión con el cargador en medio de una carga.
import { createHash } from 'node:crypto';

const SERVER = 'wss://diby-ev.mainthorcar.workers.dev';
const token = createHash('sha256').update('diby-ev:' + (process.env.PANEL_PASSWORD || '')).digest('hex');
const MAX_HOURS = 5;

function estado() {
  return new Promise((res) => {
    let ws;
    const t = setTimeout(() => { try { ws.close(); } catch {} res(null); }, 20000);
    try { ws = new WebSocket(`${SERVER}/api/live?token=${token}`); } catch { clearTimeout(t); return res(null); }
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type !== 'state') return;
      clearTimeout(t); ws.close(); res(m.state);
    };
    ws.onerror = () => { clearTimeout(t); res(null); };
  });
}

const fin = Date.now() + MAX_HOURS * 3600000;
while (Date.now() < fin) {
  const st = await estado();
  if (!st) { console.log('No se pudo leer el estado: se publica igual.'); break; }
  const cargando = st.session && !st.session.closed;
  console.log(new Date().toISOString(), 'estado:', st.status, cargando ? '→ hay una carga en curso, espero 2 min' : '→ sin carga, se publica');
  if (!cargando) break;
  await new Promise((r) => setTimeout(r, 120000));
}

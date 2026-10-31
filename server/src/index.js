// DiBY EV — servidor. Recibe al cargador por OCPP 1.6J y a la página por WebSocket.
import { Charger } from './charger.js';

export { Charger };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const stub = env.CHARGER.get(env.CHARGER.idFromName('main'));
    const isWs = (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

    // El cargador se conecta acá: wss://.../ocpp/<id-del-cargador> (o /ocpp solo)
    if (url.pathname === '/ocpp' || url.pathname.startsWith('/ocpp/')) {
      const note = (result) => ctx.waitUntil(stub.fetch('https://do/attempt', {
        method: 'POST',
        body: JSON.stringify({
          t: Date.now(), path: url.pathname, ws: isWs, result, scheme: url.protocol.replace(':', ''),
          proto: req.headers.get('Sec-WebSocket-Protocol') || '', auth: req.headers.has('Authorization'),
          ua: (req.headers.get('User-Agent') || '').slice(0, 60),
        }),
      }).catch(() => {}));
      if (!isWs) { note('sin WebSocket'); return new Response('OCPP: se espera WebSocket', { status: 426 }); }
      if (env.OCPP_PASSWORD && !checkBasic(req, env.OCPP_PASSWORD)) {
        note('contraseña incorrecta');
        return new Response('No autorizado', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="ocpp"' } });
      }
      note('aceptado');
      return stub.fetch(req);
    }

    // La página pide la clave y recibe un permiso
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (!env.PANEL_PASSWORD || body.password !== env.PANEL_PASSWORD) return json({ ok: false }, 401, cors);
      return json({ ok: true, token: await panelToken(env) }, 200, cors);
    }

    // La página recibe los datos en vivo y manda órdenes por acá
    if (url.pathname === '/api/live') {
      if (url.searchParams.get('token') !== (await panelToken(env))) return new Response('No autorizado', { status: 401 });
      if (!isWs) return new Response('Se espera WebSocket', { status: 426 });
      return stub.fetch(req);
    }

    if (url.pathname === '/') return json({ name: 'DiBY EV', ok: true }, 200, cors);
    return new Response('No encontrado', { status: 404 });
  },
};

function checkBasic(req, password) {
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  try {
    const raw = atob(h.slice(6));
    return raw.slice(raw.indexOf(':') + 1) === password;
  } catch {
    return false;
  }
}

async function panelToken(env) {
  const data = new TextEncoder().encode('diby-ev:' + (env.PANEL_PASSWORD || ''));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = [env.ALLOWED_ORIGIN, 'http://localhost:8765'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

import { CONFIG } from './config.js';
import { SimSource } from './sim.js';
import { RemoteSource, getToken, setToken, login } from './remote.js';

const $ = (id) => document.getElementById(id);
const nf = (n, d = 2) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const hhmm = (ts) => new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
const dur = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const leftTxt = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`);
const hoursTxt = (min) => (min % 60 === 0 ? `${min / 60} h` : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60}`);

const STATUS = {
  Available: ['Disponible', 'idle'],
  Preparing: ['Enchufado', 'wait'],
  Charging: ['Cargando', 'on'],
  SuspendedEV: ['El auto pausó', 'wait'],
  SuspendedEVSE: ['En pausa', 'wait'],
  Finishing: ['Terminó', 'done'],
  Reserved: ['Reservado', 'wait'],
  Unavailable: ['Fuera de servicio', 'off'],
  Faulted: ['Falla', 'fault'],
  Offline: ['Sin conexión', 'off'],
};

const app = document.querySelector('.app');
let source = null; // simulador o servidor real (ver "Arranque" al final)
let S = null;
let range = 'session';
let form = null;

/* ---------- Armado inicial ---------- */

const RING_C = 2 * Math.PI * 94;

const phaseEls = ['L1', 'L2', 'L3'].map((n, i) => {
  const row = document.createElement('div');
  row.className = 'ph';
  row.innerHTML = `<b>${n}</b><div class="ph-bar"><div class="ph-fill" style="background:${['#2BFF88', '#19C8FF', '#A9B8FF'][i]};box-shadow:0 0 10px ${['#2BFF88', '#19C8FF', '#A9B8FF'][i]}"></div></div><span class="num amp-t">—</span><span class="num volt">—</span>`;
  $('phases').appendChild(row);
  return { row, fill: row.querySelector('.ph-fill'), a: row.querySelector('.amp-t'), v: row.querySelector('.volt') };
});

const svg = $('chartSvg');
svg.innerHTML = `
<defs>
  <linearGradient id="cgArea" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2BFF88" stop-opacity=".45"/>
    <stop offset=".6" stop-color="#19C8FF" stop-opacity=".12"/>
    <stop offset="1" stop-color="#19C8FF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="cgLine" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="600" y2="0">
    <stop offset="0" stop-color="#19C8FF"/><stop offset="1" stop-color="#2BFF88"/>
  </linearGradient>
  <filter id="cgGlow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="640" height="340">
    <feGaussianBlur stdDeviation="4" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<g id="cGrid"></g>
<path id="cArea" fill="url(#cgArea)"/>
<path id="cLine" fill="none" stroke="url(#cgLine)" stroke-width="2.5" stroke-linejoin="round" filter="url(#cgGlow)"/>
<path id="cComet" class="comet" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="4 96" filter="url(#cgGlow)"/>
<path id="cProj" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.5" stroke-dasharray="4 6"/>
<line id="cNow" stroke="#2BFF88" stroke-opacity=".35" stroke-width="1"/>
<circle id="cPing" class="ping" r="6" fill="#2BFF88"/>
<circle id="cDot" r="5" fill="#000" stroke="#fff" stroke-width="2.5"/>`;

/* ---------- Datos ---------- */

// (la suscripción a los datos está al final del archivo)

/* ---------- Dibujo ---------- */

function car() { return S.cars.find((c) => c.id === S.carId) || S.cars[0]; }
function activeSession() { return S.session && !S.session.closed ? S.session : null; }

function projection() {
  const s = activeSession();
  if (!s || S.status !== 'Charging' || S.kw < 0.2) return null;
  const sch = S.schedule;
  let remMin;
  if (sch.mode === 'soc') remMin = (((sch.soc - S.soc) / 100) * S.batteryKWh) / S.kw * 60;
  else if (sch.mode === 'energy') remMin = (sch.kwh - s.energy) / S.kw * 60;
  else remMin = sch.minutes - (S.now - s.start) / 60000;
  if (!(remMin > 0)) return null;
  return { end: S.now + remMin * 60000, min: Math.ceil(remMin), kw: S.kw };
}

function targetTxt(sch) {
  if (sch.mode === 'soc') return `${sch.soc} %`;
  if (sch.mode === 'energy') return `${sch.kwh} kWh`;
  return hoursTxt(sch.minutes);
}

function render() {
  if (!S) return;
  renderTop();
  renderNow();
  renderChart();
  renderStats();
  renderProgSummary();
  renderHist();
  renderKeys();
  renderEquip();
}

function renderTop() {
  const c = car();
  const plugged = !!activeSession() || ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'].includes(S.status);
  const col = plugged ? c.color : '#7E9389';
  $('carName').textContent = plugged ? c.name : 'Sin auto enchufado';
  $('carDot').style.background = col;
  $('carDot').style.color = col;
  const key = S.keys.find((k) => k.id === S.keyId);
  $('keyName').textContent = key && activeSession() ? `· llave «${key.name}»` : '';
  const ago = Math.round((Date.now() - S.lastSeen) / 1000);
  $('connText').textContent = S.link === 'down' ? 'Sin conexión con el servidor'
    : !S.online ? 'Cargador desconectado'
    : S.mode === 'sim' ? 'En línea · en vivo'
    : ago < 90 ? 'En línea' : `Último dato hace ${Math.round(ago / 60)} min`;
  const cd = $('connDot');
  cd.style.background = S.online ? '#19C8FF' : '#FF4D6D';
  cd.style.color = S.online ? '#19C8FF' : '#FF4D6D';
  $('clock').textContent = hhmm(Date.now());
}

function renderNow() {
  const [label, kind] = S.reached ? ['Objetivo listo', 'done'] : STATUS[S.status] || [S.status, 'idle'];
  const pill = $('statusPill');
  pill.textContent = label;
  pill.dataset.kind = kind;

  const charging = S.status === 'Charging';
  // El % solo tiene sentido con un auto cargando (o recién terminado)
  const known = !!S.session && (activeSession() || S.status === 'Finishing') && S.soc != null;
  const soc = known ? Math.round(S.soc) : null;
  $('socVal').textContent = known ? soc : '—';
  $('socSub').textContent = known ? 'batería estimada'
    : !S.online ? 'cargador desconectado'
    : S.status === 'Preparing' ? 'auto enchufado'
    : S.status === 'Faulted' ? 'revisar el cargador'
    : 'listo para cargar';
  $('targetVal').textContent = targetTxt(S.schedule);
  $('ringArc').setAttribute('stroke-dasharray', `${known ? ((RING_C * S.soc) / 100).toFixed(1) : 0} ${RING_C.toFixed(1)}`);
  $('ringSvg').setAttribute('aria-label', known ? `Batería estimada ${soc} por ciento` : 'Sin auto cargando');
  const tick = $('ringTick');
  if (S.schedule.mode === 'soc') {
    const th = ((S.schedule.soc / 100) * 360 - 90) * (Math.PI / 180);
    tick.setAttribute('x1', 110 + 81 * Math.cos(th)); tick.setAttribute('y1', 110 + 81 * Math.sin(th));
    tick.setAttribute('x2', 110 + 107 * Math.cos(th)); tick.setAttribute('y2', 110 + 107 * Math.sin(th));
    tick.style.display = '';
  } else tick.style.display = 'none';

  document.querySelector('.ring-wrap').classList.toggle('idle', !charging);
  $('cable').classList.toggle('idle', !charging);
  $('kwVal').textContent = nf(S.kw);

  const p = projection();
  $('etaEnd').textContent = p ? hhmm(p.end) : '—';
  $('etaLeft').textContent = p ? leftTxt(p.min) : '—';

  S.phases.forEach((ph, i) => {
    const el = phaseEls[i];
    const on = ph.a > 0.3;
    el.row.classList.toggle('off', !on);
    el.fill.style.width = `${Math.min(100, (ph.a / 32) * 100)}%`;
    el.a.textContent = `${nf(ph.a, 1)} A`;
    el.v.textContent = ph.v > 1 ? `${Math.round(ph.v)} V` : '— V';
    el.v.classList.toggle('live', ph.v > 1);
  });
}

function niceMax(v) {
  for (const m of [4, 8, 12, 16, 24]) if (v * 1.1 <= m) return m;
  return Math.ceil(v / 8) * 8;
}

function renderChart() {
  const box = svg.getBoundingClientRect();
  const W = Math.max(10, box.width), H = Math.max(10, box.height);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const now = S.now;
  const sess = S.session;
  const proj = projection();
  let t0, t1;
  if (range === '15m') { t0 = now - 15 * 60000; t1 = now; }
  else if (range === '1h') { t0 = now - 60 * 60000; t1 = now; }
  else {
    t0 = sess ? sess.start : now - 60 * 60000;
    t1 = proj ? proj.end : sess && sess.closed ? sess.end : now;
    if (t1 - t0 < 10 * 60000) t1 = t0 + 10 * 60000;
  }
  const pts = S.series.filter((p) => p.t >= t0 - 15000 && p.t <= now);
  const maxKw = niceMax(Math.max(3.6, ...pts.map((p) => p.kw), proj ? proj.kw : 0));
  const pad = 8;
  const X = (t) => ((t - t0) / (t1 - t0)) * W;
  const Y = (k) => pad + (H - pad * 2) * (1 - k / maxKw);

  // Grilla y ejes
  let grid = '';
  const ylab = [];
  for (let i = 0; i <= 4; i++) {
    const k = (maxKw / 4) * i;
    const y = Y(k).toFixed(1);
    grid += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="${i === 0 ? '#1B2B24' : '#0E1A15'}" stroke-width="1"/>`;
    ylab.push(`<span style="top:${y}px">${k}</span>`);
  }
  $('cGrid').innerHTML = grid;
  $('yAxis').innerHTML = ylab.join('');
  const xl = [];
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) / 4) * i;
    const isNow = Math.abs(t - now) < (t1 - t0) / 8;
    xl.push(`<span class="${isNow ? 'now' : ''}">${hhmm(t)}${isNow && range === 'session' && proj ? ' ahora' : ''}</span>`);
  }
  $('xAxis').innerHTML = xl.join('');

  // Curva
  const line = pts.length ? 'M' + pts.map((p) => `${Math.max(0, X(p.t)).toFixed(1)},${Y(p.kw).toFixed(1)}`).join(' L') : '';
  const lastX = X(now), lastY = Y(S.kw);
  const fullLine = line ? `${line} L${lastX.toFixed(1)},${lastY.toFixed(1)}` : '';
  $('cLine').setAttribute('d', fullLine);
  $('cComet').setAttribute('d', fullLine);
  const firstX = pts.length ? Math.max(0, X(pts[0].t)) : 0;
  $('cArea').setAttribute('d', fullLine ? `${fullLine} L${lastX.toFixed(1)},${Y(0)} L${firstX.toFixed(1)},${Y(0)} Z` : '');
  document.getElementById('cgLine').setAttribute('x2', W);
  const f = document.getElementById('cgGlow');
  f.setAttribute('width', W + 40); f.setAttribute('height', H + 40);

  // Proyección hasta el final
  $('cProj').setAttribute('d', proj && range === 'session'
    ? `M${lastX.toFixed(1)},${Y(proj.kw).toFixed(1)} L${X(proj.end).toFixed(1)},${Y(proj.kw).toFixed(1)} L${X(proj.end).toFixed(1)},${Y(0)}` : '');

  // Punto "ahora"
  const nowLine = $('cNow');
  nowLine.setAttribute('x1', lastX); nowLine.setAttribute('x2', lastX);
  nowLine.setAttribute('y1', pad); nowLine.setAttribute('y2', Y(0));
  ['cPing', 'cDot'].forEach((id) => { $(id).setAttribute('cx', lastX); $(id).setAttribute('cy', lastY); });
  svg.classList.toggle('paused', S.status !== 'Charging');
}

function renderStats() {
  const s = S.session;
  if (!s) { ['stEnergy', 'stDur', 'stBatt', 'stCost'].forEach((id) => { $(id).textContent = '—'; }); return; }
  $('stEnergy').innerHTML = `${nf(s.energy)} <small>kWh</small>`;
  $('stDur').textContent = dur((s.closed ? s.end : S.now) - s.start);
  $('stBatt').innerHTML = `${s.socStart} → ${Math.round(S.soc)} <small>%</small>`;
  $('stCostLbl').title = `A $${S.tariff} por kWh`;
  $('stCost').textContent = `$ ${Math.round(s.energy * S.tariff).toLocaleString('es-AR')}`;
}

function renderProgSummary() {
  const sch = S.schedule;
  const start = sch.startMode === 'at' ? ` · desde <i>${sch.startAt}</i>` : ' · al enchufar';
  const what = sch.mode === 'time' ? 'Durante' : 'Hasta';
  $('progSum').innerHTML = `${what} <b>${targetTxt(sch)}</b>${start}`;
}

let histSig = '';
function renderHist() {
  const sig = JSON.stringify(S.history.map((d) => Object.values(d.kwh).map((v) => v.toFixed(1))));
  if (sig === histSig) return;
  histSig = sig;
  const totals = S.history.map((d) => Object.values(d.kwh).reduce((a, b) => a + b, 0));
  const max = Math.max(10, ...totals);
  $('weekTotal').textContent = `${nf(totals.reduce((a, b) => a + b, 0), 0)} kWh`;
  $('bars').innerHTML = S.history.map((d, i) => {
    const segs = S.cars.map((c) => {
      const v = d.kwh[c.id] || 0;
      if (v <= 0) return '';
      return `<div class="s" style="height:${((v / max) * 100).toFixed(1)}%;background:${c.color};box-shadow:0 0 10px ${c.color}" title="${c.name}: ${nf(v, 1)} kWh"></div>`;
    }).reverse().join('');
    return `<div class="bar${d.today ? ' today' : ''}"><span class="tot">${nf(totals[i], 0)}</span><div class="stack">${segs}</div><span class="lb">${d.label}</span></div>`;
  }).join('');
  $('legend').innerHTML = S.cars.map((c) => `<span><i style="background:${c.color};box-shadow:0 0 8px ${c.color}"></i>${c.name}</span>`).join('');
}

let keySig = '';
function renderKeys() {
  const live = activeSession() ? S.keyId : null;
  const sig = JSON.stringify([S.keys, live]);
  if (sig === keySig) return;
  keySig = sig;
  $('keyList').innerHTML = S.keys.map((k) => {
    const c = S.cars.find((x) => x.id === k.carId) || { name: 'Sin auto', color: '#7E9389' };
    const on = k.id === live;
    return `<div class="key${on ? ' active' : ''}"><span class="kd" style="background:${c.color};box-shadow:0 0 10px ${c.color}"></span><span><span class="kn">${esc(k.name)}</span><span class="kc">${esc(c.name)}</span></span><span class="kl">${on ? 'en uso' : esc(k.last)}</span></div>`;
  }).join('');
}

function attemptRow() {
  const a = S.attempts && S.attempts[0];
  if (!a) return '<dt>Intentos</dt><dd class="bad">El cargador no llamó</dd>';
  const det = `${a.scheme} ${a.path} · protocolo «${a.proto || 'ninguno'}» · ${a.ua || 'sin nombre'}`;
  return `<dt>Último intento</dt><dd class="${a.result === 'aceptado' ? 'ok' : 'bad'}" title="${esc(det)}">${hhmm(a.t)} · ${esc(a.result)}</dd>`;
}

function renderEquip() {
  const total = S.meterTotal + (activeSession() ? S.session.energy : 0);
  const conn = S.mode === 'sim' ? 'Simulación' : `OCPP 1.6J${S.boot && S.boot.fw ? ' · fw ' + S.boot.fw : ''}`;
  const faults = S.faults.length ? S.faults.join(', ') : 'Ninguna';
  const tag = S.tags && S.tags[0];
  $('equipInfo').innerHTML = `
    <dt>Conexión</dt><dd>${S.online ? esc(conn) : 'Sin conexión'}</dd>
    ${!S.online && S.mode === 'live' ? attemptRow() : ''}
    <dt>Conector</dt><dd>${esc(S.connector)}</dd>
    <dt>Fallas</dt><dd class="${S.faults.length ? 'bad' : 'ok'}">${esc(faults)}</dd>
    <dt>Medidor total</dt><dd class="mono">${nf(total, 1)} kWh</dd>
    ${tag ? `<dt>Última llave leída</dt><dd class="mono" title="${esc(tag.tag)}">…${esc(String(tag.tag).slice(-6))} · ${hhmm(tag.t)}</dd>` : ''}
    <dt>Versión</dt><dd class="mono">${CONFIG.version}</dd>`;
  const st = S.status;
  const t = $('btnToggle');
  t.textContent = st === 'Charging' ? 'Pausar' : st.startsWith('Suspended') ? 'Reanudar' : 'Iniciar';
  t.disabled = !S.online || ['Unavailable', 'Faulted', 'Offline', 'Available'].includes(st);
  $('btnStop').disabled = !S.online || !activeSession();
  $('btnUnlock').disabled = !S.online;
  $('btnReset').disabled = !S.online;
}

/* ---------- Programación ---------- */

function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

function renderForm() {
  document.querySelectorAll('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === form.mode)));
  document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('on', m.dataset.mode === form.mode));
  const pairs = [['socRange', 'soc', 'socOut', (v) => `${v} %`, 'socChips'], ['timeRange', 'minutes', 'timeOut', hoursTxt, 'timeChips'], ['kwhRange', 'kwh', 'kwhOut', (v) => `${v} kWh`, 'kwhChips']];
  for (const [inp, key, out, fmt, chips] of pairs) {
    $(inp).value = form[key];
    setRangeFill($(inp));
    $(out).textContent = fmt(form[key]);
    document.querySelectorAll(`#${chips} .chip`).forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.v) === Number(form[key]))));
  }
  document.querySelectorAll('[data-start]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.start === form.startMode)));
  $('startAt').value = form.startAt;
  $('startAt').disabled = form.startMode !== 'at';
  $('ampRange').value = form.limitA;
  setRangeFill($('ampRange'));
  $('ampOut').textContent = `${form.limitA} A`;
}

document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => { form.mode = b.dataset.mode; renderForm(); }));
[['socRange', 'soc', 'socChips'], ['timeRange', 'minutes', 'timeChips'], ['kwhRange', 'kwh', 'kwhChips']].forEach(([inp, key, chips]) => {
  $(inp).addEventListener('input', (e) => { form[key] = Number(e.target.value); renderForm(); });
  document.querySelectorAll(`#${chips} .chip`).forEach((c) => c.addEventListener('click', () => { form[key] = Number(c.dataset.v); renderForm(); }));
});
document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => { form.startMode = b.dataset.start; renderForm(); }));
$('startAt').addEventListener('change', (e) => { form.startAt = e.target.value || '23:00'; });
$('ampRange').addEventListener('input', (e) => { form.limitA = Number(e.target.value); renderForm(); });
$('saveProg').addEventListener('click', () => run('setSchedule', { ...form }));

/* ---------- Controles ---------- */

$('btnToggle').addEventListener('click', () => run('toggle'));
$('btnStop').addEventListener('click', () => { if (confirm('¿Detener la carga?')) run('stop'); });
$('btnUnlock').addEventListener('click', () => run('unlock'));
$('btnReset').addEventListener('click', () => { if (confirm('¿Reiniciar el cargador? Tarda unos segundos.')) run('reset'); });

document.querySelectorAll('#rangeSeg button').forEach((b) => b.addEventListener('click', () => {
  range = b.dataset.range;
  document.querySelectorAll('#rangeSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderChart();
}));

$('addKey').addEventListener('click', async () => {
  const card = document.querySelector('.c-keys');
  card.classList.add('learning');
  $('addKey').disabled = true;
  $('keyHint').textContent = 'Apoyá la llave en el cargador… (tenés 1 minuto)';
  await run('learnKey');
  card.classList.remove('learning');
  $('addKey').disabled = false;
  $('keyHint').textContent = 'Para sumar una llave: tocá «Agregar» y apoyala en el cargador.';
});

/* ---------- Auto ---------- */

$('carChip').addEventListener('click', () => {
  $('carList').innerHTML = S.cars.map((c) => `<button type="button" data-car="${c.id}" aria-pressed="${c.id === S.carId}"><span class="dot" style="background:${c.color};color:${c.color}"></span>${esc(c.name)}</button>`).join('');
  $('carList').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { run('setCar', b.dataset.car); $('carDialog').close(); }));
  $('carDialog').showModal();
});
$('carClose').addEventListener('click', () => $('carDialog').close());

/* ---------- Pestañas (celular) ---------- */

document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
  app.dataset.tab = b.dataset.go;
  document.querySelectorAll('.tabbar button').forEach((x) => x.toggleAttribute('aria-current', x.dataset.go === b.dataset.go));
  document.querySelectorAll('.tabbar button[aria-current]').forEach((x) => x.setAttribute('aria-current', 'page'));
  requestAnimationFrame(() => S && renderChart());
}));

/* ---------- Utilidades ---------- */

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function run(name, arg) {
  if (!source) return null;
  try {
    const r = await source.command(name, arg);
    if (r && r.msg) toast(r.msg, !r.ok);
    return r;
  } catch (e) {
    toast('No se pudo: ' + e.message, true);
    return null;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Corregir el % de batería (tocando el anillo) ---------- */

document.querySelector('.ring-wrap').addEventListener('click', () => {
  if (!S) return;
  const v = prompt('¿Qué % de batería marca el auto ahora?', Math.round(S.soc));
  if (v === null) return;
  const n = Number(String(v).replace(',', '.'));
  if (Number.isFinite(n) && n >= 0 && n <= 100) run('setSoc', n);
});

/* ---------- Arranque ---------- */

let diagBox = null;
function renderDiag() {
  if (!diagBox) return;
  const d = S.diag || {};
  const lines = [
    `Intentos: ${(S.attempts || []).map((a) => `${hhmm(a.t)} ${a.result} ${a.scheme} ${a.path} «${a.proto}»`).join(' | ') || '—'}`,
    `Ajustes pedidos: ${JSON.stringify(d.cfgSet || {})}`,
    `Mensajes (último primero):`,
    ...(d.log || []).map((l) => `${new Date(l.t).toLocaleTimeString('es-AR')} ${l.dir} ${l.m}`),
    `Configuración del cargador:`,
    ...(d.cfg || []).map(([k, v]) => `  ${k} = ${v}`),
  ];
  diagBox.textContent = lines.join('\n');
}

function start(src) {
  source = src;
  if (new URLSearchParams(location.search).has('diag') && !diagBox) {
    diagBox = document.createElement('pre');
    diagBox.className = 'diag';
    document.body.appendChild(diagBox);
  }
  source.subscribe((st) => {
    S = st;
    if (!form) { form = { ...st.schedule }; renderForm(); }
    document.querySelector('.c-keys').classList.toggle('learning', !!S.learning || $('addKey').disabled);
    render();
    renderDiag();
  });
}

function askLogin() {
  setToken(null);
  $('loginErr').hidden = true;
  if (!$('loginDlg').open) $('loginDlg').showModal();
  $('loginPass').focus();
}

$('loginDlg').addEventListener('cancel', (e) => e.preventDefault());
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await login(CONFIG.server, $('loginPass').value).catch(() => false);
  if (!ok) { $('loginErr').hidden = false; return; }
  $('loginDlg').close();
  start(new RemoteSource(CONFIG, askLogin));
});

const params = new URLSearchParams(location.search);
if (params.get('servidor')) CONFIG.server = params.get('servidor').replace(/\/$/, '');
const demo = !CONFIG.server || params.has('demo');
$('demoTag').hidden = !demo;
if (demo) start(new SimSource(CONFIG));
else if (getToken()) start(new RemoteSource(CONFIG, askLogin));
else askLogin();

window.addEventListener('resize', () => S && renderChart());

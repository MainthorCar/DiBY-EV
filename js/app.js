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
let source = null;
// Dentro de la app Android: cada teléfono tiene su llave fija
const APP = window.DiBYApp || null;
const DEV = APP ? APP.deviceId() : null;
if (APP) document.body.classList.add('in-app');
function myKey() { return DEV && S ? S.keys.find((k) => k.dev === DEV) : null; } // simulador o servidor real (ver "Arranque" al final)
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

const NOCAR = { id: '_', name: 'Sin asignar', color: '#7E9389' };
function car() {
  const id = activeSession() ? S.session.carId : S.carId;
  return S.cars.find((c) => c.id === id) || null;
}
function carById(id) { return S.cars.find((c) => c.id === id) || NOCAR; }
function activeSession() { return S.session && !S.session.closed ? S.session : null; }

function projection() {
  const s = activeSession();
  if (!s || S.status !== 'Charging' || S.kw < 0.2) return null;
  // Lo calcula el servidor con la batería del auto y la caída final de potencia
  if (s.etaMin != null && s.etaMin > 0) return { end: S.now + s.etaMin * 60000, min: s.etaMin, kw: S.kw };
  const sch = S.schedule;
  if (!sch.enabled) return null;
  if (sch.mode === 'soc' && (S.soc == null || !S.batteryKWh)) return null;
  let remMin;
  if (sch.mode === 'soc') remMin = (((sch.soc - S.soc) / 100) * S.batteryKWh) / S.kw * 60;
  else if (sch.mode === 'energy') remMin = (sch.kwh - s.energy) / S.kw * 60;
  else remMin = sch.minutes - (S.now - s.start) / 60000;
  if (!(remMin > 0)) return null;
  return { end: S.now + remMin * 60000, min: Math.ceil(remMin), kw: S.kw };
}

function targetTxt(sch) {
  if (!sch.enabled) return 'carga libre';
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
  const ss = activeSession();
  const cl = ss && ss.client;
  const plugged = !!ss || ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'].includes(S.status);
  const col = cl ? '#FFB020' : plugged && c ? c.color : '#7E9389';
  $('carName').textContent = cl ? 'Cliente: ' + cl.name : !plugged ? 'Sin auto enchufado' : c ? c.name : 'Auto sin asignar';
  $('carChip').classList.toggle('client', !!cl);
  $('carDot').style.background = col;
  $('carDot').style.color = col;
  const kn = ss && !cl ? (ss.keyName || (S.keys.find((k) => k.id === S.keyId) || {}).name) : null;
  $('keyName').textContent = kn ? `· llave «${kn}»` : '';
  const ago = Math.round((Date.now() - S.lastSeen) / 1000);
  $('connText').textContent = S.link === 'down' ? 'Sin conexión con el servidor'
    : !S.online ? 'Cargador desconectado'
    : S.mode === 'sim' ? 'En línea · en vivo'
    : ago < 90 ? 'En línea' : `Último dato hace ${Math.round(ago / 60)} min`;
  const cd = $('connDot');
  cd.style.background = S.online ? '#19C8FF' : '#FF4D6D';
  cd.style.color = S.online ? '#19C8FF' : '#FF4D6D';
  $('clock').textContent = hhmm(Date.now());
  const w = S.weather;
  $('temp').hidden = !(w && Date.now() - w.at < 2 * 3600000);
  if (w) $('temp').textContent = `${Math.round(w.t)}°`;
}

function renderNow() {
  const [label, kind] = S.pendingStart ? ['Esperando el auto', 'wait'] : S.reached ? ['Objetivo listo', 'done'] : STATUS[S.status] || [S.status, 'idle'];
  const pill = $('statusPill');
  pill.textContent = label;
  pill.dataset.kind = kind;

  const charging = S.status === 'Charging';
  const ss = activeSession() || (S.session && S.status === 'Finishing' ? S.session : null);
  const cl = ss && ss.client;
  $('bigKwh').textContent = ss ? nf(ss.energy, 2) : '—';
  $('eLbl').textContent = ss ? 'CARGADO' : !S.online ? 'DESCONECTADO' : S.status === 'Preparing' ? 'AUTO ENCHUFADO' : 'LISTO PARA CARGAR';
  $('eUnit').textContent = ss ? 'kWh' : '';
  const en = $('energy');
  en.classList.toggle('idle', !charging);
  // El anillo gira más rápido cuanta más potencia entra (2 s a 22 kW, 10 s casi sin potencia)
  en.style.setProperty('--spd', `${Math.max(2, 10 - (S.kw / 22) * 8).toFixed(1)}s`);
  $('kwVal').textContent = nf(S.kw);
  $('nowDur').textContent = ss ? dur((ss.closed ? ss.end : S.now) - ss.start) : '—';
  const tariff = ss ? ss.tariff ?? S.tariff : null;
  $('nowCostLbl').textContent = cl ? 'A cobrar' : 'Gastado';
  $('nowCostBox').classList.toggle('client', !!cl);
  $('nowCost').textContent = ss && tariff != null ? pesos(ss.energy * tariff) : '—';
  // Hoy y el mes (de la empresa)
  const now = new Date();
  const dk = dkey(now), mk = dk.slice(0, 7);
  let dK = 0, dM = 0, mM = 0;
  for (const [k, v] of Object.entries(S.days || {})) {
    const m = sumDay(v);
    if (k === dk) { dK = m.kwh; dM = m.cost; }
    if (k.startsWith(mk)) mM += m.cost;
  }
  $('nowSum').innerHTML = `<span>Hoy <b>${nf(dK, 1)} kWh · ${pesos(dM)}</b></span><span>${MONTHS[now.getMonth()]} <b>${pesos(mM)}</b></span>`;

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
  const tariff = s.tariff ?? S.tariff;
  $('stBatt').innerHTML = tariff != null ? `${pesos(tariff)} <small>/kWh</small>` : '—';
  $('stCostLbl').title = tariff != null ? `A $${tariff} por kWh` : 'Cargá el precio del kWh en Ajustes';
  $('stCost').textContent = tariff != null ? pesos(s.energy * tariff) : '—';
}

function renderProgSummary() {
  const sch = S.schedule;
  if (!sch.enabled) { $('progSum').innerHTML = '<b>Carga libre</b> · corta el auto'; return; }
  const start = sch.startMode === 'at' ? ` · desde <i>${sch.startAt}</i>` : ' · al enchufar';
  const what = sch.mode === 'time' ? 'Durante' : 'Hasta';
  $('progSum').innerHTML = `${what} <b>${targetTxt(sch)}</b>${start}`;
}

let histSig = '';
let histMode = 'month';
let monthOff = 0;
let yearOff = 0;
const DNAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const pesos = (n) => '$ ' + Math.round(n).toLocaleString('es-AR');
function dkey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Totales de un día guardado: { autoId: kWh, '$autoId': pesos, '#autoId': cargas }
function sumDay(v) {
  let kwh = 0, cost = 0, n = 0;
  for (const [k, x] of Object.entries(v || {})) {
    if (k[0] === '$') cost += x; else if (k[0] === '#') n += x; else kwh += x;
  }
  return { kwh, cost, n };
}
function carInfo(id) {
  const c = S.cars.find((x) => x.id === id);
  const key = S.keys.find((k) => k.carId === id);
  return { name: c ? c.name : 'Sin auto', color: c ? c.color : '#7E9389', key: key ? key.name : '' };
}

function renderHist() {
  const sig = JSON.stringify([S.days, S.charges && S.charges.length && S.charges[0], S.cars, S.keys.length, histMode, monthOff, yearOff, new Date().getDate()]);
  if (sig === histSig) return;
  histSig = sig;
  const days = S.days || {};
  const now = new Date();
  const yr = now.getFullYear() + yearOff;
  const m = new Date(now.getFullYear(), now.getMonth() + monthOff, 1);
  const pre = histMode === 'month' ? `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}` : String(yr);
  $('mLabel').textContent = histMode === 'month' ? `${MONTHS[m.getMonth()]} ${m.getFullYear()}` : `Año ${yr}`;
  $('mNext').disabled = histMode === 'month' ? monthOff >= 0 : yearOff >= 0;

  // Totales del período y por auto
  const per = {};
  let kwh = 0, cost = 0, n = 0;
  for (const [k, v] of Object.entries(days)) {
    if (!k.startsWith(pre)) continue;
    for (const [a, x] of Object.entries(v)) {
      const id = a[0] === '$' || a[0] === '#' ? a.slice(1) : a;
      const t = per[id] || (per[id] = { kwh: 0, cost: 0, n: 0 });
      if (a[0] === '$') { t.cost += x; cost += x; } else if (a[0] === '#') { t.n += x; n += x; } else { t.kwh += x; kwh += x; }
    }
  }
  $('gMoney').textContent = pesos(cost);
  $('gKwh').innerHTML = `${nf(kwh, 1)} <small>kWh</small>`;
  $('gN').textContent = String(n);
  $('gCars').innerHTML = Object.entries(per).filter(([, t]) => t.kwh > 0.05).sort((a, b) => b[1].cost - a[1].cost).map(([id, t]) => {
    const c = carInfo(id);
    return `<div class="g-car"><span title="${esc(c.name)}${c.key ? ' · ' + esc(c.key) : ''}"><i style="background:${c.color};box-shadow:0 0 8px ${c.color}"></i>${esc(c.name)}</span><b>${nf(t.kwh, 1)} kWh · <em>${pesos(t.cost)}</em></b></div>`;
  }).join('') || '<div class="g-car"><span>Sin cargas en este período</span></div>';
  // Acumulado del año (en la vista de mes)
  if (histMode === 'month') {
    let yk = 0, yc = 0;
    for (const [k, v] of Object.entries(days)) if (k.startsWith(String(m.getFullYear()))) { const t = sumDay(v); yk += t.kwh; yc += t.cost; }
    $('gYear').innerHTML = `<span>Acumulado ${m.getFullYear()}</span><b>${nf(yk, 1)} kWh · ${pesos(yc)}</b>`;
    $('gYear').hidden = false;
  } else $('gYear').hidden = true;

  // Tabla
  const head = `<div class="g-row head"><span>${histMode === 'month' ? 'FECHA' : 'MES'}</span><span>${histMode === 'month' ? 'AUTO' : 'CARGAS'}</span><span class="n">kWh</span><span class="m">$</span></div>`;
  const rows = [];
  if (histMode === 'month') {
    const charges = (S.charges || []).filter((c) => !c.client);
    const keys = Object.keys(days).filter((k) => k.startsWith(pre)).sort().reverse();
    keys.forEach((k, i) => {
      const v = days[k];
      const tot = sumDay(v);
      if (tot.kwh < 0.05) return;
      const dt = new Date(k + 'T12:00:00');
      const label = `${DNAMES[dt.getDay()]} ${k.slice(8, 10)}/${k.slice(5, 7)}`;
      const alt = rows.length % 2 ? ' alt' : '';
      // Con registro de cada carga (desde ahora): una fila por carga con la hora
      const dayCh = charges.filter((c) => dkey(new Date(c.start)) === k);
      const lines = [];
      const cars = Object.keys(v).filter((a) => a[0] !== '$' && a[0] !== '#' && v[a] > 0.05);
      const covered = new Set();
      dayCh.slice().reverse().forEach((c) => {
        const ci = carInfo(c.carId || '_');
        covered.add(c.carId || '_');
        lines.push({ c: esc(c.car || ci.name), t: c.key ? 'Llave: ' + c.key : '', h: `${hhmm(c.start)}–${hhmm(c.end)}`, color: ci.color, kwh: c.kwh, cost: c.cost || 0 });
      });
      // Días o autos sin registro detallado: total del auto en el día
      cars.filter((a) => !covered.has(a)).forEach((a) => {
        const ci = carInfo(a);
        const cnt = v['#' + a] || 0;
        lines.push({ c: `${esc(ci.name)}${cnt > 1 ? ` (${cnt})` : ''}`, t: ci.key ? 'Llave: ' + ci.key : '', h: '', color: ci.color, kwh: v[a], cost: v['$' + a] || 0 });
      });
      lines.forEach((l, j) => rows.push(`<div class="g-row${alt}${j ? ' sub' : ''}"><span class="d">${j ? '' : label}${l.h ? `<small>${l.h}</small>` : ''}</span><span class="c" title="${esc(l.t || '')}"><i style="background:${l.color};box-shadow:0 0 6px ${l.color}"></i>${l.c}</span><span class="n">${nf(l.kwh, 1)}</span><span class="m">${pesos(l.cost)}</span></div>`));
      if (lines.length > 1) rows.push(`<div class="g-row sub tot${alt}"><span class="d"></span><span class="c">Total del día</span><span class="n">${nf(tot.kwh, 1)}</span><span class="m">${pesos(tot.cost)}</span></div>`);
    });
  } else {
    for (let mo = 11; mo >= 0; mo--) {
      const mp = `${yr}-${String(mo + 1).padStart(2, '0')}`;
      let k2 = 0, c2 = 0, n2 = 0;
      for (const [k, v] of Object.entries(days)) if (k.startsWith(mp)) { const t = sumDay(v); k2 += t.kwh; c2 += t.cost; n2 += t.n; }
      if (k2 < 0.05) continue;
      rows.push(`<div class="g-row${rows.length % 2 ? ' alt' : ''}"><span class="d">${MONTHS[mo]}</span><span class="c">${n2} ${n2 === 1 ? 'carga' : 'cargas'}</span><span class="n">${nf(k2, 1)}</span><span class="m">${pesos(c2)}</span></div>`);
    }
  }
  $('gTableTitle').textContent = histMode === 'month' ? 'Saldo diario' : 'Mes por mes';
  $('gTable').innerHTML = head + (rows.join('') || '<div class="g-empty">Sin cargas en este período.</div>');
}

document.querySelectorAll('#histSeg button').forEach((b) => b.addEventListener('click', () => {
  histMode = b.dataset.h;
  monthOff = 0; yearOff = 0;
  document.querySelectorAll('#histSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (S) renderHist();
}));
$('mPrev').addEventListener('click', () => { if (histMode === 'month') monthOff--; else yearOff--; if (S) renderHist(); });
$('mNext').addEventListener('click', () => { if (histMode === 'month') { if (monthOff < 0) monthOff++; } else if (yearOff < 0) yearOff++; if (S) renderHist(); });

let keySig = '';
function renderKeys() {
  const live = activeSession() ? S.keyId : null;
  const sig = JSON.stringify([S.keys, live, S.cars, DEV]);
  if (sig === keySig) return;
  keySig = sig;
  const regBtn = DEV && !myKey()
    ? '<button type="button" class="reg-phone" id="regPhone"><b>Registrar este teléfono como llave</b><span>Después iniciás las cargas desde acá, sin apoyar nada.</span></button>' : '';
  if (!S.keys.length) {
    $('keyList').innerHTML = regBtn + '<p class="empty">Todavía no hay llaves.<br>Tocá <b>«+ Agregar llave»</b> y apoyá la tarjeta, el llavero o el teléfono en el cargador.</p>';
    return;
  }
  $('keyList').innerHTML = S.keys.map((k) => {
    const c = S.cars.find((x) => x.id === k.carId) || { name: 'Sin auto asignado', color: '#7E9389' };
    const on = k.id === live;
    const mine = DEV && k.dev === DEV ? ' <span class="mine">este teléfono</span>' : '';
    return `<button type="button" class="key${on ? ' active' : ''}" data-key="${k.id}" title="Tocá para editar"><span class="kd" style="background:${c.color};box-shadow:0 0 10px ${c.color}"></span><span><span class="kn">${esc(k.name)}${mine}</span><span class="kc">${esc(c.name)}</span></span><span class="kl">${on ? 'en uso' : esc(k.last)}</span></button>`;
  }).join('');
  if (regBtn) $('keyList').insertAdjacentHTML('afterbegin', regBtn);
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
  t.textContent = S.pendingStart ? 'Cancelar' : st === 'Charging' ? 'Pausar' : st.startsWith('Suspended') ? 'Reanudar' : myKey() ? 'Cargar' : 'Iniciar';
  t.disabled = !S.online || (!S.pendingStart && ['Unavailable', 'Faulted', 'Offline'].includes(st));
  t.classList.toggle('warn', !!S.pendingStart);
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
  $('progOn').checked = !!form.enabled;
  $('progOnTxt').textContent = form.enabled ? 'Activada' : 'Carga libre';
  document.querySelector('.c-prog').classList.toggle('off', !form.enabled);
  document.querySelectorAll('.c-prog .mode input, .c-prog .mode button, .c-prog .field input, .c-prog .field button, #modeSeg button, #saveProg')
    .forEach((el) => { el.disabled = !form.enabled || (el.id === 'startAt' && form.startMode !== 'at'); });
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
$('progOn').addEventListener('change', (e) => {
  form.enabled = e.target.checked;
  renderForm();
  run('setSchedule', { ...form });
});

/* ---------- Controles ---------- */

$('btnToggle').addEventListener('click', () => {
  if (S && S.pendingStart) { run('cancelStart'); return; }
  const st = S ? S.status : '';
  const starting = !activeSession() && !['Charging', 'SuspendedEV', 'SuspendedEVSE'].includes(st);
  if (!starting) { run('toggle'); return; }
  const k = myKey();
  if (k) { run('toggle', { keyId: k.id }); return; }
  openStartDlg();
});

function openStartDlg() {
  const keys = S.keys.filter((k) => !k.dev || k.dev === DEV);
  if (!keys.length) { toast('Primero registrá una llave', true); return; }
  if (keys.length === 1) { run('toggle', { keyId: keys[0].id }); return; }
  $('startKeys').innerHTML = keys.map((k) => {
    const c = S.cars.find((x) => x.id === k.carId);
    return `<button type="button" data-key="${k.id}"><span class="dot" style="background:${c ? c.color : '#7E9389'};color:${c ? c.color : '#7E9389'}"></span><span>${esc(k.name)}<small>${c ? esc(c.name) : 'Sin auto asignado'}</small></span></button>`;
  }).join('');
  $('startDlg').showModal();
}
$('startKeys').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (!b) return;
  $('startDlg').close();
  run('toggle', { keyId: b.dataset.key });
});
$('startCancel').addEventListener('click', () => $('startDlg').close());
$('keyList').addEventListener('click', async (e) => {
  if (!e.target.closest('#regPhone')) return;
  const r = await run('registerApp', { dev: DEV, name: 'Teléfono ' + (APP.deviceName() || '') });
  if (r && r.ok && r.keyId) setTimeout(() => openKey(r.keyId, true), 300);
});

// Botón "atrás" del teléfono: cierra lo abierto antes de salir de la app
window.diBYBack = () => {
  const dlg = [...document.querySelectorAll('dialog')].find((d) => d.open && d.id !== 'loginDlg');
  if (dlg) { dlg.close(); return true; }
  if (!$('settings').hidden) { $('settings').hidden = true; return true; }
  if (app.dataset.tab !== 'now') { document.querySelector('.tabbar [data-go=now]').click(); return true; }
  return false;
};
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
  const r = await run('learnKey');
  card.classList.remove('learning');
  if (r && r.ok && r.keyId) openKey(r.keyId, true);
  $('addKey').disabled = false;
  $('keyHint').textContent = 'Para sumar una llave: tocá «Agregar» y apoyala en el cargador.';
});

/* ---------- Auto ---------- */

function openCarList() {
  const cur = car();
  const rows = S.cars.map((c) => `<div class="car-row"><button type="button" class="car-pick" data-car="${c.id}" aria-pressed="${!!cur && c.id === cur.id}"><span class="dot" style="background:${c.color};color:${c.color}"></span><span>${esc(c.name)}<small>${c.batteryKWh ? nf(c.batteryKWh, 1) + ' kWh' : 'batería sin cargar'}</small></span></button><button type="button" class="car-edit" data-edit="${c.id}" aria-label="Editar ${esc(c.name)}">Editar</button></div>`);
  rows.push(`<div class="car-row"><button type="button" class="car-pick" data-car="" aria-pressed="${!cur}"><span class="dot" style="background:#7E9389;color:#7E9389"></span><span>Sin asignar</span></button></div>`);
  $('carList').innerHTML = rows.join('');
  $('carList').querySelectorAll('.car-pick').forEach((b) => b.addEventListener('click', () => { run('setCar', b.dataset.car || null); $('carDialog').close(); }));
  $('carList').querySelectorAll('.car-edit').forEach((b) => b.addEventListener('click', () => { $('carDialog').close(); openCarForm(b.dataset.edit); }));
  if (!$('carDialog').open) $('carDialog').showModal();
}
$('carChip').addEventListener('click', () => S && openCarList());
$('carClose').addEventListener('click', () => $('carDialog').close());
$('carNew').addEventListener('click', () => { $('carDialog').close(); openCarForm(null); });

/* ---------- Editar auto ---------- */

let editingCar = null;
function openCarForm(id) {
  editingCar = id;
  const c = S.cars.find((x) => x.id === id);
  $('carFormTitle').textContent = c ? 'Editar auto' : 'Nuevo auto';
  $('carNameIn').value = c ? c.name : '';
  $('carBatIn').value = c && c.batteryKWh ? c.batteryKWh : '';
  $('carChemIn').value = c && c.chem === 'NMC' ? 'NMC' : 'LFP';
  $('carLearn').textContent = learnTxt(c);
  $('carDel').hidden = !c;
  $('carFormDlg').showModal();
  $('carNameIn').focus();
}
$('carForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await run('saveCar', { id: editingCar, name: $('carNameIn').value, batteryKWh: String($('carBatIn').value), chem: $('carChemIn').value });
  if (r && r.ok) $('carFormDlg').close();
});
$('carDel').addEventListener('click', async () => {
  if (!confirm('¿Borrar este auto? Sus llaves quedan sin auto asignado.')) return;
  const r = await run('deleteCar', editingCar);
  if (r && r.ok) $('carFormDlg').close();
});
$('carFormClose').addEventListener('click', () => $('carFormDlg').close());

/* ---------- Editar llave ---------- */

let editingKey = null;
function openKey(id, isNew = false) {
  const k = S.keys.find((x) => x.id === id);
  if (!k) return;
  editingKey = id;
  $('keyDlgTitle').textContent = isNew ? '¡Llave nueva! Ponele nombre' : 'Editar llave';
  $('keyNameIn').value = isNew ? '' : k.name;
  $('keyNameIn').placeholder = k.name;
  const opts = S.cars.map((c) => `<option value="${c.id}"${c.id === k.carId ? ' selected' : ''}>${esc(c.name)}</option>`);
  opts.push(`<option value=""${!k.carId ? ' selected' : ''}>Sin auto asignado</option>`);
  opts.push('<option value="__new">+ Nuevo auto…</option>');
  $('keyCarSel').innerHTML = opts.join('');
  if (isNew && !S.cars.length) $('keyCarSel').value = '__new';
  $('keyNewCar').hidden = $('keyCarSel').value !== '__new';
  $('keyNewCarName').value = '';
  $('keyNewCarBat').value = '';
  $('keyDel').hidden = isNew;
  if (!$('keyDlg').open) $('keyDlg').showModal();
  $('keyNameIn').focus();
}
$('keyList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (b) openKey(b.dataset.key);
});
$('keyCarSel').addEventListener('change', () => { $('keyNewCar').hidden = $('keyCarSel').value !== '__new'; });
$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let carId = $('keyCarSel').value || null;
  if (carId === '__new') {
    const name = $('keyNewCarName').value.trim();
    if (!name) { toast('Poné el nombre del auto nuevo', true); $('keyNewCarName').focus(); return; }
    const r = await run('saveCar', { name, batteryKWh: String($('keyNewCarBat').value), chem: $('keyNewCarChem').value });
    if (!r || !r.ok) return;
    carId = r.carId;
  }
  const name = $('keyNameIn').value.trim() || $('keyNameIn').placeholder;
  const r = await run('editKey', { id: editingKey, name, carId });
  if (r && r.ok) {
    $('keyDlg').close();
    if (activeSession() && S.keyId === editingKey) run('setCar', carId);
  }
});
$('keyDel').addEventListener('click', async () => {
  if (!confirm('¿Borrar esta llave? Ya no va a poder iniciar cargas.')) return;
  const r = await run('deleteKey', editingKey);
  if (r && r.ok) $('keyDlg').close();
});
$('keyCancel').addEventListener('click', () => $('keyDlg').close());

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

/* ---------- Ajustes ---------- */

function learnTxt(c) {
  if (!c || !c.batteryKWh) return '';
  const L = c.learn;
  if (!L || !L.n) return 'Todavía no aprendió: necesita una carga hasta lleno con el % de llegada.';
  return `Aprendido en ${L.n} ${L.n === 1 ? 'carga' : 'cargas'}: entra a la batería el ${Math.round(L.eff * 100)} % de lo que entrega el cargador.`;
}

let setCarsSig = '';
function renderSetCars() {
  if (!S) return;
  const sig = JSON.stringify(S.cars);
  if (sig === setCarsSig) return;
  setCarsSig = sig;
  $('setCars').innerHTML = S.cars.length
    ? S.cars.map((c) => `<button type="button" class="set-car" data-car="${c.id}"><span class="kd" style="background:${c.color};box-shadow:0 0 10px ${c.color}"></span><span><b>${esc(c.name)}</b><small>${c.batteryKWh ? nf(c.batteryKWh, 1) + ' kWh · ' + (c.chem || 'LFP') : 'Falta la batería'}</small></span><span class="lrn">${c.learn && c.learn.n ? 'aprendió ✓' : ''}</span></button>`).join('')
    : '<p class="note">Todavía no hay autos. Agregá el primero.</p>';
}
$('setCars').addEventListener('click', (e) => { const b = e.target.closest('[data-car]'); if (b) openCarForm(b.dataset.car); });
$('setCarAdd').addEventListener('click', () => openCarForm(null));

function openSettings() {
  if (!S) return;
  renderServer();
  setCarsSig = '';
  renderSetCars();
  $('tariffIn').value = S.tariff != null ? S.tariff : '';
  $('tariffSince').textContent = S.tariff != null && S.tariffSince
    ? `Precio actual: ${pesos(S.tariff)} por kWh, desde el ${new Date(S.tariffSince).toLocaleDateString('es-AR')}.`
    : 'Todavía no cargaste un precio.';
  $('settings').hidden = false;
  $('tariffIn').focus();
}
$('btnSettings').addEventListener('click', openSettings);
$('setBack').addEventListener('click', () => { $('settings').hidden = true; });
$('tariffSave').addEventListener('click', async () => {
  const v = Number(String($('tariffIn').value).replace(',', '.'));
  if (!(v >= 0) || $('tariffIn').value === '') { toast('Escribí el precio en pesos', true); return; }
  const r = await run('setTariff', v);
  if (r && r.ok) { $('settings').hidden = true; histSig = ''; }
});

/* ---------- Modo servidor (solo PC) ---------- */

let srvPin = '';
function renderServer() {
  if (!S || !S.server) return;
  const on = S.server.on;
  $('srvOn').checked = on;
  $('srvOnTxt').textContent = on ? 'Activo' : 'Apagado';
  $('srvCard').classList.toggle('on', on);
  $('srvPinLbl').textContent = S.server.hasPin ? 'PIN' : 'Creá un PIN (4 a 8 números)';
  $('srvPinNew').hidden = S.server.hasPin;
  $('srvPinBox').hidden = on && !!srvPin;
  $('srvForm').hidden = !(on && srvPin);
  $('cliCost').textContent = S.tariff != null ? `Tu precio de costo: ${pesos(S.tariff)} por kWh` : '';
  $('cliStart').disabled = !!activeSession();
  const now = new Date();
  const mk = dkey(now).slice(0, 7);
  const list = (S.charges || []).filter((c) => c.client);
  const month = list.filter((c) => dkey(new Date(c.start)).startsWith(mk));
  const tot = month.reduce((a, c) => a + (c.cost || 0), 0);
  $('cliList').innerHTML = `<div class="srv-total"><span>${MONTHS[now.getMonth()]}: ${month.length} ${month.length === 1 ? 'carga' : 'cargas'}</span><b>${pesos(tot)}</b></div>`
    + list.slice(0, 12).map((c) => `<button type="button" class="srv-item" data-ch="${c.id}"><span>${new Date(c.start).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}</span><span>${esc(c.client.name)}<small>${nf(c.kwh, 1)} kWh · ${pesos(c.client.price)}/kWh</small></span><b>${pesos(c.cost || 0)}</b></button>`).join('');
}
$('srvPinNew').addEventListener('click', async () => {
  const r = await run('serverPin', { pin: $('srvPin').value });
  if (r && r.ok) { srvPin = $('srvPin').value; $('srvPin').value = ''; }
});
$('srvOn').addEventListener('change', async (e) => {
  const want = e.target.checked;
  const pin = srvPin || $('srvPin').value;
  if (!pin) { e.target.checked = !want; toast('Escribí el PIN', true); $('srvPin').focus(); return; }
  const r = await run('serverMode', { pin, on: want });
  if (r && r.ok) { srvPin = want ? pin : ''; $('srvPin').value = ''; } else e.target.checked = !want;
  renderServer();
});
$('cliStart').addEventListener('click', async () => {
  const name = $('cliName').value.trim();
  const price = $('cliPrice').value;
  if (!name || !price) { toast('Completá el cliente y el precio', true); return; }
  if (!confirm(`¿Iniciar la carga para ${name} a $ ${price} por kWh?`)) return;
  const r = await run('startClient', { pin: srvPin, name, price });
  if (r && r.ok) { $('settings').hidden = true; $('cliName').value = ''; }
});

// Comprobante para el cliente
let lastTicket = null;
function showTicket(c) {
  const rows = [
    ['Fecha', new Date(c.start).toLocaleDateString('es-AR')],
    ['Horario', `${hhmm(c.start)} a ${hhmm(c.end)}`],
    ['Cliente', esc(c.client.name)],
    ['Energía', `${nf(c.kwh, 2)} kWh`],
    ['Precio', `${pesos(c.client.price)} por kWh`],
  ];
  $('ticketRows').innerHTML = rows.map(([a, b]) => `<div class="t-row"><span>${a}</span><b>${b}</b></div>`).join('')
    + `<div class="t-row big"><span>Total</span><b>${pesos(c.cost || 0)}</b></div>`;
  if (!$('ticketDlg').open) $('ticketDlg').showModal();
}
$('cliList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ch]');
  const c = b && (S.charges || []).find((x) => String(x.id) === b.dataset.ch);
  if (c) showTicket(c);
});
$('ticketOk').addEventListener('click', () => $('ticketDlg').close());
$('ticketPrint').addEventListener('click', () => window.print());
function maybeTicket() {
  const c = S.charges && S.charges[0];
  if (lastTicket === null) { lastTicket = c ? c.id : 0; return; } // al abrir no se muestra uno viejo
  if (!c || !c.client) return;
  if (c.id !== lastTicket && Date.now() - c.end < 600000) { lastTicket = c.id; if (!document.body.classList.contains('in-app') && innerWidth > 900) showTicket(c); }
}

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
    maybeTicket();
    if (!$('settings').hidden) { renderSetCars(); renderServer(); }
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

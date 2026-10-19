'use strict';
/* Alagoez Test Maker — PDF'ten soru kırpıp yeni test oluşturma (tamamen yerel çalışır). */

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const $ = (s, el = document) => el.querySelector(s);
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

// Kağıt boyutları (pt, dikey)
const PAPERS = {
  A4: [595.28, 841.89], A5: [419.53, 595.28], A3: [841.89, 1190.55],
  B5: [498.9, 708.66], Letter: [612, 792], Legal: [612, 1008],
};
const MARGINS = { dar: 28, normal: 42, genis: 71 }; // ≈ 1 / 1,5 / 2,5 cm
// Test türü seçilince uygulanan varsayılanlar
const MODES = {
  yaprak: { columns: 2, answerSpace: 0, spacing: 16 },
  yazili: { columns: 1, answerSpace: 90, spacing: 10 },
  deneme: { columns: 2, answerSpace: 0, spacing: 14, answerKey: true },
};

const DEFAULTS = {
  mode: 'yaprak',
  school: '', title: 'DENEME SINAVI', examName: '', subtitle: '', className: '',
  studentLine: true, showTeacher: false, teacher: '',
  paper: 'A4', orientation: 'portrait', columns: 2, marginPreset: 'normal', margin: 42,
  divider: true, numbering: true, startNo: 1, scale: 100, spacing: 16, answerSpace: 0,
  color: '#111111', watermark: '',
  pageNumbers: true, answerKey: true,
};

const S = {
  docs: [],        // {id, name, bytes: Uint8Array, pdf: PDFDocumentProxy}
  questions: [],   // {id, docId, page, rect:[x0,y0,x1,y1] (PDF pt), w, h, rotate, thumb, answer}
  activeDoc: null,
  zoom: 1,
  settings: { ...DEFAULTS },
  pages: [],       // page states of the active doc in the viewer
};

/* ---------- Kalıcı kayıt (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('test-hazirlayici', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(this.db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return new Promise((res, rej) => {
      if (!this.db) return res(undefined);
      const t = this.db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  get(k) { return this.tx('readonly', s => s.get(k)); },
  set(k, v) { return this.tx('readwrite', s => s.put(v, k)); },
};

function saveDocs() {
  DB.set('docs', S.docs.map(d => ({ id: d.id, name: d.name, bytes: d.bytes }))).catch(console.warn);
}
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    DB.set('state', { questions: S.questions, settings: S.settings, zoom: S.zoom, activeDoc: S.activeDoc }).catch(console.warn);
  }, 300);
}

/* ---------- Yardımcılar ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(on, text) {
  const b = $('#busy');
  if (text) $('#busyText').textContent = text;
  if (on) {
    b.hidden = false;
    requestAnimationFrame(() => b.classList.add('show'));
  } else {
    b.classList.remove('show');
    setTimeout(() => { if (!b.classList.contains('show')) b.hidden = true; }, 220);
  }
}

/* ---------- Animasyon yardımcıları ---------- */
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const enterIds = new Set();   // bir sonraki çizimde giriş animasyonu alacak sorular
let popAnswerId = null;       // cevabı az önce seçilen soru
const seenDocs = new Set();   // sekmesi zaten gösterilmiş belgeler

// Öğeye çıkış sınıfı ekleyip animasyon bitene kadar bekler.
function animateOut(els, ms = 200) {
  const list = [els].flat().filter(Boolean);
  if (!list.length || reduceMotion()) return Promise.resolve();
  list.forEach(el => el.classList.add('leave'));
  return new Promise(r => setTimeout(r, ms));
}
// Sekme/segment kaydırmalı göstergesini aktif öğeye taşır.
function moveIndicator(box) {
  const act = box?.querySelector('.active');
  if (!act || !act.offsetWidth) return;
  box.style.setProperty('--ind-x', act.offsetLeft + 'px');
  box.style.setProperty('--ind-w', act.offsetWidth + 'px');
  box.classList.add('has-ind');
}
function bump(el) {
  if (!el || reduceMotion()) return;
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}
// Tıklanan düğmede dalga efekti
function ripple(e) {
  const b = e.target.closest('.btn, .tab, .modes button, .ans button, .icon-btn, .ans-pop button');
  if (!b || e.button !== 0 || reduceMotion()) return;
  const r = b.getBoundingClientRect();
  const s = Math.max(r.width, r.height) * 2.2;
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
  b.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
}
const qCard = id => $(`#qList .q[data-id="${id}"]`);
const qSels = id => [...document.querySelectorAll(`.sel[data-id="${id}"]`)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const activeDoc = () => S.docs.find(d => d.id === S.activeDoc) || null;
const docById = id => S.docs.find(d => d.id === id);
const canvasBytes = (c, type = 'image/png', q) =>
  new Promise(res => c.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), type, q));

/* ---------- PDF yükleme ---------- */
async function openPdfBytes(name, bytes, id = uid('d')) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const doc = { id, name, bytes, pdf };
  S.docs.push(doc);
  return doc;
}

const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);

// Resmi (sayfa fotoğrafı/taraması) tek sayfalık bir PDF'e çevirir; böylece PDF'lerle aynı şekilde kırpılır.
async function imageToPdfBytes(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(await canvasBytes(c, 'image/jpeg', 0.92));
  const pw = PAPERS.A4[0], ph = c.height * pw / c.width; // sayfa genişliği A4 kadar
  doc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  return doc.save();
}

async function addFiles(files) {
  const list = [...files].filter(f => isPdf(f) || isImage(f));
  if (!list.length) return toast('Lütfen PDF ya da resim dosyası seç.');
  busy(true, 'Dosya açılıyor…');
  let last = null;
  for (const f of list) {
    try {
      const bytes = isPdf(f) ? new Uint8Array(await f.arrayBuffer()) : await imageToPdfBytes(f);
      last = await openPdfBytes(f.name, bytes);
    } catch (err) {
      console.error(err);
      toast(`"${f.name}" açılamadı (şifreli veya bozuk olabilir).`, 4000);
    }
  }
  busy(false);
  if (last) {
    S.activeDoc = last.id;
    saveDocs(); saveState();
    renderTabs(); renderViewer();
  }
}

async function removeDoc(id) {
  const doc = docById(id);
  const n = S.questions.filter(q => q.docId === id).length;
  if (!confirm(`"${doc.name}" kapatılsın mı?` + (n ? `\nBu dosyadan seçilen ${n} soru da listeden silinecek.` : ''))) return;
  await animateOut([$(`.doc-tab[data-id="${id}"]`), ...S.questions.filter(q => q.docId === id).map(q => qCard(q.id))], 200);
  S.questions = S.questions.filter(q => q.docId !== id);
  S.docs = S.docs.filter(d => d.id !== id);
  doc.pdf.destroy();
  if (S.activeDoc === id) S.activeDoc = S.docs[0]?.id || null;
  saveDocs(); saveState();
  renderTabs(); renderViewer(); renderQList();
}

function renderTabs() {
  const fresh = id => (seenDocs.has(id) ? '' : 'enter');
  $('#docTabs').innerHTML = S.docs.map(d => `
    <div class="doc-tab ${d.id === S.activeDoc ? 'active' : ''} ${fresh(d.id)}" data-id="${d.id}" title="${esc(d.name)}">
      <svg class="ic"><use href="#i-file"/></svg><span class="name">${esc(d.name.replace(/\.(pdf|jpe?g|png|webp|gif|bmp)$/i, ''))}</span>
      <button class="x" data-close="${d.id}" title="Kapat" aria-label="Kapat"><svg class="ic"><use href="#i-x"/></svg></button>
    </div>`).join('');
  S.docs.forEach(d => seenDocs.add(d.id));
}

/* ---------- Görüntüleyici ---------- */
let viewGen = 0, observer = null, renderChain = Promise.resolve();

async function renderViewer() {
  const gen = ++viewGen;
  const box = $('#pages');
  box.innerHTML = '';
  S.pages = [];
  observer?.disconnect();
  const zl = $('#zoomLabel'), zt = Math.round(S.zoom * 100) + '%';
  if (zl.textContent !== zt) { zl.textContent = zt; bump(zl); }
  const doc = activeDoc();
  $('#emptyState').hidden = !!doc;
  if (!doc) return;

  const first = await doc.pdf.getPage(1);
  if (gen !== viewGen) return;
  const avail = Math.max(300, Math.min($('#viewer').clientWidth - 64, 1000));
  const scale = (avail / first.getViewport({ scale: 1 }).width) * S.zoom;
  observer = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) queueRender(e.target._ps);
  }, { root: $('#viewer'), rootMargin: '900px 0px' });

  for (let i = 0; i < doc.pdf.numPages; i++) {
    const page = i === 0 ? first : await doc.pdf.getPage(i + 1);
    if (gen !== viewGen) return;
    const vp = page.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap enter';
    wrap.style.setProperty('--i', Math.min(i, 4));
    wrap.innerHTML = `<div class="page-label">Sayfa ${i + 1} / ${doc.pdf.numPages}</div>
      <div class="page" style="width:${Math.floor(vp.width)}px;height:${Math.floor(vp.height)}px">
        <canvas></canvas><div class="overlay"></div></div>`;
    box.appendChild(wrap);
    const ps = {
      gen, doc, index: i, page, vp,
      el: $('.page', wrap), canvas: $('canvas', wrap), overlay: $('.overlay', wrap),
      ready: null,
    };
    ps.el._ps = ps;
    S.pages.push(ps);
    bindCropping(ps);
    drawSelections(ps);
    observer.observe(ps.el);
  }
}

function queueRender(ps) {
  if (ps.ready) return ps.ready;
  ps.ready = renderChain = renderChain.then(() => renderPage(ps)).catch(err => console.error(err));
  return ps.ready;
}

async function renderPage(ps) {
  if (ps.gen !== viewGen) return;
  const dpr = Math.max(1.5, Math.min(window.devicePixelRatio || 1, 2.5));
  const c = ps.canvas;
  c.width = Math.floor(ps.vp.width * dpr);
  c.height = Math.floor(ps.vp.height * dpr);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  await ps.page.render({ canvasContext: ctx, viewport: ps.vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
  ps.el.classList.add('ready');
}

function zoomTo(z) {
  S.zoom = Math.min(3, Math.max(0.4, Math.round(z * 10) / 10));
  saveState();
  const v = $('#viewer');
  const ratio = v.scrollTop / Math.max(1, v.scrollHeight);
  renderViewer().then(() => { v.scrollTop = ratio * v.scrollHeight; });
}

/* ---------- Kırpma ---------- */
function bindCropping(ps) {
  const ov = ps.overlay;
  let start = null, band = null;
  const pos = e => {
    const r = ov.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  };
  ov.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.sel, .ans-pop')) return;
    e.preventDefault();
    closeAnswerPopup();
    start = pos(e);
    band = document.createElement('div');
    band.className = 'band';
    ov.appendChild(band);
    ov.setPointerCapture(e.pointerId);
  });
  ov.addEventListener('pointermove', e => {
    if (!start) return;
    const p = pos(e);
    Object.assign(band.style, {
      left: Math.min(p.x, start.x) + 'px', top: Math.min(p.y, start.y) + 'px',
      width: Math.abs(p.x - start.x) + 'px', height: Math.abs(p.y - start.y) + 'px',
    });
  });
  const end = e => {
    if (!start) return;
    const p = pos(e);
    const r = { x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    start = null; band.remove(); band = null;
    if (r.w > 12 && r.h > 12) addCrop(ps, r);
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', () => { start = null; band?.remove(); band = null; });
}

// Seçimin etrafındaki beyaz alanı daraltır (r: ekran px).
function trimRect(ps, r) {
  const c = ps.canvas, k = c.width / ps.vp.width;
  const x0 = Math.max(0, Math.floor(r.x * k)), y0 = Math.max(0, Math.floor(r.y * k));
  const x1 = Math.min(c.width, Math.ceil((r.x + r.w) * k)), y1 = Math.min(c.height, Math.ceil((r.y + r.h) * k));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return r;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4;
    for (let x = 0; x < w; x++, row += 4) {
      if (d[row] + d[row + 1] + d[row + 2] < 600) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return r;
  const pad = 6 * k;
  const nx0 = Math.max(0, minX - pad), ny0 = Math.max(0, minY - pad);
  const nx1 = Math.min(w, maxX + 1 + pad), ny1 = Math.min(h, maxY + 1 + pad);
  return { x: (x0 + nx0) / k, y: (y0 + ny0) / k, w: (nx1 - nx0) / k, h: (ny1 - ny0) / k };
}

function makeThumb(ps, r) {
  const c = ps.canvas, k = c.width / ps.vp.width;
  const sw = r.w * k, sh = r.h * k;
  const tw = Math.min(360, sw);
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(tw));
  t.height = Math.max(1, Math.round(sh * tw / sw));
  const g = t.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, t.width, t.height);
  g.drawImage(c, r.x * k, r.y * k, sw, sh, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.85);
}

// Ekrandaki kutu (px) → PDF koordinatları, boyut ve küçük resim
function cropFields(ps, r) {
  const [ax, ay] = ps.vp.convertToPdfPoint(r.x, r.y);
  const [bx, by] = ps.vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
  return {
    rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
    w: r.w / ps.vp.scale, h: r.h / ps.vp.scale,
    thumb: makeThumb(ps, r),
  };
}

async function addCrop(ps, r) {
  await queueRender(ps);
  if ($('#autoTrim').checked) r = trimRect(ps, r);
  const q = {
    id: uid('q'), docId: ps.doc.id, page: ps.index,
    rotate: ps.page.rotate || 0, answer: '',
    ...cropFields(ps, r),
  };
  S.questions.push(q);
  enterIds.add(q.id);
  afterQChange();
  $('#qList').lastElementChild?.scrollIntoView({ block: 'nearest' });
  if ($('#askAnswer').checked) showAnswerPopup(ps, q);
}

async function updateCrop(ps, q, r) {
  await queueRender(ps);
  Object.assign(q, cropFields(ps, r));
  afterQChange();
}

/* Kırptıktan sonra çıkan A-E cevap seçimi */
let answerPop = null;
function closeAnswerPopup() {
  answerPop?.el.remove();
  answerPop = null;
}
function setPopupAnswer(letter) {
  if (!answerPop) return;
  answerPop.q.answer = letter;
  popAnswerId = answerPop.q.id;
  closeAnswerPopup();
  afterQChange();
}
function showAnswerPopup(ps, q) {
  closeAnswerPopup();
  const sel = ps.overlay.querySelector(`.sel[data-id="${q.id}"]`);
  if (!sel) return;
  const pop = document.createElement('div');
  pop.className = 'ans-pop';
  pop.innerHTML = `<span>Cevap:</span>${LETTERS.map(L => `<button data-a="${L}">${L}</button>`).join('')}<button class="skip">Geç</button>`;
  pop.addEventListener('pointerdown', e => e.stopPropagation());
  pop.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a) setPopupAnswer(b.dataset.a); else closeAnswerPopup();
  });
  ps.overlay.appendChild(pop);
  const below = sel.offsetTop + sel.offsetHeight + 8;
  pop.style.left = clamp(sel.offsetLeft, 0, Math.max(0, ps.overlay.clientWidth - pop.offsetWidth)) + 'px';
  pop.style.top = (below + pop.offsetHeight < ps.overlay.clientHeight ? below : Math.max(0, sel.offsetTop - pop.offsetHeight - 26)) + 'px';
  answerPop = { el: pop, q };
}

/* Var olan kutuyu taşıma / köşelerinden boyutlandırma */
function bindSelEdit(ps, el, q) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.x')) return;
    e.preventDefault(); e.stopPropagation();
    closeAnswerPopup();
    const dir = e.target.dataset.h || 'move';
    const st = { mx: e.clientX, my: e.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    const W = ps.overlay.clientWidth, H = ps.overlay.clientHeight, MIN = 15;
    let cur = null;
    el.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = ev.clientX - st.mx, dy = ev.clientY - st.my;
      let { l, t, w, h } = st;
      if (dir === 'move') {
        l = clamp(l + dx, 0, W - w); t = clamp(t + dy, 0, H - h);
      } else {
        if (dir.includes('w')) { const nl = clamp(l + dx, 0, l + w - MIN); w += l - nl; l = nl; }
        if (dir.includes('e')) w = clamp(w + dx, MIN, W - l);
        if (dir.includes('n')) { const nt = clamp(t + dy, 0, t + h - MIN); h += t - nt; t = nt; }
        if (dir.includes('s')) h = clamp(h + dy, MIN, H - t);
      }
      Object.assign(el.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
      cur = { x: l, y: t, w, h };
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (cur) updateCrop(ps, q, cur);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

function drawSelections(ps) {
  ps.overlay.querySelectorAll('.sel').forEach(el => el.remove());
  S.questions.forEach((q, i) => {
    if (q.docId !== ps.doc.id || q.page !== ps.index) return;
    const [ax, ay] = ps.vp.convertToViewportPoint(q.rect[0], q.rect[1]);
    const [bx, by] = ps.vp.convertToViewportPoint(q.rect[2], q.rect[3]);
    const el = document.createElement('div');
    el.className = enterIds.has(q.id) ? 'sel enter' : 'sel';
    el.dataset.id = q.id;
    el.title = 'Sürükleyerek taşı, köşelerinden boyutlandır';
    Object.assign(el.style, {
      left: Math.min(ax, bx) + 'px', top: Math.min(ay, by) + 'px',
      width: Math.abs(bx - ax) + 'px', height: Math.abs(by - ay) + 'px',
    });
    el.innerHTML = `<span class="badge">${S.settings.startNo + i}${q.answer ? ' · ' + q.answer : ''}</span>`
      + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(d => `<span class="h ${d}" data-h="${d}"></span>`).join('')
      + `<button class="x" title="Bu soruyu kaldır" aria-label="Bu soruyu kaldır"><svg class="ic"><use href="#i-x"/></svg></button>`;
    $('.x', el).addEventListener('click', ev => { ev.stopPropagation(); removeQuestion(q.id); });
    bindSelEdit(ps, el, q);
    ps.overlay.appendChild(el);
  });
}

function refreshSelections() { S.pages.forEach(drawSelections); }

/* ---------- Soru listesi ---------- */
function renderQList() {
  const cnt = $('#qCount');
  if (cnt.textContent !== String(S.questions.length)) { cnt.textContent = S.questions.length; bump(cnt); }
  const list = $('#qList');
  if (!S.questions.length) {
    list.innerHTML = `<div class="q-empty"><svg class="ic"><use href="#i-crop"/></svg><b>Henüz soru seçmedin</b><span>Soldaki sayfada bir sorunun etrafına fareyle kutu çiz; soru burada belirir.</span></div>`;
    return;
  }
  let k = 0; // aynı anda giren kartlar için kademe
  list.innerHTML = S.questions.map((q, i) => {
    const doc = docById(q.docId);
    const enter = enterIds.has(q.id);
    return `<div class="q${enter ? ' enter' : ''}" data-id="${q.id}"${enter ? ` style="--i:${Math.min(k++, 10)}"` : ''}>
      <div class="q-top">
        <span class="handle" title="Sürükleyerek sırala"><svg class="ic"><use href="#i-grip"/></svg></span>
        <span class="q-no">${S.settings.startNo + i}.</span>
        <span class="q-src" title="${esc(doc?.name || '')}">${esc((doc?.name || '').replace(/\.(pdf|jpe?g|png|webp|gif|bmp)$/i, ''))} · s.${q.page + 1}</span>
        <button class="del" title="Kaldır" aria-label="Soruyu kaldır"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>
      <img src="${q.thumb}" alt="Soru ${i + 1}" title="Sayfada göster">
      <div class="ans">Cevap: ${LETTERS.map(L => `<button data-a="${L}" class="${q.answer === L ? (popAnswerId === q.id ? 'on pop' : 'on') : ''}">${L}</button>`).join('')}</div>
    </div>`;
  }).join('');
}

function afterQChange() {
  renderQList();
  refreshSelections();
  enterIds.clear();
  popAnswerId = null;
  saveState();
}

async function removeQuestion(id) {
  if (answerPop?.q.id === id) closeAnswerPopup();
  await animateOut([qCard(id), ...qSels(id)]);
  S.questions = S.questions.filter(q => q.id !== id);
  afterQChange();
}

function showQuestion(id) {
  const q = S.questions.find(x => x.id === id);
  if (!q) return;
  const go = () => {
    const ps = S.pages[q.page];
    if (!ps) return;
    ps.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      const el = ps.overlay.querySelector(`.sel[data-id="${id}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 2600);
    }, 350);
  };
  if (S.activeDoc !== q.docId) {
    S.activeDoc = q.docId; renderTabs();
    renderViewer().then(go);
  } else go();
}

/* ---------- PDF oluşturma ---------- */

// Kaynak PDF'i 3x çözünürlükte görüntü olarak kırpar (döndürülmüş/şifreli sayfalar için yedek yol).
async function rasterCrop(q) {
  const doc = docById(q.docId);
  const page = await doc.pdf.getPage(q.page + 1);
  const vp = page.getViewport({ scale: 3 });
  const [ax, ay] = vp.convertToViewportPoint(q.rect[0], q.rect[1]);
  const [bx, by] = vp.convertToViewportPoint(q.rect[2], q.rect[3]);
  const left = Math.floor(Math.min(ax, bx)), top = Math.floor(Math.min(ay, by));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(Math.abs(bx - ax)));
  c.height = Math.max(1, Math.ceil(Math.abs(by - ay)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -left, -top] }).promise;
  return canvasBytes(c);
}

// Kanvasa yazılmış metni PNG olarak gömer (Türkçe karakterler için).
async function textImage(out, wPt, hPt, draw) {
  const k = 4;
  const c = document.createElement('canvas');
  c.width = Math.ceil(wPt * k); c.height = Math.ceil(hPt * k);
  const g = c.getContext('2d');
  g.scale(k, k);
  g.fillStyle = '#000'; g.strokeStyle = '#000'; g.textBaseline = 'alphabetic';
  draw(g, wPt, hPt);
  return out.embedPng(await canvasBytes(c));
}

const FONT = 'Arial, "Segoe UI", sans-serif';
// Yazı sığmazsa punto küçültür.
function fitFont(g, text, weight, size, maxW) {
  let s = size;
  g.font = `${weight} ${s}px ${FONT}`;
  while (s > 6 && g.measureText(text).width > maxW) { s -= 0.5; g.font = `${weight} ${s}px ${FONT}`; }
  return s;
}
function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function paperSize(set) {
  const [w, h] = PAPERS[set.paper] || PAPERS.A4;
  return set.orientation === 'landscape' ? [h, w] : [w, h];
}

const STUDENT_FIELDS = set => [['Adı Soyadı', '', 0.46], ['Sınıfı', set.className.trim(), 0.18], ['No', '', 0.18], ['Puan', '', 0.18]];

// Başlık: Yazılı Kağıdı için çerçeveli resmi düzen, diğerleri için renkli şeritli düzen.
async function buildHeader(out, set, W) {
  const school = set.school.trim(), desc = set.subtitle.trim();
  const head = [set.title.trim(), set.examName.trim()].filter(Boolean).join(' – ');
  if (!school && !head && !desc && !set.studentLine) return null;
  const color = set.color;

  if (set.mode === 'yazili') {
    const rowsH = 6 + (school ? 16 : 0) + (head ? 18 : 0) + (desc ? 14 : 0);
    const gridH = set.studentLine ? 24 : 0;
    const h = rowsH + gridH + 2;
    const img = await textImage(out, W, h, g => {
      g.strokeStyle = color; g.lineWidth = 1;
      g.strokeRect(0.5, 0.5, W - 1, h - 1);
      g.textAlign = 'center'; g.fillStyle = '#000';
      let y = 4;
      if (school) { fitFont(g, school, 'bold', 11, W - 16); g.fillText(school, W / 2, y + 12); y += 16; }
      if (head) { fitFont(g, head, 'bold', 12.5, W - 16); g.fillText(head, W / 2, y + 13); y += 18; }
      if (desc) { fitFont(g, desc, 'normal', 10, W - 16); g.fillText(desc, W / 2, y + 11); y += 14; }
      if (gridH) {
        const top = rowsH;
        g.beginPath(); g.moveTo(0, top); g.lineTo(W, top); g.stroke();
        g.textAlign = 'left';
        let x = 0;
        STUDENT_FIELDS(set).forEach(([label, val, frac], i) => {
          if (i) { g.beginPath(); g.moveTo(x, top); g.lineTo(x, h); g.stroke(); }
          g.font = `bold 10px ${FONT}`; g.fillStyle = color;
          const t = label + ':';
          g.fillText(t, x + 6, top + 15);
          if (val) { g.fillStyle = '#000'; g.font = `10px ${FONT}`; g.fillText(val, x + 10 + g.measureText(t).width + 2, top + 15); }
          x += W * frac;
        });
      }
    });
    return { img, h, line: false };
  }

  const h = 2 + (school ? 15 : 0) + (head ? 30 : 0) + (desc ? 15 : 0) + (set.studentLine ? 22 : 0);
  const img = await textImage(out, W, h, g => {
    let y = 1;
    g.textAlign = 'center';
    if (school) { g.fillStyle = color; fitFont(g, school, 'bold', 10.5, W - 10); g.fillText(school, W / 2, y + 11); y += 15; }
    if (head) {
      g.fillStyle = color;
      g.beginPath();
      if (g.roundRect) g.roundRect(0, y, W, 25, 5); else g.rect(0, y, W, 25);
      g.fill();
      g.fillStyle = '#fff';
      fitFont(g, head, 'bold', set.mode === 'deneme' ? 15 : 14, W - 20);
      g.fillText(head, W / 2, y + 17.5);
      y += 30;
    }
    if (desc) { g.fillStyle = '#333'; fitFont(g, desc, 'normal', 10, W - 10); g.fillText(desc, W / 2, y + 11); y += 15; }
    if (set.studentLine) {
      y += 15;
      g.textAlign = 'left'; g.lineWidth = 0.5; g.strokeStyle = '#000';
      let x = 0;
      for (const [label, val, frac] of STUDENT_FIELDS(set)) {
        const t = label + ':';
        g.fillStyle = '#000'; g.font = `10px ${FONT}`;
        g.fillText(t, x, y);
        let lx = x + g.measureText(t).width + 4;
        if (val) { g.font = `bold 10px ${FONT}`; g.fillText(val, lx, y); lx += g.measureText(val).width + 4; }
        g.setLineDash([1, 1.5]);
        g.beginPath(); g.moveTo(lx, y + 1.5); g.lineTo(x + W * frac - 12, y + 1.5); g.stroke();
        g.setLineDash([]);
        x += W * frac;
      }
    }
  });
  return { img, h, line: true };
}

async function buildWatermark(out, text) {
  const t = text.trim();
  if (!t) return null;
  const m = document.createElement('canvas').getContext('2d');
  m.font = `bold 60px ${FONT}`;
  const w = m.measureText(t).width + 20, h = 80;
  const img = await textImage(out, w, h, g => {
    g.font = `bold 60px ${FONT}`; g.textAlign = 'center'; g.fillStyle = '#000';
    g.fillText(t, w / 2, 60);
  });
  return { img, w, h };
}

function drawWatermark(page, wm, PW, PH) {
  const ang = Math.atan2(PH, PW);
  const s = Math.min(1, (Math.hypot(PW, PH) * 0.7) / wm.w);
  const w = wm.w * s, h = wm.h * s;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  // Döndürme sol-alt köşe etrafında yapılır; görüntünün merkezini sayfanın ortasına getir.
  const x = PW / 2 - (w / 2 * cos - h / 2 * sin);
  const y = PH / 2 - (w / 2 * sin + h / 2 * cos);
  page.drawImage(wm.img, { x, y, width: w, height: h, rotate: degrees(ang * 180 / Math.PI), opacity: 0.08 });
}

async function buildPdf() {
  const qs = S.questions;
  if (!qs.length) { toast('Önce en az bir soru seç.'); return null; }
  const set = S.settings;
  const out = await PDFDocument.create();
  out.setTitle([set.title, set.examName].filter(Boolean).join(' – ') || 'Test');
  out.setCreator('Alagoez Test Maker');
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const reg = await out.embedFont(StandardFonts.Helvetica);
  const color = hexToRgb(set.color);
  const [PW, PH] = paperSize(set);

  // 1) Her soruyu yeni PDF'e göm: mümkünse vektörel (orijinal kalite), değilse görüntü olarak.
  const items = new Array(qs.length);
  for (const doc of S.docs) {
    const idx = qs.map((q, i) => i).filter(i => qs[i].docId === doc.id);
    if (!idx.length) continue;
    let src = null;
    try {
      src = await PDFDocument.load(doc.bytes, { ignoreEncryption: true, updateMetadata: false });
      if (src.isEncrypted) src = null;
    } catch (err) { console.warn('pdf-lib load failed, using images', err); }
    const vec = src ? idx.filter(i => qs[i].rotate % 360 === 0) : [];
    if (vec.length) {
      const pages = vec.map(i => src.getPage(qs[i].page));
      const boxes = vec.map(i => { const r = qs[i].rect; return { left: r[0], bottom: r[1], right: r[2], top: r[3] }; });
      try {
        const emb = await out.embedPages(pages, boxes);
        emb.forEach((e, k) => { items[vec[k]] = { kind: 'page', obj: e }; });
      } catch (err) {
        console.warn('embedPages failed, falling back to per-question', err);
        for (let k = 0; k < vec.length; k++) {
          try { items[vec[k]] = { kind: 'page', obj: await out.embedPage(pages[k], boxes[k]) }; } catch { /* görüntüye düş */ }
        }
      }
    }
    for (const i of idx) {
      if (!items[i]) items[i] = { kind: 'img', obj: await out.embedPng(await rasterCrop(qs[i])) };
    }
  }

  // 2) Yerleşim
  const m = set.margin, cols = +set.columns, gap = cols > 2 ? 14 : 20;
  const colW = (PW - 2 * m - gap * (cols - 1)) / cols;
  const numW = set.numbering ? 20 : 0;
  const bottomY = m + (set.pageNumbers ? 16 : 0);
  const header = await buildHeader(out, set, PW - 2 * m);
  const wm = await buildWatermark(out, set.watermark);
  const pageInfo = [];
  let page, topY, col, y;

  const newPage = () => {
    page = out.addPage([PW, PH]);
    if (wm) drawWatermark(page, wm, PW, PH);
    topY = PH - m;
    if (header && pageInfo.length === 0) {
      page.drawImage(header.img, { x: m, y: topY - header.h, width: PW - 2 * m, height: header.h });
      topY -= header.h + 6;
      if (header.line) page.drawLine({ start: { x: m, y: topY }, end: { x: PW - m, y: topY }, thickness: 1, color });
      topY -= 12;
    }
    pageInfo.push({ page, topY });
    col = 0; y = topY;
  };
  // Sütunda yer yoksa sonraki sütuna/sayfaya geç.
  const ensure = need => {
    if (y - need < bottomY && y < topY) {
      col++;
      if (col >= cols) newPage(); else y = topY;
    }
  };
  newPage();

  qs.forEach((q, i) => {
    const it = items[i];
    const baseS = Math.min(set.scale / 100, (colW - numW) / q.w);
    const fit = () => {
      const colH = topY - bottomY;
      let s = baseS;
      if (q.h * s > colH) s = colH / q.h;
      return { s, need: Math.min(q.h * s + set.answerSpace, colH) };
    };
    let f = fit();
    ensure(f.need);
    f = fit();
    const dw = q.w * f.s, dh = q.h * f.s;
    const x = m + col * (colW + gap);
    if (it.kind === 'page') page.drawPage(it.obj, { x: x + numW, y: y - dh, width: dw, height: dh });
    else page.drawImage(it.obj, { x: x + numW, y: y - dh, width: dw, height: dh });
    if (set.numbering) page.drawText(`${set.startNo + i}.`, { x, y: y - 11, size: 10.5, font: bold, color });
    y -= Math.max(dh, f.need) + set.spacing;
  });

  // Öğretmen imzası: son sorunun altına, sütunun sağına
  const teacher = set.showTeacher ? set.teacher.trim() : '';
  if (teacher) {
    const bw = colW, bh = 30;
    ensure(bh);
    const img = await textImage(out, bw, bh, g => {
      g.textAlign = 'right';
      g.font = `italic 9.5px ${FONT}`; g.fillStyle = '#333';
      g.fillText('Başarılar dilerim.', bw - 2, 11);
      g.fillStyle = '#000'; fitFont(g, teacher, 'bold', 10.5, bw - 4);
      g.fillText(teacher, bw - 2, 25);
    });
    page.drawImage(img, { x: m + col * (colW + gap), y: y - bh, width: bw, height: bh });
  }

  if (cols > 1 && set.divider) {
    for (const p of pageInfo) {
      for (let c = 1; c < cols; c++) {
        const lx = m + c * (colW + gap) - gap / 2;
        p.page.drawLine({ start: { x: lx, y: p.topY + 4 }, end: { x: lx, y: bottomY }, thickness: 0.6, color });
      }
    }
  }

  // 3) Cevap anahtarı
  if (set.answerKey && qs.some(q => q.answer)) {
    const perRow = 5, rowH = 22, keyColW = (PW - 2 * m) / perRow;
    let p = out.addPage([PW, PH]);
    let ky = PH - m - 18;
    const t = 'CEVAP ANAHTARI';
    p.drawText(t, { x: (PW - bold.widthOfTextAtSize(t, 16)) / 2, y: ky, size: 16, font: bold, color });
    ky -= 30;
    qs.forEach((q, i) => {
      const c = i % perRow;
      if (c === 0 && i > 0) ky -= rowH;
      if (ky < m + 20) { p = out.addPage([PW, PH]); ky = PH - m - 18; }
      const x = m + c * keyColW + 10;
      p.drawText(`${set.startNo + i}.`, { x, y: ky, size: 12, font: reg });
      p.drawText(q.answer || '-', { x: x + 34, y: ky, size: 12, font: bold });
    });
  }

  // 4) Sayfa numaraları
  if (set.pageNumbers) {
    const all = out.getPages();
    all.forEach((p, i) => {
      const t = `${i + 1} / ${all.length}`;
      p.drawText(t, { x: (PW - reg.widthOfTextAtSize(t, 9)) / 2, y: m - 4, size: 9, font: reg, color: rgb(0.35, 0.35, 0.35) });
    });
  }

  return out.save();
}

async function exportPdf(preview) {
  if (!S.questions.length) return toast('Önce en az bir soru seç.');
  busy(true, 'PDF hazırlanıyor…');
  try {
    const bytes = await buildPdf();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (preview) {
      window.open(url, '_blank');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = (S.settings.title.trim() || 'test').replace(/[\\/:*?"<>|]+/g, '-') + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      toast(`PDF hazır: ${S.questions.length} soru.`);
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    console.error(err);
    toast('PDF oluşturulurken hata oldu: ' + err.message, 5000);
  } finally {
    busy(false);
  }
}

/* ---------- Ayarlar ---------- */
function syncSettingsInputs() {
  const set = S.settings;
  document.querySelectorAll('[data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'text' && el === document.activeElement) return; // yazarken imleci bozma
    if (el.type === 'checkbox') el.checked = !!set[k];
    else if (el.type === 'radio') el.checked = String(set[k]) === el.value;
    else el.value = set[k];
  });
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === set.mode));
  document.querySelectorAll('.swatch').forEach(b => b.classList.toggle('active', b.dataset.color.toLowerCase() === String(set.color).toLowerCase()));
  moveIndicator($('.modes'));
  updateOutputs();
}
function bindSettings() {
  const set = S.settings;
  syncSettingsInputs();
  document.querySelectorAll('[data-key]').forEach(el => {
    const k = el.dataset.key;
    el.addEventListener('input', () => {
      if (el.type === 'checkbox') set[k] = el.checked;
      else if (el.type === 'radio') { if (el.checked) set[k] = +el.value; }
      else if (el.type === 'number' || el.type === 'range' || 'num' in el.dataset) set[k] = Math.max(+el.min || 0, +el.value || 0);
      else set[k] = el.value;
      if (k === 'marginPreset' && MARGINS[set.marginPreset]) set.margin = MARGINS[set.marginPreset];
      if (k === 'margin') set.marginPreset = Object.keys(MARGINS).find(p => MARGINS[p] === set.margin) || 'ozel';
      syncSettingsInputs();
      if (k === 'startNo') { renderQList(); refreshSelections(); }
      saveState();
    });
  });
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    set.mode = b.dataset.mode;
    Object.assign(set, MODES[set.mode]);
    syncSettingsInputs(); saveState();
    toast(`${b.textContent} şablonu uygulandı.`);
  }));
  document.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
    set.color = b.dataset.color;
    syncSettingsInputs(); saveState();
  }));
}
const pt2cm = v => (v / 28.35).toFixed(1).replace('.', ',') + ' cm';
const pt2mm = v => Math.round(v * 0.3528) + ' mm';
function updateOutputs() {
  const set = S.settings;
  const fmt = { margin: pt2cm, spacing: pt2mm, answerSpace: v => (v ? pt2cm(v) : 'yok'), scale: v => v + '%' };
  document.querySelectorAll('[data-out]').forEach(o => {
    const k = o.dataset.out;
    o.textContent = fmt[k] ? fmt[k](set[k]) : set[k];
  });
}

/* ---------- Olaylar ---------- */
function bindUi() {
  for (const id of ['#fileInput', '#fileInput2']) {
    $(id).addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  }
  $('#docTabs').addEventListener('click', e => {
    const close = e.target.closest('[data-close]');
    if (close) return removeDoc(close.dataset.close);
    const tab = e.target.closest('.doc-tab');
    if (tab && tab.dataset.id !== S.activeDoc) {
      S.activeDoc = tab.dataset.id; saveState(); renderTabs(); renderViewer();
    }
  });
  $('#zoomIn').addEventListener('click', () => zoomTo(S.zoom + 0.1));
  $('#zoomOut').addEventListener('click', () => zoomTo(S.zoom - 0.1));

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    if (t.classList.contains('active')) return;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    moveIndicator($('.tabs'));
    document.querySelectorAll('.panel').forEach(p => {
      p.hidden = p.id !== t.dataset.tab;
      p.classList.remove('enter');
      if (!p.hidden) { void p.offsetWidth; p.classList.add('enter'); }
    });
    moveIndicator($('.modes'));
  }));
  document.addEventListener('pointerdown', ripple);
  window.addEventListener('resize', () => { moveIndicator($('.tabs')); moveIndicator($('.modes')); });

  const list = $('#qList');
  list.addEventListener('click', e => {
    const card = e.target.closest('.q');
    if (!card) return;
    const q = S.questions.find(x => x.id === card.dataset.id);
    if (e.target.closest('.del')) return removeQuestion(q.id);
    const a = e.target.closest('[data-a]');
    if (a) { q.answer = q.answer === a.dataset.a ? '' : a.dataset.a; popAnswerId = q.id; afterQChange(); return; }
    if (e.target.tagName === 'IMG') showQuestion(q.id);
  });
  Sortable.create(list, {
    handle: '.handle', animation: 260, easing: 'cubic-bezier(.2, .8, .2, 1)', draggable: '.q',
    onEnd(e) {
      if (e.oldIndex === e.newIndex) return;
      const [moved] = S.questions.splice(e.oldIndex, 1);
      S.questions.splice(e.newIndex, 0, moved);
      afterQChange();
    },
  });

  $('#undoBtn').addEventListener('click', () => {
    const last = S.questions[S.questions.length - 1];
    if (last) removeQuestion(last.id);
  });
  $('#clearBtn').addEventListener('click', async () => {
    if (!S.questions.length || !confirm('Seçilen tüm sorular listeden silinsin mi?')) return;
    closeAnswerPopup();
    const cards = [...document.querySelectorAll('#qList .q')];
    cards.forEach((c, i) => c.style.animationDelay = Math.min(i, 8) * 30 + 'ms');
    await animateOut([...cards, ...document.querySelectorAll('.sel')], 200 + Math.min(cards.length, 8) * 30);
    S.questions = []; afterQChange();
  });
  $('#previewBtn').addEventListener('click', () => exportPdf(true));
  $('#buildBtn').addEventListener('click', () => exportPdf(false));

  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault(); $('#undoBtn').click();
    } else if (answerPop && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Cevap penceresi açıkken A-E tuşları cevabı seçer, Enter/Esc geçer.
      const L = e.key.toUpperCase();
      if (LETTERS.includes(L)) { e.preventDefault(); setPopupAnswer(L); }
      else if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); closeAnswerPopup(); }
    }
  });

  // Sürükle-bırak
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropHint').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  });

  let lastW = $('#viewer').clientWidth, rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const w = $('#viewer').clientWidth;
      if (Math.abs(w - lastW) > 40) { lastW = w; renderViewer(); }
    }, 250);
  });
}

/* ---------- Başlangıç ---------- */
async function init() {
  bindUi();
  bindSettings();
  requestAnimationFrame(() => moveIndicator($('.tabs')));
  renderTabs();
  renderQList();
  renderViewer();
  // Önceki çalışmayı geri yükle (kayıt kullanılamazsa uygulama yine çalışır).
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB zaman aşımı')), 4000));
    await Promise.race([DB.open(), timeout]);
    const [docs, state] = await Promise.all([DB.get('docs'), DB.get('state')]);
    if (state) {
      Object.assign(S.settings, state.settings || {});
      S.settings.marginPreset = Object.keys(MARGINS).find(p => MARGINS[p] === S.settings.margin) || 'ozel';
      S.zoom = state.zoom || 1;
      syncSettingsInputs();
    }
    if (docs?.length) {
      busy(true, 'Önceki çalışman yükleniyor…');
      for (const d of docs) {
        try { await openPdfBytes(d.name, d.bytes, d.id); } catch (err) { console.warn('restore failed', d.name, err); }
      }
      const ids = new Set(S.docs.map(d => d.id));
      S.questions = (state?.questions || []).filter(q => ids.has(q.docId));
      S.questions.forEach(q => enterIds.add(q.id));
      S.activeDoc = ids.has(state?.activeDoc) ? state.activeDoc : S.docs[0]?.id || null;
      busy(false);
    }
  } catch (err) {
    console.warn('Kayıt kullanılamıyor:', err);
    busy(false);
    return;
  }
  renderTabs();
  renderQList();
  await renderViewer();
  enterIds.clear();
}

init();

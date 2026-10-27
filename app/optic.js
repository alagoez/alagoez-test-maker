'use strict';
/* Alagoez Test Maker — Optik cevap formu (OMR) üretici.
 *
 * Tasarım ilkeleri (OMR form tasarım rehberleri):
 *  - Kabarcık yüksekliği 10–14 pt; kabarcıklar birbirine değmez, aralarında çizgi/çerçeve yoktur.
 *  - Okunan alanlar siyah mürekkeple basılır; gölgelendirme yalnızca çok açık gri ve kabarcık dışında.
 *  - Dört köşede tarama (çapa) işareti: dolu kareler, biri yön bulmak için daha büyük, çevresi boş.
 *  - Sorular 5'li gruplar hâlinde, numaralar kabarcıkların solunda ve hizalı.
 *
 * Bu dosya app.js'ten önce yüklenir; buradaki fonksiyonlar yalnızca çağrıldıklarında
 * app.js içindeki yardımcıları (S, textImage, canvasBytes, toast, busy) kullanır.
 */

const OPTIC = {
  page: [595.28, 841.89],                    // optik form her zaman A4 dikey basılır
  anchor: 20, anchorTL: 26, anchorInset: 16, // köşe işaretleri (pt); sol üst yön için büyük
  large: { d: 13, px: 19, py: 17.5 },        // az soruda rahat düzen
  normal: { d: 11, px: 16, py: 14.5 },       // kabarcık çapı, yatay ve dikey adım (pt)
  compact: { d: 9.8, px: 13.6, py: 12.6 },   // çok soru sığdırmak için sıkı düzen
  groupGap: 4,                               // 5'li gruplar arası ek boşluk
  numW: 20,                                  // soru numarası sütunu
  colGap: 16,                                // cevap sütunları arası
  digitPitch: 15,                            // öğrenci no sütun adımı
};
const OPTIC_INK = PDFLib.rgb(0.07, 0.07, 0.07);
const OPTIC_GRAY = PDFLib.rgb(0.52, 0.52, 0.52);
const OPTIC_LINE = PDFLib.rgb(0.76, 0.76, 0.76);
const OPTIC_SOFT = PDFLib.rgb(0.94, 0.94, 0.94);
const OPTIC_FONT = 'Jost, Arial, sans-serif';

/* ---------- Ayarlardan türeyen değerler ---------- */
function opticCount() {
  const c = Math.round(+S.settings.opticCount || 0);
  return Math.min(200, c > 0 ? c : (S.questions.length || 20));
}
const opticLetters = () => ['A', 'B', 'C', 'D', 'E'].slice(0, +S.settings.opticChoices === 4 ? 4 : 5);
const opticBooklets = () => ({ AB: ['A', 'B'], ABCD: ['A', 'B', 'C', 'D'] }[S.settings.opticBooklet] || []);

/* ---------- Metin görüntüleri (Türkçe karakterler için) ---------- */
async function oText(ctx, text, o = {}) {
  const size = o.size || 8, weight = o.weight || 500, color = o.color || '#111111', sp = o.spacing || 0;
  const key = [text, size, weight, color, sp, o.maxW || 0].join('|');
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const m = document.createElement('canvas').getContext('2d');
  const setFont = (g, s) => { g.font = `${weight} ${s}px ${OPTIC_FONT}`; if ('letterSpacing' in g) g.letterSpacing = sp + 'px'; };
  setFont(m, size);
  let w = Math.ceil(m.measureText(text).width) + 2, s = size;
  if (o.maxW && w > o.maxW) { s = size * (o.maxW - 2) / (w - 2); w = Math.ceil(o.maxW); }
  const h = Math.ceil(s * 1.32);
  const img = await textImage(ctx.out, w, h, g => { setFont(g, s); g.fillStyle = color; g.fillText(text, 1, s); });
  const r = { img, w, h };
  ctx.cache.set(key, r);
  return r;
}

// Kelimelere göre satır kaydıran paragraf görüntüsü
async function oPara(ctx, text, width, size, color = '#555555') {
  const key = ['para', text, width, size, color].join('|');
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const m = document.createElement('canvas').getContext('2d');
  m.font = `400 ${size}px ${OPTIC_FONT}`;
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? line + ' ' + word : word;
      if (m.measureText(t).width > width && line) { lines.push(line); line = word; } else line = t;
    }
    lines.push(line);
  }
  const lh = size * 1.45, h = Math.ceil(lines.length * lh + size * 0.3);
  const img = await textImage(ctx.out, width, h, g => {
    g.font = `400 ${size}px ${OPTIC_FONT}`; g.fillStyle = color;
    lines.forEach((l, i) => g.fillText(l, 0, size + i * lh));
  });
  const r = { img, w: width, h };
  ctx.cache.set(key, r);
  return r;
}

/* ---------- Cevap ızgarası ölçüleri ---------- */
function gridHeight(rows, met) {
  return 14 + rows * met.py + Math.max(0, Math.ceil(rows / 5) - 1) * OPTIC.groupGap;
}
function gridFit(aw, ah, choices, met) {
  const colW = OPTIC.numW + choices * met.px + OPTIC.colGap;
  const cols = Math.max(1, Math.floor((aw + OPTIC.colGap) / colW));
  let rows = 0;
  while (gridHeight(rows + 1, met) <= ah) rows++;
  const rows5 = rows >= 5 ? rows - (rows % 5) : rows;
  return { cols, rows5, colW, capacity: cols * rows5 };
}

/* ---------- Form geometrisi (çizmeden önce ölçülür) ---------- */
function formGeometry(box, set) {
  const L = 44, R = box.w - 44, top = 50, bottom = box.h - 46;
  const half = box.h < 500;
  const digits = Math.max(0, Math.min(10, +set.opticDigits || 0));
  const LP = Math.max(150, digits * OPTIC.digitPitch + 6);
  const bodyTop = top + 46;
  const footerTop = bottom - (half ? 26 : 30);
  const ax0 = L + LP + 24, aw = R - ax0, ah = footerTop - 10 - bodyTop;
  return { L, R, top, bottom, half, digits, LP, bodyTop, footerTop, ax0, aw, ah };
}

/* ---------- Çizim yardımcıları ---------- */
function roundRectPath(w, h, r) {
  return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} `
    + `H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}

// Tek bir optik formu verilen kutuya çizer.
async function drawOpticForm(ctx, page, box, part) {
  const set = S.settings, f = ctx.fonts, letters = opticLetters();
  const g = formGeometry(box, set);
  const X = x => box.x + x;          // kutu içi x → sayfa x
  const Y = yTop => box.y + box.h - yTop; // kutu içi üstten y → sayfa y
  const img = (r, x, yTop) => page.drawImage(r.img, { x: X(x), y: Y(yTop + r.h), width: r.w, height: r.h });
  const label = async (text, x, yTop) => img(await oText(ctx, text, { size: 6.8, weight: 600, color: '#6b6b6b', spacing: 1.1 }), x, yTop);
  const box2 = (x, yTop, w, h, r = 4) => page.drawSvgPath(roundRectPath(w, h, r), { x: X(x), y: Y(yTop), borderColor: OPTIC_LINE, borderWidth: 0.7 });
  const bubble = (cx, cy, d, letter, filled) => {
    page.drawCircle({ x: X(cx), y: Y(cy), size: d / 2, borderColor: OPTIC_INK, borderWidth: 0.75, color: filled ? OPTIC_INK : undefined });
    if (letter && !filled) {
      const s = d * 0.5;
      page.drawText(letter, { x: X(cx) - f.bold.widthOfTextAtSize(letter, s) / 2, y: Y(cy) - s * 0.36, size: s, font: f.bold, color: OPTIC_GRAY });
    }
  };

  // Köşe (çapa) işaretleri
  const ai = OPTIC.anchorInset, a = OPTIC.anchor, aTL = OPTIC.anchorTL;
  page.drawRectangle({ x: X(ai), y: Y(ai + aTL), width: aTL, height: aTL, color: OPTIC_INK });
  page.drawRectangle({ x: X(box.w - ai - a), y: Y(ai + a), width: a, height: a, color: OPTIC_INK });
  page.drawRectangle({ x: X(ai), y: Y(box.h - ai), width: a, height: a, color: OPTIC_INK });
  page.drawRectangle({ x: X(box.w - ai - a), y: Y(box.h - ai), width: a, height: a, color: OPTIC_INK });

  // Başlık
  const title = ctx.key ? 'OPTİK CEVAP ANAHTARI' : 'OPTİK CEVAP FORMU';
  img(await oText(ctx, title, { size: 14, weight: 700, color: '#0a0a0a', spacing: 2 }), g.L, g.top - 2);
  const sub = [set.school.trim(), [set.title.trim(), set.examName.trim()].filter(Boolean).join(' – ')].filter(Boolean).join('   ·   ');
  if (sub) img(await oText(ctx, sub, { size: 8.5, weight: 400, color: '#555555', maxW: g.R - g.L - 150 }), g.L, g.top + 20);
  const meta = `${part.total} SORU  ·  ${letters[0]}–${letters[letters.length - 1]}${part.pages > 1 ? `  ·  SAYFA ${part.index + 1} / ${part.pages}` : ''}`;
  const mr = await oText(ctx, meta, { size: 7, weight: 600, color: '#6b6b6b', spacing: 1.2 });
  img(mr, g.R - mr.w, g.top + 2);
  if (ctx.key) {
    const kr = await oText(ctx, 'ÖĞRETMEN NÜSHASI', { size: 7, weight: 700, color: '#ffffff', spacing: 1.4 });
    const bw = kr.w + 14, by = g.top + 15;
    page.drawSvgPath(roundRectPath(bw, 15, 7.5), { x: X(g.R - bw), y: Y(by), color: OPTIC_INK });
    img(kr, g.R - bw + 7, by + (15 - kr.h) / 2 + 0.5);
  }
  page.drawLine({ start: { x: X(g.L), y: Y(g.top + 36) }, end: { x: X(g.R), y: Y(g.top + 36) }, thickness: 0.6, color: OPTIC_LINE });

  // Sol panel: kimlik alanları
  let ly = g.bodyTop;
  const panelBottom = g.footerTop - 6;
  await label('ADI SOYADI', g.L, ly); ly += 11;
  box2(g.L, ly, g.LP, 24);
  if (ctx.key) img(await oText(ctx, 'CEVAP ANAHTARI', { size: 9, weight: 600, color: '#111111', spacing: 1 }), g.L + 8, ly + 6);
  ly += 24 + 10;

  const met = part.met;
  const booklets = opticBooklets();
  const bkD = Math.min(met.d + 1, 13), bkPitch = bkD + 7;
  // Yarım sayfada yer dar: sınıf kutusu ile kitapçık türü yan yana durur.
  const sideBySide = g.half && booklets.length > 0;
  const classW = sideBySide ? g.LP - (booklets.length * bkPitch + 14) : g.LP;
  await label('SINIFI / ŞUBE', g.L, ly);
  if (sideBySide) await label('KİTAPÇIK', g.L + classW + 14, ly);
  ly += 11;
  box2(g.L, ly, classW, 22);
  if (set.className.trim()) img(await oText(ctx, set.className.trim(), { size: 9.5, weight: 600, color: '#111111', maxW: classW - 16 }), g.L + 8, ly + 5);
  if (sideBySide) booklets.forEach((b, i) => bubble(g.L + classW + 14 + bkD / 2 + 1 + i * bkPitch, ly + 11, bkD, b, false));
  ly += 22 + 10;

  const bookletH = booklets.length && !sideBySide ? 11 + bkD + 12 : 0;
  const exampleH = 11 + 14 + 6;
  if (g.digits) {
    // Öğrenci numarası: yazma kutuları + 0–9 kodlama ızgarası
    let dp = Math.min(met.py, 15);
    const fixed = 11 + 15 + 6 + bookletH + 4;
    if (ly + fixed + 10 * dp > panelBottom) dp = Math.max(10.6, (panelBottom - ly - fixed) / 10);
    const dd = Math.min(met.d, dp - 1.8, OPTIC.digitPitch - 4); // komşu kabarcıklar değmesin
    await label('ÖĞRENCİ NUMARASI', g.L, ly); ly += 11;
    for (let c = 0; c < g.digits; c++) box2(g.L + c * OPTIC.digitPitch + 1, ly, OPTIC.digitPitch - 2, 15, 2.5);
    ly += 15 + 6;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < g.digits; c++) {
        bubble(g.L + c * OPTIC.digitPitch + OPTIC.digitPitch / 2, ly + r * dp + dp / 2, dd, String(r), false);
      }
    }
    ly += 10 * dp + 8;
  }
  if (bookletH && ly + bookletH <= panelBottom + 4) {
    await label('KİTAPÇIK TÜRÜ', g.L, ly); ly += 11;
    booklets.forEach((b, i) => bubble(g.L + bkD / 2 + 1 + i * bkPitch, ly + bkD / 2 + 1, bkD, b, false));
    ly += bkD + 12;
  }
  if (ly + exampleH <= panelBottom) {
    // Kodlama örneği: doğru / yanlış
    await label('KODLAMA ÖRNEĞİ', g.L, ly); ly += 12;
    const d = 10, cy = ly + d / 2 + 1;
    bubble(g.L + d / 2 + 1, cy, d, '', true);
    img(await oText(ctx, 'Doğru', { size: 8, weight: 600, color: '#111111' }), g.L + d + 6, cy - 6);
    let x = g.L + 62;
    const wrong = [
      'M -2.8 0.2 L -0.8 2.6 L 3 -2.6',                 // tik
      'M -2.6 -2.6 L 2.6 2.6 M 2.6 -2.6 L -2.6 2.6',     // çarpı
    ];
    for (const p of wrong) {
      bubble(x + d / 2, cy, d, '', false);
      page.drawSvgPath(p, { x: X(x + d / 2), y: Y(cy), borderColor: OPTIC_INK, borderWidth: 1.1 });
      x += d + 4;
    }
    bubble(x + d / 2, cy, d, '', false);   // yarım doldurulmuş
    page.drawSvgPath(`M 0 -${d / 2} A ${d / 2} ${d / 2} 0 0 1 0 ${d / 2} Z`, { x: X(x + d / 2), y: Y(cy), color: OPTIC_INK });
    x += d + 6;
    img(await oText(ctx, 'Yanlış', { size: 8, weight: 600, color: '#111111' }), x, cy - 6);
  }

  // Cevap ızgarası
  const n = part.count, choices = letters.length;
  const cols = Math.min(part.grid.cols, Math.ceil(n / Math.max(1, part.grid.rows5)));
  const rowsPerCol = Math.min(part.grid.rows5, Math.ceil(Math.ceil(n / cols) / 5) * 5);
  const stride = Math.min(part.grid.colW * 1.45, (g.aw + OPTIC.colGap) / cols);
  for (let c = 0; c < cols; c++) {
    const x0 = g.ax0 + c * stride;
    const first = c * rowsPerCol;
    if (first >= n) break;
    // Şık harfleri başlığı
    letters.forEach((L, k) => {
      const s = 7.2, cx = x0 + OPTIC.numW + k * met.px + met.px / 2;
      page.drawText(L, { x: X(cx) - f.bold.widthOfTextAtSize(L, s) / 2, y: Y(g.bodyTop + 9), size: s, font: f.bold, color: OPTIC_GRAY });
    });
    const ry0 = g.bodyTop + 14;
    for (let i = 0; i < rowsPerCol && first + i < n; i++) {
      const qi = part.start + first + i;
      const grp = Math.floor(i / 5);
      const yTop = ry0 + i * met.py + grp * OPTIC.groupGap;
      if (i % 5 === 0 && grp % 2 === 1) {
        const rows = Math.min(5, n - first - i);
        page.drawRectangle({ x: X(x0 - 2), y: Y(yTop + rows * met.py), width: OPTIC.numW - 3, height: rows * met.py, color: OPTIC_SOFT });
      }
      const cy = yTop + met.py / 2;
      const no = String(S.settings.startNo + qi);
      page.drawText(no, { x: X(x0 + OPTIC.numW - 5) - f.bold.widthOfTextAtSize(no, 8) , y: Y(cy) - 2.9, size: 8, font: f.bold, color: OPTIC_INK });
      const ans = ctx.key ? (S.questions[qi]?.answer || '') : '';
      letters.forEach((L, k) => bubble(x0 + OPTIC.numW + k * met.px + met.px / 2, cy, met.d, L, ans === L));
    }
  }

  // Yönerge ve alt bilgi
  const guide = g.half
    ? 'Kodlamaları 2B kurşun kalemle, kabarcığı tamamen ve koyu doldurarak yapınız. Her soruda tek şık işaretleyiniz; birden fazla işaret boş sayılır. Formu katlamayınız.'
    : 'Kodlamaları 2B kurşun kalemle, kabarcığı tamamen ve koyu doldurarak yapınız. Her soruda yalnızca bir şık işaretleyiniz; birden fazla işaretlenen soru boş sayılır.\nDeğiştirmek istediğiniz işareti iz kalmayacak şekilde siliniz. Formu katlamayınız, buruşturmayınız.';
  page.drawLine({ start: { x: X(g.L), y: Y(g.footerTop - 4) }, end: { x: X(g.R), y: Y(g.footerTop - 4) }, thickness: 0.5, color: OPTIC_LINE });
  img(await oPara(ctx, guide, g.R - g.L - 90, 6.6), g.L, g.footerTop + 1);
  const brand = await oText(ctx, 'alagoez test maker', { size: 6.5, weight: 500, color: '#9a9a9a', spacing: 1.6 });
  img(brand, g.R - brand.w, g.footerTop + 3);
}

/* ---------- Sayfalara yerleştirme ---------- */
// Optik form sayfalarını belgeye ekler ve eklenen sayfaları döndürür.
async function addOpticPages(out, { key = false } = {}) {
  try { await document.fonts?.ready; } catch { /* yazı tipi beklenemezse varsayılanla devam */ }
  const set = S.settings;
  const [PW, PH] = OPTIC.page;
  const ctx = {
    out, key, cache: new Map(),
    fonts: { bold: await out.embedFont(PDFLib.StandardFonts.HelveticaBold) },
  };
  const n = opticCount(), choices = opticLetters().length;

  // Kaç form gerekiyor? Önce yarım sayfa (istenmişse), sığmazsa tam sayfa; önce normal, sonra sıkı düzen.
  const plan = per => {
    const box = per === 2 ? { x: 0, y: PH / 2, w: PW, h: PH / 2 } : { x: 0, y: 0, w: PW, h: PH };
    const g = formGeometry(box, set);
    for (const met of [OPTIC.large, OPTIC.normal, OPTIC.compact]) {
      const grid = gridFit(g.aw, g.ah, choices, met);
      if (grid.capacity >= n || met === OPTIC.compact) return { per, met, grid, pages: Math.ceil(n / Math.max(1, grid.capacity)) };
    }
  };
  let p = plan(!key && +set.opticPerPage === 2 ? 2 : 1);
  if (p.per === 2 && p.pages > 1) p = plan(1); // yarım sayfaya sığmıyorsa tam sayfaya geç

  const pages = [];
  for (let k = 0; k < p.pages; k++) {
    const start = k * p.grid.capacity;
    const part = { start, count: Math.min(p.grid.capacity, n - start), total: n, index: k, pages: p.pages, met: p.met, grid: p.grid };
    const page = out.addPage([PW, PH]);
    pages.push(page);
    if (p.per === 2) {
      await drawOpticForm(ctx, page, { x: 0, y: PH / 2, w: PW, h: PH / 2 }, part);
      await drawOpticForm(ctx, page, { x: 0, y: 0, w: PW, h: PH / 2 }, part);
      page.drawLine({ start: { x: 0, y: PH / 2 }, end: { x: PW, y: PH / 2 }, thickness: 0.6, color: OPTIC_LINE, dashArray: [5, 4] });
      const cut = await oText(ctx, '✂  buradan kesiniz', { size: 6.5, weight: 500, color: '#8a8a8a', spacing: 1 });
      page.drawRectangle({ x: PW / 2 - cut.w / 2 - 6, y: PH / 2 - cut.h / 2, width: cut.w + 12, height: cut.h, color: PDFLib.rgb(1, 1, 1) });
      page.drawImage(cut.img, { x: PW / 2 - cut.w / 2, y: PH / 2 - cut.h / 2, width: cut.w, height: cut.h });
    } else {
      await drawOpticForm(ctx, page, { x: 0, y: 0, w: PW, h: PH }, part);
    }
  }
  return pages;
}

// Yalnızca optik formdan oluşan PDF (çoğaltıp dağıtmak için)
async function buildOpticPdf() {
  const out = await PDFLib.PDFDocument.create();
  out.setTitle('Optik Cevap Formu');
  out.setCreator('Alagoez Test Maker');
  await addOpticPages(out);
  return out.save();
}

async function downloadOptic() {
  busy(true, 'Optik form hazırlanıyor…');
  try {
    const bytes = await buildOpticPdf();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = ((S.settings.title.trim() || 'test') + ' - optik form').replace(/[\\/:*?"<>|]+/g, '-') + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`Optik form hazır: ${opticCount()} soru.`);
  } catch (err) {
    console.error(err);
    toast('Optik form oluşturulamadı: ' + err.message, 5000);
  } finally {
    busy(false);
  }
}

/* ---------- Ayarlar panelindeki canlı önizleme ---------- */
let opticPreviewTimer = 0, opticPreviewGen = 0;
function scheduleOpticPreview() {
  clearTimeout(opticPreviewTimer);
  opticPreviewTimer = setTimeout(renderOpticPreview, 280);
}
async function renderOpticPreview() {
  const hint = document.getElementById('opticCountHint');
  if (hint) {
    const auto = !(+S.settings.opticCount > 0);
    hint.textContent = !auto
      ? `${opticCount()} soruluk form basılacak.`
      : S.questions.length
        ? `Otomatik: seçtiğin ${S.questions.length} soruya göre ${opticCount()} soruluk form.`
        : `Henüz soru seçmedin; şimdilik ${opticCount()} soruluk form gösteriliyor.`;
  }
  const wrap = document.getElementById('opticPreview');
  const panel = document.getElementById('setPanel');
  if (!wrap || !S.settings.optic || panel?.hidden) return;
  const gen = ++opticPreviewGen;
  wrap.classList.add('loading');
  try {
    const bytes = await buildOpticPdf();
    if (gen !== opticPreviewGen) return;
    // pdf.js veriyi devralır; indirme/büyütme için kopyasını ver
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const pg = await pdf.getPage(1);
    const cv = document.getElementById('opticCanvas');
    const cssW = wrap.clientWidth || 300;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1) * 1.4;
    const vp = pg.getViewport({ scale: (cssW / pg.getViewport({ scale: 1 }).width) * dpr });
    const tmp = document.createElement('canvas');
    tmp.width = Math.floor(vp.width); tmp.height = Math.floor(vp.height);
    await pg.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
    if (gen !== opticPreviewGen) return;
    cv.width = tmp.width; cv.height = tmp.height;
    cv.getContext('2d').drawImage(tmp, 0, 0);
    wrap._bytes = bytes;
    pdf.destroy();
  } catch (err) {
    console.warn('optik önizleme', err);
  } finally {
    if (gen === opticPreviewGen) wrap.classList.remove('loading');
  }
}

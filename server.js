const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3002;
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ limit: '5mb', type: 'text/html' }));

// === IN-MEMORY APP HTML ===
let appHtml = '<h1>Presupuestos Pro</h1><p>Cargando app... POST /api/set-app para subir la app.</p>';
// Try to load from disk on startup
try {
  const f = path.join(__dirname, 'index.html');
  if (fs.existsSync(f)) { appHtml = fs.readFileSync(f, 'utf8'); console.log('Loaded index.html from disk'); }
} catch(e) {}

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', server: 'whitelabel-api', version: '1.4.0' });
});

app.get('/', (req, res) => {
  res.type('html').send(appHtml);
});

// === UPLOAD APP HTML ===
app.post('/api/set-app', (req, res) => {
  try {
    const html = req.body;
    if (!html || html.length < 100) return res.status(400).json({ error: 'HTML demasiado corto' });
    appHtml = html;
    try { fs.writeFileSync(path.join(__dirname, 'index.html'), html, 'utf8'); } catch(e) {}
    console.log('APP HTML updated: ' + html.length + ' chars');
    res.json({ ok: true, size: html.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// === HELPER: download image as base64 ===
async function downloadImageAsBase64(imageUrl, refererUrl) {
  try {
    if (!imageUrl) return null;
    if (imageUrl.startsWith('data:') && imageUrl.length > 200) return imageUrl;
    if (imageUrl.startsWith('data:')) return null;
    console.log('  DL: ' + imageUrl.substring(0, 150));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(imageUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': refererUrl || imageUrl
      }
    });
    clearTimeout(timeout);
    if (!resp.ok) { console.warn('  FAIL HTTP ' + resp.status); return null; }
    const ct = resp.headers.get('content-type') || 'image/png';
    const ab = await resp.arrayBuffer();
    if (ab.byteLength < 100) { console.warn('  FAIL too small'); return null; }
    console.log('  OK ' + ct + ' ' + Math.round(ab.byteLength/1024) + 'KB');
    return 'data:' + ct + ';base64,' + Buffer.from(ab).toString('base64');
  } catch (e) { console.warn('  FAIL ' + e.message); return null; }
}

function resolveUrl(src, baseUrl) {
  if (!src) return '';
  if (src.startsWith('data:')) return src;
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/')) return baseUrl + src;
  if (src.startsWith('http')) return src;
  return baseUrl + '/' + src;
}

app.post('/api/proxy-image', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const base64 = await downloadImageAsBase64(url, url);
    if (!base64) return res.status(404).json({ error: 'No se pudo descargar' });
    res.json({ base64 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// === AI CONFIG ===
app.post('/api/ai-config', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY no configurada' });
    console.log('\n=== AI-CONFIG: ' + url + ' ===');

    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    let baseUrl = fullUrl;
    try { baseUrl = new URL(fullUrl).origin; } catch(e) {}

    // 1. Download page
    let rawHtml = '', pageText = '';
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(fullUrl, { signal: ctrl.signal, redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      });
      clearTimeout(to);
      rawHtml = await r.text();
      console.log('HTML: ' + rawHtml.length + ' chars');
      pageText = rawHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
    } catch(e) { console.warn('Page fetch failed: ' + e.message); pageText = 'No se pudo acceder a ' + url; }

    // 2. Extract ALL images: <img> tags + CSS background-images + data-bg
    let allImgs = [], logoUrl = '', bgImages = [], allPhotos = [];
    if (rawHtml) {
      // --- IMG tags (with data-src, data-lazy-src, srcset support) ---
      const imgRe = /<img[^>]*>/gi;
      let m;
      while ((m = imgRe.exec(rawHtml)) !== null) {
        const tag = m[0];
        const src = (tag.match(/\bsrc=["']([^"']+)["']/i)||[])[1]||'';
        const dataSrc = (tag.match(/\bdata-src=["']([^"']+)["']/i)||[])[1]||'';
        const dataLazy = (tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)||[])[1]||'';
        const dataOrig = (tag.match(/\bdata-original=["']([^"']+)["']/i)||[])[1]||'';
        const srcset = (tag.match(/\bsrcset=["']([^"']+)["']/i)||[])[1]||'';
        const dataSrcset = (tag.match(/\bdata-srcset=["']([^"']+)["']/i)||[])[1]||'';
        // Pick best source: prefer data-src over placeholder src
        let best = src;
        if (!best || best.includes('data:image/svg') || best.includes('placeholder') || best.includes('blank.gif')) {
          best = dataSrc || dataLazy || dataOrig || '';
        }
        if (!best && (srcset || dataSrcset)) {
          const ss = (dataSrcset || srcset).split(',')[0].trim().split(' ')[0];
          if (ss) best = ss;
        }
        if (!best) continue;
        best = resolveUrl(best, baseUrl);
        if (best.includes('pixel') || best.includes('track') || best.includes('1x1')) continue;
        if (best.startsWith('data:') && best.length < 200) continue;
        const alt = (tag.match(/\balt=["']([^"']*)["']/i)||[])[1]||'';
        const cls = (tag.match(/\bclass=["']([^"']*)["']/i)||[])[1]||'';
        const id = (tag.match(/\bid=["']([^"']*)["']/i)||[])[1]||'';
        allImgs.push({ src: best, alt, class: cls, id });
      }
      console.log('IMG tags found: ' + allImgs.length);

      // --- CSS background-image URLs from inline styles ---
      const bgRe = /background(?:-image)?\s*:[^;]*url\(["']?([^"')]+)["']?\)/gi;
      let bgM;
      while ((bgM = bgRe.exec(rawHtml)) !== null) {
        let bgSrc = resolveUrl(bgM[1], baseUrl);
        if (bgSrc && !bgSrc.includes('gradient') && !bgSrc.includes('data:image/svg') && bgSrc.match(/\.(jpg|jpeg|png|webp|avif)/i)) {
          bgImages.push(bgSrc);
        }
      }
      // --- data-bg and data-bg-multi (used by some lazy load plugins) ---
      const dataBgRe = /data-bg=["']([^"']+)["']/gi;
      while ((bgM = dataBgRe.exec(rawHtml)) !== null) {
        bgImages.push(resolveUrl(bgM[1], baseUrl));
      }
      // --- Elementor data-settings with background_image ---
      const settingsRe = /data-settings='([^']+)'/gi;
      while ((bgM = settingsRe.exec(rawHtml)) !== null) {
        try {
          const s = JSON.parse(bgM[1].replace(/&quot;/g,'"'));
          if (s.background_image && s.background_image.url) bgImages.push(s.background_image.url);
        } catch(e) {}
      }
      console.log('CSS/data-bg images found: ' + bgImages.length);

      // --- Detect logo ---
      const logoPats = [
        i => /logo/i.test(i.id),
        i => /logo/i.test(i.src),
        i => /logo/i.test(i.alt) || /logo/i.test(i.class),
        i => /brand|marca|custom-logo|site-logo/i.test(i.class),
        i => /wp-image/i.test(i.class) && /header/i.test(i.class),
      ];
      for (const p of logoPats) {
        const f = allImgs.find(p);
        if (f) { logoUrl = f.src; console.log('Logo via pattern: ' + logoUrl.substring(0,120)); break; }
      }
      if (!logoUrl) {
        const hm = rawHtml.match(/<header[\s\S]*?<\/header>/i);
        if (hm) {
          const hi = hm[0].match(/(?:data-src|src)=["']([^"']+(?:logo|brand)[^"']*)["']/i)
            || hm[0].match(/(?:data-src|src)=["'](https?:\/\/[^"']+\.(?:png|jpg|jpeg|svg|webp))["']/i);
          if (hi) { logoUrl = resolveUrl(hi[1], baseUrl); console.log('Logo in header: ' + logoUrl.substring(0,120)); }
        }
      }
      if (!logoUrl) {
        const ogImg = rawHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || rawHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (ogImg) { logoUrl = resolveUrl(ogImg[1], baseUrl); console.log('Logo via og:image: ' + logoUrl.substring(0,120)); }
      }
      if (!logoUrl) {
        const fm = rawHtml.match(/<link[^>]+rel=["'](?:icon|apple-touch-icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/i)
          || rawHtml.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:icon|apple-touch-icon)["']/i);
        if (fm) { logoUrl = resolveUrl(fm[1], baseUrl); console.log('Logo via favicon: ' + logoUrl.substring(0,120)); }
      }
      console.log('LOGO: ' + (logoUrl || 'NONE'));

      // --- Company photos: combine img tags + bg images, exclude logo ---
      allPhotos = allImgs
        .filter(i => i.src !== logoUrl)
        .filter(i => !i.src.includes('icon') && !i.src.includes('favicon') && !i.src.includes('emoji') && !i.src.includes('avatar'))
        .filter(i => !i.src.includes('advert') && !i.src.includes('widget') && !i.src.includes('logo'))
        .filter(i => !i.src.startsWith('data:'))
        .filter(i => i.src.match(/\.(jpg|jpeg|png|webp|avif)/i) || i.src.includes('wp-content/uploads') || i.src.includes('image'))
        .map(i => i.src);
      // Add CSS background images too
      bgImages.forEach(bg => {
        if (!allPhotos.includes(bg) && bg !== logoUrl) allPhotos.push(bg);
      });
      // Remove duplicates
      allPhotos = [...new Set(allPhotos)];
    }
    const images = allPhotos.slice(0, 6);
    console.log('Final photos: ' + images.length);
    images.forEach((img, i) => console.log('  [' + i + '] ' + img.substring(0, 120)));

    // 3. CSS colors
    let cssColors = [];
    if (rawHtml) {
      const cm2 = rawHtml.match(/#[0-9a-fA-F]{6}/g)||[];
      const cc = {};
      cm2.forEach(c => { const l=c.toLowerCase(); if(['#ffffff','#000000','#f5f5f5','#333333','#e5e5e5','#cccccc','#eeeeee','#f8f8f8','#fafafa'].includes(l))return; cc[l]=(cc[l]||0)+1; });
      cssColors = Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
    }

    // 4. OpenAI
    const oRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_KEY},
      body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.2, response_format:{type:'json_object'},
        messages:[
          { role:'system', content:'Extrae datos de empresa de servicios desde su web. JSON: {"companyName":"","brandName":"","cif":"","phone":"","email":"","address":"","website":"'+url+'","slogan":"","sector":"mudanzas|limpiezas|reformas|instalaciones|jardineria|eventos|general","services":[],"zones":[],"colors":{"primary":"#hex","accent":"#hex"},"contractClauses":[],"legalText":""}. Sector DEBE ser uno de los listados. Colores CSS: '+cssColors.join(', ') },
          { role:'user', content:'Analiza: '+url+'\n\n'+pageText }
        ]
      })
    });
    if (!oRes.ok) { const e=await oRes.text(); return res.status(502).json({error:'Error IA',details:e}); }
    const aiData = await oRes.json();
    const result = JSON.parse(aiData.choices[0].message.content);

    result.logoUrl = logoUrl || '';
    result.images = images;
    result.cssColors = cssColors;

    // 5. Download as base64
    console.log('\n--- Downloading base64 ---');
    result.logoBase64 = logoUrl ? (await downloadImageAsBase64(logoUrl, fullUrl)) || '' : '';
    console.log('Logo: ' + (result.logoBase64 ? 'OK' : 'NONE'));

    result.imagesBase64 = [];
    for (let i = 0; i < Math.min(images.length, 3); i++) {
      const b64 = await downloadImageAsBase64(images[i], fullUrl);
      result.imagesBase64.push(b64 || '');
      console.log('Img' + (i+1) + ': ' + (b64 ? 'OK' : 'FAIL'));
    }

    console.log('=== DONE: ' + (result.companyName||url) + ' | Logo:' + (result.logoBase64?'YES':'NO') + ' | Photos:' + result.imagesBase64.filter(Boolean).length + ' ===\n');
    res.json(result);
  } catch(err) {
    console.error('AI-CONFIG ERROR:', err.message);
    res.status(500).json({ error:'Error interno', details:err.message });
  }
});

app.listen(PORT, () => {
  console.log('WHITELABEL API v1.4.0 | Port:' + PORT + ' | OpenAI:' + (process.env.OPENAI_API_KEY?'OK':'MISSING'));
});

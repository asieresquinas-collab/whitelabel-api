const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3002;
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/ping', (req, res) => { res.json({ status: 'ok', server: 'whitelabel-api', version: '1.1.0' }); });
app.get('/', (req, res) => { res.send('<h1>WhiteLabel API Server v1.1</h1><p>Endpoints: POST /api/ai-config | GET /api/proxy-image?url=... | GET /api/ping</p>'); });

// ═══ PROXY DE IMAGENES (evita CORS) ═══
app.get('/api/proxy-image', async (req, res) => {
  try {
    const imgUrl = req.query.url;
    if (!imgUrl) return res.status(400).json({ error: 'url param required' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(imgUrl, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeout);
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch image' });
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') || 'image/png';
    const base64 = 'data:' + contentType + ';base64,' + buffer.toString('base64');
    res.json({ base64, contentType, size: buffer.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══ AI CONFIG ═══
app.post('/api/ai-config', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY no configurada' });
    console.log('/api/ai-config - Analizando: ' + url);
    let baseUrl = url;
    try { const u = new URL(url.startsWith('http') ? url : 'https://' + url); baseUrl = u.origin; } catch(e) {}

    let rawHtml = '', pageText = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url.startsWith('http') ? url : 'https://' + url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      clearTimeout(timeout);
      rawHtml = await resp.text();
      pageText = rawHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
    } catch(e) { pageText = 'No se pudo acceder a ' + url; }

    // Extraer imagenes del HTML
    let images = [], logoUrl = '';
    if (rawHtml) {
      const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi; let m; const all = [];
      while ((m = re.exec(rawHtml)) !== null) {
        let s = m[1];
        if (s.startsWith('//')) s = 'https:' + s;
        else if (s.startsWith('/')) s = baseUrl + s;
        else if (!s.startsWith('http') && !s.startsWith('data:')) s = baseUrl + '/' + s;
        if (s.includes('pixel') || s.includes('track') || s.includes('1x1')) continue;
        if (s.startsWith('data:') && s.length < 200) continue;
        const alt = (m[0].match(/alt=["']([^"']*)["']/i)||[])[1]||'';
        const cls = (m[0].match(/class=["']([^"']*)["']/i)||[])[1]||'';
        all.push({ src: s, alt, class: cls });
      }
      // Detectar logo
      for (const p of [i=>/logo/i.test(i.alt)||/logo/i.test(i.class)||/logo/i.test(i.src), i=>/brand|marca|header/i.test(i.class)]) {
        const f = all.find(p); if (f) { logoUrl = f.src; break; }
      }
      if (!logoUrl) {
        const hm = rawHtml.match(/<header[\s\S]*?<\/header>/i);
        if (hm) { const hi = hm[0].match(/<img[^>]+src=["']([^"']+)["']/i); if (hi) { let s=hi[1]; if(s.startsWith('//'))s='https:'+s; else if(s.startsWith('/'))s=baseUrl+s; else if(!s.startsWith('http'))s=baseUrl+'/'+s; logoUrl=s; } }
      }
      if (!logoUrl) {
        const fm = rawHtml.match(/<link[^>]+rel=["'](?:icon|apple-touch-icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/i) || rawHtml.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:icon|apple-touch-icon)["']/i);
        if (fm) { let s=fm[1]; if(s.startsWith('//'))s='https:'+s; else if(s.startsWith('/'))s=baseUrl+s; else if(!s.startsWith('http'))s=baseUrl+'/'+s; logoUrl=s; }
      }
      images = all.filter(i=>i.src!==logoUrl).filter(i=>!i.src.includes('icon')&&!i.src.includes('favicon')).filter(i=>i.src.match(/\.(jpg|jpeg|png|webp)/i)||i.src.includes('image')).slice(0,6).map(i=>i.src);
    }

    // Extraer colores CSS
    let cssColors = [];
    if (rawHtml) {
      const cm = rawHtml.match(/#[0-9a-fA-F]{6}/g)||[];
      const cc = {}; cm.forEach(c => { const l=c.toLowerCase(); if(['#ffffff','#000000','#f5f5f5','#333333','#e5e5e5','#cccccc','#eeeeee'].includes(l))return; cc[l]=(cc[l]||0)+1; });
      cssColors = Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
    }

    // ═══ DESCARGAR LOGO E IMAGENES COMO BASE64 DESDE EL SERVIDOR ═══
    let logoBase64 = '';
    if (logoUrl) {
      try {
        const r = await fetch(logoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); const ct = r.headers.get('content-type')||'image/png'; logoBase64 = 'data:'+ct+';base64,'+buf.toString('base64'); }
      } catch(e) { console.warn('No se pudo descargar logo:', e.message); }
    }

    let imagesBase64 = [];
    for (const imgSrc of images.slice(0,3)) {
      try {
        const r = await fetch(imgSrc, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); const ct = r.headers.get('content-type')||'image/jpeg'; imagesBase64.push('data:'+ct+';base64,'+buf.toString('base64')); }
      } catch(e) {}
    }

    // Llamar a OpenAI
    const oRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Extrae datos de empresa de servicios desde su web. JSON: {"companyName":"","brandName":"","cif":"","phone":"","email":"","address":"","website":"'+url+'","slogan":"","sector":"mudanzas|limpiezas|reformas|instalaciones|jardineria|eventos|general","services":[],"zones":[],"colors":{"primary":"#hex","accent":"#hex"},"contractClauses":[],"legalText":""}. Sector DEBE ser uno de los listados. Colores CSS encontrados: '+cssColors.join(', ') },
          { role: 'user', content: 'Analiza: '+url+'\n\n'+pageText }
        ]
      })
    });
    if (!oRes.ok) { const e = await oRes.text(); return res.status(502).json({ error: 'Error IA', details: e }); }
    const aiData = await oRes.json();
    const result = JSON.parse(aiData.choices[0].message.content);

    // Incluir todo en la respuesta
    result.logoUrl = logoUrl || '';
    result.logoBase64 = logoBase64;
    result.images = images;
    result.imagesBase64 = imagesBase64;
    result.cssColors = cssColors;

    console.log('/api/ai-config OK - ' + (result.companyName || url) + ' | Logo:' + (logoBase64?'SI':'NO') + ' | Fotos:' + imagesBase64.length);
    res.json(result);
  } catch(err) {
    console.error('/api/ai-config error:', err.message);
    res.status(500).json({ error: 'Error interno', details: err.message });
  }
});

app.listen(PORT, () => { console.log('WHITELABEL API v1.1 - Port:' + PORT + ' | OpenAI:' + (process.env.OPENAI_API_KEY ? 'OK' : 'FALTA')); });const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3002;
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.get('/api/ping', (req, res) => { res.json({ status: 'ok', server: 'whitelabel-api', version: '1.0.0' }); });
app.get('/', (req, res) => { res.send('<h1>WhiteLabel API Server v1.0</h1>'); });
app.post('/api/ai-config', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY no configurada' });
    let baseUrl = url;
    try { const u = new URL(url.startsWith('http') ? url : 'https://' + url); baseUrl = u.origin; } catch(e) {}
    let rawHtml = '', pageText = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url.startsWith('http') ? url : 'https://' + url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(timeout);
      rawHtml = await resp.text();
      pageText = rawHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
    } catch(e) { pageText = 'No se pudo acceder a ' + url; }
    let images = [], logoUrl = '';
    if (rawHtml) {
      const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi; let m; const all = [];
      while ((m = re.exec(rawHtml)) !== null) { let s=m[1]; if(s.startsWith('//'))s='https:'+s; else if(s.startsWith('/'))s=baseUrl+s; else if(!s.startsWith('http')&&!s.startsWith('data:'))s=baseUrl+'/'+s; if(s.includes('pixel')||s.includes('track'))continue; const a=(m[0].match(/alt=["']([^"']*)["']/i)||[])[1]||''; const c=(m[0].match(/class=["']([^"']*)["']/i)||[])[1]||''; all.push({src:s,alt:a,class:c}); }
      for(const p of [i=>/logo/i.test(i.alt)||/logo/i.test(i.src),i=>/brand|header/i.test(i.class)]){const f=all.find(p);if(f){logoUrl=f.src;break;}}
      images=all.filter(i=>i.src!==logoUrl&&!i.src.includes('icon')).filter(i=>i.src.match(/\.(jpg|jpeg|png|webp)/i)).slice(0,6).map(i=>i.src);
    }
    let cssColors = [];
    if (rawHtml) { const cm=rawHtml.match(/#[0-9a-fA-F]{6}/g)||[]; const cc={}; cm.forEach(c=>{const l=c.toLowerCase();if(['#ffffff','#000000','#f5f5f5','#333333'].includes(l))return;cc[l]=(cc[l]||0)+1;}); cssColors=Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]); }
    const oRes = await fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_KEY}, body:JSON.stringify({model:'gpt-4o-mini',temperature:0.2,response_format:{type:'json_object'},messages:[{role:'system',content:'Extrae datos empresa. JSON: {"companyName":"","brandName":"","cif":"","phone":"","email":"","address":"","website":"'+url+'","slogan":"","sector":"mudanzas|limpiezas|reformas|instalaciones|jardineria|eventos|general","services":[],"zones":[],"colors":{"primary":"","accent":""},"contractClauses":[],"legalText":""}. Colores CSS: '+cssColors.join(',')},{role:'user',content:'Web: '+url+'\n'+pageText}]}) });
    if(!oRes.ok){const e=await oRes.text();return res.status(502).json({error:'Error IA',details:e});}
    const aiData=await oRes.json(); const result=JSON.parse(aiData.choices[0].message.content);
    result.logoUrl=logoUrl||''; result.images=images; result.cssColors=cssColors;
    res.json(result);
  } catch(err) { res.status(500).json({error:'Error interno',details:err.message}); }
});
app.listen(PORT, () => { console.log('WHITELABEL API v1.0 - Port:'+PORT); });

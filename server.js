const express = require('express');
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

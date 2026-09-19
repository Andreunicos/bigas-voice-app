/* =====================================================================
 * BIGAS VOICE — o porteiro do servidor de mídia (Cloudflare Worker)
 * ---------------------------------------------------------------------
 * O servidor de mídia (Cloudflare Realtime SFU) exige um segredo pra
 * criar sessões e faixas. Esse segredo NÃO pode ficar no app (o app é
 * público). Então este Worker guarda tudo e só repassa pedidos de quem
 * prova que está logado no Bigas Voice (token do Firebase, assinatura
 * conferida com as chaves públicas do Google).
 *
 * E ele é o FREIO: conta o tráfego do mês (pelo lado de cima — sempre a
 * banda máxima, nunca a média) e, chegando no teto, APAGA o app de mídia
 * na Cloudflare pela API. Sem app, não existe tráfego, não existe conta.
 * No mês seguinte cria outro sozinho.
 *
 * O que precisa no Worker (Settings › Variables and Secrets):
 *   CF_ACCOUNT_ID     — o "Account ID" da conta Cloudflare (Text)
 *   CF_API_TOKEN      — token com permissão Calls/Realtime: Edit (Secret)
 *   (ou, no lugar dos dois de cima, um app criado à mão no painel:)
 *   SFU_APP_ID        — "ID do aplicativo" (Text)
 *   SFU_APP_SECRET    — o "Token de API" do aplicativo (Secret)
 *   Com os dois pares, o porteiro usa o app à mão e consegue APAGÁ-LO no teto.
 *   FIREBASE_PROJETO  — bigas-voice (Text)
 *   TETO_GB           — opcional, padrão 700 (Text)
 * E um KV (Settings › Bindings › KV namespace) com o nome USO.
 *
 * Rotas (todas com  Authorization: Bearer <token do Firebase>, menos /saude):
 *   GET  /saude                         → { ok, app, gbMes, teto, morto }
 *   POST /sessao                        → { sessionId }
 *   POST /sessao/:id/faixas  {..., mbps} → repassa pro SFU; guarda mbps por faixa
 *   PUT  /sessao/:id/renegociar         → repassa
 *   PUT  /sessao/:id/fechar             → repassa
 *   POST /pulso  { faixas: ["sess/nome", ...] }  → quem ASSISTE avisa a cada
 *        5 min o que está puxando; o porteiro soma 5 min × banda máxima
 * ================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const API = 'https://api.cloudflare.com/client/v4';
const SFU = 'https://rtc.live.cloudflare.com/v1/apps/';
const PULSO_MIN = 5;          // pior caso, quando o pulso não traz os bytes (site antigo pulsava a cada 5 min)
const MBPS_PADRAO = 12.2;     // se a faixa não disse a banda: o máximo que o app pede (nitidez extra) + som
const TETO_POR_PULSO_GB = 0.6; // um pulso de 2 min a 20 Mbps dá 0,3 GB por faixa; acima disso é conta furada, não tráfego

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
}
function mesAtual() { const d = new Date(); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

/* ---- conferir o token do Firebase (RS256, chaves públicas do Google) ---- */
let chavesCache = { quando: 0, chaves: {} };
async function chavesDoGoogle() {
  if (Date.now() - chavesCache.quando < 6 * 3600 * 1000 && Object.keys(chavesCache.chaves).length) return chavesCache.chaves;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const j = await r.json();
  const chaves = {};
  for (const k of j.keys || []) chaves[k.kid] = k;
  chavesCache = { quando: Date.now(), chaves };
  return chaves;
}
function b64uParaBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function conferirToken(token, projeto) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) return null;
  const cab = JSON.parse(new TextDecoder().decode(b64uParaBytes(partes[0])));
  const corpo = JSON.parse(new TextDecoder().decode(b64uParaBytes(partes[1])));
  if (cab.alg !== 'RS256' || !cab.kid) return null;
  const chaves = await chavesDoGoogle();
  const jwk = chaves[cab.kid];
  if (!jwk) return null;
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', chave, b64uParaBytes(partes[2]), new TextEncoder().encode(partes[0] + '.' + partes[1]));
  if (!ok) return null;
  const agora = Math.floor(Date.now() / 1000);
  if (corpo.exp < agora || corpo.aud !== projeto || corpo.iss !== 'https://securetoken.google.com/' + projeto || !corpo.sub) return null;
  return corpo.sub; // o uid
}

/* ---- freio por conta: no máximo N pedidos por minuto ---- */
const freio = new Map();
function passaNoFreio(uid) {
  const agora = Date.now();
  const f = freio.get(uid) || { desde: agora, n: 0 };
  if (agora - f.desde > 60000) { f.desde = agora; f.n = 0; }
  f.n++; freio.set(uid, f);
  return f.n <= 120;
}

/* ---- o app de mídia na Cloudflare: criar / apagar pela API ---- */
async function apiCf(env, metodo, caminho, corpo) {
  const r = await fetch(API + '/accounts/' + env.CF_ACCOUNT_ID + caminho, {
    method: metodo,
    headers: { 'Authorization': 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error('API Cloudflare ' + r.status + ': ' + JSON.stringify(j.errors || j).slice(0, 200));
  return j.result;
}
async function appDeMidia(env) {
  const mes = mesAtual();
  if (await env.USO.get('morto:' + mes)) return null;           // este mês bateu no teto: sem app até virar o mês
  const guardado = await env.USO.get('app', 'json');
  if (guardado && guardado.uid && guardado.secret) return guardado;
  // um app criado à mão no painel (SFU_APP_ID / SFU_APP_SECRET) serve como o primeiro
  if (env.SFU_APP_ID && env.SFU_APP_SECRET) {
    const app = { uid: env.SFU_APP_ID, secret: env.SFU_APP_SECRET, criadoEm: Date.now(), manual: true };
    await env.USO.put('app', JSON.stringify(app));
    return app;
  }
  // não tem: cria um (nome com o mês, pra ficar claro no painel)
  const r = await apiCf(env, 'POST', '/calls/apps', { name: 'bigas-voice ' + mes });
  const app = { uid: r.uid, secret: r.secret, criadoEm: Date.now() };
  await env.USO.put('app', JSON.stringify(app));
  return app;
}
async function matarAppDeMidia(env, motivo) {
  const app = await env.USO.get('app', 'json');
  // com o token da API, o app é APAGADO de verdade (tráfego zero); sem ele, só para de aceitar gente nova
  if (app && app.uid && env.CF_ACCOUNT_ID && env.CF_API_TOKEN) { try { await apiCf(env, 'DELETE', '/calls/apps/' + app.uid); } catch (e) { console.log('apagar app', e.message); } }
  await env.USO.delete('app');
  await env.USO.put('morto:' + mesAtual(), motivo || 'teto');
}

/* ---- o contador do mês (por conta, por dia: sem corrida de escrita) ---- */
async function gbDoMes(env) {
  const mes = mesAtual();
  let total = 0, cursor = undefined;
  do {
    const l = await env.USO.list({ prefix: 'uso:' + mes + ':', cursor });
    for (const k of l.keys) total += Number(k.metadata && k.metadata.gb) || 0;
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return total;
}
async function somarUso(env, uid, gb) {
  const d = new Date();
  const chave = 'uso:' + mesAtual() + ':' + uid + ':' + d.getUTCDate();
  const atual = Number((await env.USO.get(chave)) || 0) + gb;
  await env.USO.put(chave, String(atual), { metadata: { gb: atual }, expirationTtl: 40 * 86400 });
  return atual;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const teto = Number(env.TETO_GB) || 700;
    if (url.pathname === '/saude') {
      const app = await env.USO.get('app', 'json').catch(() => null);
      return json({ ok: true, app: !!(app && app.uid), gbMes: Math.round((await gbDoMes(env).catch(() => 0)) * 10) / 10, teto, morto: !!(await env.USO.get('morto:' + mesAtual())) });
    }
    if (!env.USO) return json({ erro: 'porteiro sem o KV USO' }, 500);
    if (!(env.CF_ACCOUNT_ID && env.CF_API_TOKEN) && !(env.SFU_APP_ID && env.SFU_APP_SECRET)) return json({ erro: 'porteiro sem CF_ACCOUNT_ID+CF_API_TOKEN nem SFU_APP_ID+SFU_APP_SECRET' }, 500);

    const auth = req.headers.get('Authorization') || '';
    const uid = await conferirToken(auth.replace(/^Bearer\s+/i, ''), env.FIREBASE_PROJETO || 'bigas-voice').catch(() => null);
    if (!uid) return json({ erro: 'sem conta' }, 401);
    if (!passaNoFreio(uid)) return json({ erro: 'devagar' }, 429);

    // quem assiste avisa o que está puxando. Se mandar os BYTES que recebeu
    // desde o último pulso (o navegador conta), vale o número real + 5% de
    // folga. Sem bytes (site antigo), vale o pior caso: 2 min × banda máxima.
    let m;
    if (req.method === 'POST' && url.pathname === '/pulso') {
      const corpo = await req.json().catch(() => ({}));
      const faixas = Array.isArray(corpo.faixas) ? corpo.faixas.slice(0, 20) : [];
      let gb = 0;
      if (Number.isFinite(Number(corpo.bytes)) && corpo.bytes !== null && corpo.bytes !== undefined) {
        gb = Math.min(TETO_POR_PULSO_GB * Math.max(1, faixas.length), Math.max(0, Number(corpo.bytes)) / 1e9 * 1.05);
      } else {
        for (const f of faixas) {
          const mbps = Number(await env.USO.get('mbps:' + f)) || MBPS_PADRAO;
          gb += mbps * 1.15 * 60 * PULSO_MIN / 8 / 1000;   // Mbps → GB em 5 min, com 15% de folga
        }
      }
      if (gb > 0) await somarUso(env, uid, gb);
      const total = await gbDoMes(env);
      if (total >= teto) { await matarAppDeMidia(env, 'teto de ' + teto + ' GB'); return json({ ok: false, morto: true, gbMes: total }); }
      return json({ ok: true, gbMes: Math.round(total * 10) / 10, teto });
    }

    const app = await appDeMidia(env).catch((e) => ({ erro: e.message }));
    if (!app) return json({ erro: 'servidor de mídia desligado este mês (teto de tráfego)', morto: true }, 503);
    if (app.erro) return json({ erro: app.erro }, 500);
    const base = SFU + app.uid;
    const cab = { 'Authorization': 'Bearer ' + app.secret, 'Content-Type': 'application/json' };
    const repassar = async (metodo, rota, corpo) => {
      const r = await fetch(base + rota, { method: metodo, headers: cab, body: corpo });
      return new Response(await r.text(), { status: r.status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
    };
    const corpo = req.method === 'GET' ? undefined : await req.text();

    if (req.method === 'POST' && url.pathname === '/sessao') return repassar('POST', '/sessions/new');
    if (req.method === 'POST' && (m = /^\/sessao\/([A-Za-z0-9_-]+)\/faixas$/.exec(url.pathname))) {
      // quem PUBLICA diz a banda máxima da faixa (o app manda em "mbps"); fica guardada pro contador
      try {
        const j = JSON.parse(corpo || '{}');
        for (const t of j.tracks || []) if (t.location === 'local' && t.trackName && Number(j.mbps) > 0) await env.USO.put('mbps:' + m[1] + '/' + t.trackName, String(Math.min(30, Number(j.mbps))), { expirationTtl: 86400 });
        delete j.mbps;
        return repassar('POST', '/sessions/' + m[1] + '/tracks/new', JSON.stringify(j));
      } catch { return json({ erro: 'corpo inválido' }, 400); }
    }
    if (req.method === 'PUT' && (m = /^\/sessao\/([A-Za-z0-9_-]+)\/renegociar$/.exec(url.pathname))) return repassar('PUT', '/sessions/' + m[1] + '/renegotiate', corpo);
    if (req.method === 'PUT' && (m = /^\/sessao\/([A-Za-z0-9_-]+)\/fechar$/.exec(url.pathname))) return repassar('PUT', '/sessions/' + m[1] + '/tracks/close', corpo);
    return json({ erro: 'rota desconhecida' }, 404);
  },
};

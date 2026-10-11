/**
 * Verificador de Duração – addon Stremio para Cloudflare Workers
 *  1. O Stremio pede os streams a este addon (/stream/...).
 *  2. Ele lê SOZINHO a lista de addons da conta do Stremio (login em /configure) e busca os streams só nos
 *     addons que têm "stream". Ficam de fora: este próprio verificador, o Controle de Impróprios (guia dos pais)
 *     e os addons que só têm catálogo/metadados.
 *  3. Cada link direto (http/https) é reescrito para apontar para ESTE Worker (/play/...). Torrents passam sem alteração.
 *     Testes: duração (TMDB), tamanho do arquivo x duração, título gravado no MKV, reconhecimento pelo OpenSubtitles
 *     (OPENSUBTITLES_KEY melhora muito) e nome do arquivo.
 *  4. A lista devolvida ao Stremio traz SÓ os vídeos que passaram no teste: o que o teste reprova (duração diferente
 *     do TMDB, arquivo reconhecido como outro título, nome do arquivo com outro filme/episódio, título não lançado)
 *     é REMOVIDO da lista. O que não deu para medir continua aparecendo e, se for escolhido, é conferido em /play/.
 *  5. TROCA DE ID: este addon responde também pelo META (/meta/...). Ele pega o meta do próximo addon da conta que tenha
 *     meta (abaixo dele na ordem; ex.: Controle de Impróprios, AIOMetadata), troca os ids tt... por vrf:tt... (episódios; nos
 *     filmes também o id e o defaultVideoId) e assim o Stremio só pede os streams a ELE (os outros addons não entendem vrf:).
 *     Ids que não começam com tt (ex.: os que o Controle de Impróprios trocou) não são mexidos.
 *     Instale este addon NO TOPO da lista de addons (o meta vale do primeiro addon que responde).
 *
 * A duração é lida do cabeçalho do arquivo por pedidos Range (MP4/MOV pelo átomo moov/mvhd; MKV/WebM pelo
 * Info/Duration; HLS pela soma dos trechos). O que não dá para medir é conferido pelo NOME do arquivo e, se nada
 * indicar erro, passa.
 *
 * Variáveis (Settings > Variables and Secrets) OU entradas de mesmo nome no KV ligado como "KV":
 *   TMDB_KEY (obrigatória)   SECRET (recomendada; sem ela usa a TMDB_KEY)   PUBLIC_URL (opcional)
 *   INCORRETOS (opcional): ocultar (padrão, remove da lista) | marcar (só renomeia) | bloquear (aparece, mas não toca)
 *   TOLERANCIA (padrão 0.20; séries ×1.5)   TOLERANCIA_MIN (padrão 10)   FFPROBE_TIMEOUT (padrão 8000 ms; vale para a leitura)
 *   ATRASO_STREAM_MS (padrão 3000 ms; espera antes de consultar os streams de origem; intervalo 0–10000)
 *   ID_FILME (opcional): trocar (padrão: troca o id e o defaultVideoId do filme) | dica (só o defaultVideoId)
 *   CONTROLE (opcional, ligação de serviço): liga este Worker ao Worker do Controle de Impróprios. A Cloudflare não deixa um
 *   Worker chamar outro pelo endereço workers.dev (erro 1042); com a ligação o meta do Controle é lido por dentro.
 */
const SELF_ID = 'community.verificador.duracao';
const STREMIO_API = 'https://api.strem.io/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TTL = 24 * 3600 * 1000;

// addons que NUNCA entram como origem de vídeos (além dos que não têm "stream")
const RE_PROPRIO = /verificador de dura[cç][aã]o|^\s*autenticado\s*$/i; // nome antigo e o nome atual do addon
const RE_PARENTAL = /controle de impr[oó]prios?|guia dos pais|parents?[ _-]?guide|parental|classifica[cç][aã]o indicativa|content[ _-]?(advisory|rating|warning)|age[ _-]?(rating|gate|block)/i;

let TMDB_KEY = '';
let PUBLIC_URL = '';
let SECRET = '';
let KV = null;
let TOL = 0.20;
let TOL_MIN = 10;
const MIN_KBPS = 100; // abaixo disso o arquivo é pequeno demais para a duração (trailer/placeholder)
let TIMEOUT = 8000;
let ORCAMENTO_MS = 8000;
let MAX_SONDAS = 12;
let ATRASO_STREAM_MS = 3000; // espera antes de consultar os addons de origem
let OS_KEY = '';
let MODO = 'ocultar'; // ocultar | marcar | bloquear
let MODO_FILME = 'trocar'; // trocar | dica
let CONTROLE_BIND = null; // ligação de serviço com o Controle de Impróprios (opcional)

async function carregarConfig(env) {
  KV = env.KV || null;
  const ler = async (nome) => {
    let v = String(env[nome] || '').trim();
    if (!v && KV) { try { v = String((await KV.get(nome, { cacheTtl: 300 })) || '').trim(); } catch {} }
    return v;
  };
  TMDB_KEY = await ler('TMDB_KEY');
  PUBLIC_URL = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  SECRET = (await ler('SECRET')) || TMDB_KEY;
  TOL = Number(env.TOLERANCIA || 0.20);
  TOL_MIN = Number(env.TOLERANCIA_MIN || 10);
  TIMEOUT = Number(env.FFPROBE_TIMEOUT || 8000);
  ORCAMENTO_MS = Number(env.VERIFICACAO_MS || 8000);
  MAX_SONDAS = Number(env.MAX_SONDAS || 12);
  const atrasoBruto = await ler('ATRASO_STREAM_MS');
  const atrasoNumerico = atrasoBruto === '' ? 3000 : Number(atrasoBruto);
  ATRASO_STREAM_MS = Number.isFinite(atrasoNumerico) ? Math.max(0, Math.min(10000, Math.floor(atrasoNumerico))) : 3000;
  OS_KEY = await ler('OPENSUBTITLES_KEY');
  const modo = String((await ler('INCORRETOS')) || '').toLowerCase();
  MODO = ['ocultar', 'marcar', 'bloquear'].includes(modo) ? modo : (String(env.BLOQUEAR_INCORRETOS || '') === '0' ? 'marcar' : 'ocultar');
  MODO_FILME = String((await ler('ID_FILME')) || '').toLowerCase() === 'dica' ? 'dica' : 'trocar';
  CONTROLE_BIND = env.CONTROLE && typeof env.CONTROLE.fetch === 'function' ? env.CONTROLE : null;
}

// ---------- links assinados (impede usar o Worker para abrir endereços quaisquer) ----------
const te = new TextEncoder();
const td = new TextDecoder();
function bytesParaB64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uParaBytes(str) {
  let b = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}
let chaveHmac = null;
let chaveDoSegredo = '';
async function getChave() {
  if (!chaveHmac || chaveDoSegredo !== SECRET) {
    chaveHmac = await crypto.subtle.importKey('raw', te.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    chaveDoSegredo = SECRET;
  }
  return chaveHmac;
}
async function criarToken(obj) {
  const p = bytesParaB64u(te.encode(JSON.stringify(obj)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await getChave(), te.encode(p)));
  return p + '.' + bytesParaB64u(sig);
}
async function lerToken(tok) {
  const [p, sig] = String(tok || '').split('.');
  if (!p || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await getChave(), b64uParaBytes(sig), te.encode(p));
    return ok ? JSON.parse(td.decode(b64uParaBytes(p))) : null;
  } catch { return null; }
}

// ---------- caches (memória do Worker + KV, se ligado) ----------
const mem = { runtime: new Map(), vered: new Map(), os: new Map(), streams: new Map() };
async function hashCurto(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
  return Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function cLer(tipo, chave) {
  const m = mem[tipo];
  const e = m.get(chave);
  if (e && Date.now() - e.t < TTL) return e.v;
  if (e) m.delete(chave);
  if (KV) {
    try {
      const w = await KV.get(`${tipo}:${await hashCurto(chave)}`, 'json');
      if (w) { m.set(chave, { v: w.v, t: Date.now() }); return w.v; }
    } catch {}
  }
  return undefined;
}
async function cGravar(tipo, chave, v) {
  const m = mem[tipo];
  if (m.size >= 3000) m.clear();
  m.set(chave, { v, t: Date.now() });
  if (KV) {
    try { await KV.put(`${tipo}:${await hashCurto(chave)}`, JSON.stringify({ v }), { expirationTtl: 24 * 3600 }); } catch {}
  }
}

// Funções auxiliares para cache rápida da lista completa de streams (TTL de 5 minutos)
async function cLerStream(chave) {
  const m = mem.streams;
  const e = m.get(chave);
  if (e && Date.now() - e.t < 5 * 60 * 1000) return e.v;
  if (e) m.delete(chave);
  return undefined;
}
async function cGravarStream(chave, v) {
  const m = mem.streams;
  if (m.size >= 1000) m.clear();
  m.set(chave, { v, t: Date.now() });
}

// ---------- TMDB: runtime em minutos ----------
async function tmdb(caminho, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + caminho);
  u.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let erro = null;
  for (let t = 0; t < 3; t++) {
    if (t) await new Promise((ok) => setTimeout(ok, t * 400));
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (r.ok) return await r.json();
      erro = new Error('TMDB ' + r.status);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      erro = e;
      if (e && e.name === 'TimeoutError') break;
    }
  }
  throw erro;
}

function partesDoId(id) {
  const [imdb, t, e] = String(id).split(':');
  return { imdb, temporada: Number(t) > 0 ? Number(t) : null, episodio: Number(e) > 0 ? Number(e) : null };
}

async function infoTMDB(id, tipo) {
  const c = await cLer('runtime', id + '|' + tipo);
  if (c !== undefined) return c && typeof c === 'object' ? c : { min: c, ano: null, titulos: [] };
  const { imdb, temporada, episodio } = partesDoId(id);
  const f = await tmdb(`/find/${imdb}`, { external_source: 'imdb_id' });
  let min = null;
  let ano = null;
  let titulos = [];
  let lancamento = '';
  if (tipo === 'movie') {
    const m = (f.movie_results || [])[0];
    if (m) {
      const det = await tmdb(`/movie/${m.id}`, { language: 'pt-BR' });
      min = det.runtime || null;
      ano = parseInt(String(m.release_date || '').slice(0, 4), 10) || null;
      lancamento = String(m.release_date || '');
      titulos = [m.title, m.original_title, det.title].filter(Boolean);
    }
  } else {
    const sr = (f.tv_results || [])[0];
    if (sr) {
      titulos = [sr.name, sr.original_name].filter(Boolean);
      if (temporada && episodio) {
        try {
          const ep = await tmdb(`/tv/${sr.id}/season/${temporada}/episode/${episodio}`);
          min = ep.runtime || null;
          lancamento = String(ep.air_date || '');
        } catch { /* usa o geral */ }
      }
      if (!min) {
        const d = await tmdb(`/tv/${sr.id}`);
        min = (d.episode_run_time && d.episode_run_time[0]) || (d.last_episode_to_air && d.last_episode_to_air.runtime) || null;
      }
    }
  }
  const info = { min, ano, titulos, lancamento };
  await cGravar('runtime', id + '|' + tipo, info);
  return info;
}
async function runtimeMin(id, tipo) { return (await infoTMDB(id, tipo)).min; }

// ---------- duração do arquivo (substitui o ffprobe): lê só o cabeçalho com pedidos Range ----------
async function lerFaixa(url, ini, tam) {
  const r = await fetch(url, {
    headers: { Range: `bytes=${ini}-${ini + tam - 1}`, 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (r.status !== 206 && r.status !== 200) { try { await r.body.cancel(); } catch {} return null; }
  const semRange = r.status === 200; // o servidor ignorou o Range: o corpo começa no byte 0
  const cr = r.headers.get('content-range');
  const m = cr && cr.match(/\/(\d+)\s*$/);
  const total = m ? Number(m[1]) : (Number(r.headers.get('content-length')) || null);
  if (semRange && ini > 0) { try { await r.body.cancel(); } catch {} return { dados: null, total, semRange }; }
  const leitor = r.body.getReader();
  const partes = [];
  let lidos = 0;
  while (lidos < tam) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    lidos += value.length;
  }
  try { await leitor.cancel(); } catch {}
  const dados = new Uint8Array(Math.min(lidos, tam));
  let p = 0;
  for (const v of partes) {
    const n = Math.min(v.length, dados.length - p);
    if (n <= 0) break;
    dados.set(v.subarray(0, n), p);
    p += n;
  }
  return { dados, total, semRange };
}

function mvhdSegundos(c) {
  for (let i = 4; i + 4 <= c.length; i++) {
    if (c[i] === 0x6d && c[i + 1] === 0x76 && c[i + 2] === 0x68 && c[i + 3] === 0x64) { // 'mvhd'
      const b = i + 4;
      const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
      let escala;
      let dur;
      if (c[b] === 1) {
        if (b + 32 > c.length) return null;
        escala = dv.getUint32(b + 20);
        dur = Number(dv.getBigUint64(b + 24));
      } else {
        if (b + 20 > c.length) return null;
        escala = dv.getUint32(b + 12);
        dur = dv.getUint32(b + 16);
      }
      if (!escala || !dur || dur >= 0xFFFFFFFF) return null; // fragmentado/desconhecido
      return dur / escala;
    }
  }
  return null;
}

async function duracaoMP4(url, ini) {
  const d0 = ini.dados;
  const total = ini.total;
  const ler = async (off, tam) => {
    if (off < d0.length && (off + tam <= d0.length || (total != null && d0.length >= total))) return d0.subarray(off, Math.min(off + tam, d0.length));
    if (ini.semRange) return null; // sem Range não dá para pular até o moov
    const r = await lerFaixa(url, off, tam);
    return r && r.dados;
  };
  let off = 0;
  for (let n = 0; n < 12; n++) {
    const cab = await ler(off, 16);
    if (!cab || cab.length < 8) return null;
    const dv = new DataView(cab.buffer, cab.byteOffset, cab.byteLength);
    let tam = dv.getUint32(0);
    const tipo = String.fromCharCode(cab[4], cab[5], cab[6], cab[7]);
    if (tam === 1) {
      if (cab.length < 16) return null;
      tam = Number(dv.getBigUint64(8));
    } else if (tam === 0) {
      tam = total ? total - off : 0;
    }
    if (tipo === 'moov') {
      const corpo = await ler(off, Math.min(tam, 8192));
      return corpo ? mvhdSegundos(corpo) : null;
    }
    if (!(tam >= 8)) return null;
    off += tam;
    if (total && off >= total) return null;
  }
  return null;
}

function lerVint(d, p, ehId) {
  const b = d[p];
  if (b === undefined || b === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(b & mask)) { len++; mask >>= 1; }
  if (p + len > d.length) return null;
  let v = ehId ? b : (b & (mask - 1));
  let tudoUm = (b & (mask - 1)) === (mask - 1);
  for (let i = 1; i < len; i++) { v = v * 256 + d[p + i]; if (d[p + i] !== 0xFF) tudoUm = false; }
  return { v, len, desconhecido: !ehId && tudoUm };
}
function lerUint(bytes) { let v = 0; for (const b of bytes) v = v * 256 + b; return v; }

function infoMKV(d, ini, fim) {
  let escala = 1000000;
  let dur = null;
  let titulo = '';
  let p = ini;
  while (p < fim) {
    const id = lerVint(d, p, true);
    if (!id) break;
    p += id.len;
    const sz = lerVint(d, p, false);
    if (!sz) break;
    p += sz.len;
    const corpo = d.subarray(p, Math.min(p + sz.v, d.length));
    if (id.v === 0x2AD7B1) escala = lerUint(corpo);
    else if (id.v === 0x7BA9) { try { titulo = td.decode(corpo); } catch { /* ignora */ } }
    else if (id.v === 0x4489 && (corpo.length === 4 || corpo.length === 8)) {
      const dv = new DataView(corpo.buffer, corpo.byteOffset, corpo.byteLength);
      dur = corpo.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
    }
    p += sz.v;
  }
  return { seg: dur != null && Number.isFinite(dur) ? (dur * escala) / 1e9 : null, titulo };
}

function duracaoMKV(d) {
  let p = 0;
  while (p < d.length) {
    const id = lerVint(d, p, true);
    if (!id) return null;
    p += id.len;
    const sz = lerVint(d, p, false);
    if (!sz) return null;
    p += sz.len;
    if (id.v === 0x18538067) continue;                 // Segment: entra nos filhos
    if (id.v === 0x1549A966) return infoMKV(d, p, Math.min(p + sz.v, d.length)); // Info
    if (id.v === 0x1F43B675) return null;              // Cluster antes do Info
    if (sz.desconhecido) return null;
    p += sz.v;
  }
  return null;
}

async function lerTexto(url, max) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) { try { await r.body.cancel(); } catch {} return null; }
  const leitor = r.body.getReader();
  const partes = [];
  let lidos = 0;
  while (lidos < max) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    lidos += value.length;
  }
  try { await leitor.cancel(); } catch {}
  const tudo = new Uint8Array(lidos);
  let p = 0;
  for (const v of partes) { tudo.set(v, p); p += v.length; }
  return td.decode(tudo);
}

// HLS: soma a duração dos trechos (só playlist completa, com #EXT-X-ENDLIST); se for a lista mestre, usa a 1ª variante
async function duracaoHLS(url) {
  let texto = await lerTexto(url, 800000);
  for (let n = 0; n < 2 && texto && texto.includes('#EXT-X-STREAM-INF'); n++) {
    const linhas = texto.split(/\r?\n/);
    const k = linhas.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const uri = (linhas[k + 1] || '').trim();
    if (!uri || uri.startsWith('#')) return null;
    url = new URL(uri, url).href;
    texto = await lerTexto(url, 800000);
  }
  if (!texto || !texto.includes('#EXT-X-ENDLIST')) return null;
  let total = 0;
  for (const m of texto.matchAll(/#EXTINF:([\d.]+)/g)) total += parseFloat(m[1]);
  return total > 0 ? total : null;
}

// ---------- autenticidade por site externo: o OpenSubtitles identifica o arquivo pelo "hash" ----------
// hash = tamanho + soma (64 bits) dos primeiros e dos últimos 64 KB do arquivo
function hashOpenSubtitles(inicio, fim, tamanho) {
  let h = BigInt(tamanho);
  const soma = (d) => {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    for (let i = 0; i + 8 <= d.length; i += 8) h = (h + dv.getBigUint64(i, true)) & 0xFFFFFFFFFFFFFFFFn;
  };
  soma(inicio);
  soma(fim);
  return h.toString(16).padStart(16, '0');
}

async function hashDoArquivo(url) {
  const ini = await lerFaixa(url, 0, 65536);
  if (!ini || !ini.dados || ini.semRange || !ini.total || ini.total < 131072 || ini.dados.length < 65536) return null;
  const fim = await lerFaixa(url, ini.total - 65536, 65536);
  if (!fim || !fim.dados || fim.dados.length < 65536) return null;
  return { hash: hashOpenSubtitles(ini.dados, fim.dados, ini.total), tamanho: ini.total };
}

const ttDe = (n) => (n && Number(n) ? 'tt' + String(n).padStart(7, '0') : null);

const resumoOS = (a) => (a && a.length) ? a.slice(0, 3).map((x) => `${x.titulo || '?'} (${x.serie || x.imdb || '?'})`).join('; ') : 'hash desconhecido no OpenSubtitles';

// lista de títulos que o OpenSubtitles conhece para esse hash ([] = hash desconhecido; undefined = consulta falhou)
async function consultarOpenSubtitles(hash, tamanho) {
  const c = await cLer('os', hash);
  if (c !== undefined) { console.log(`[opensubtitles] ${hash} (cache): ${resumoOS(c)}`); return c; }
  let achados;
  try {
    if (OS_KEY) {
      const r = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?moviehash=${hash}`, {
        headers: { 'Api-Key': OS_KEY, 'User-Agent': 'VerificadorDuracao v1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) { console.log(`[opensubtitles] ${hash}: consulta falhou (HTTP ${r.status}, API nova)`); return undefined; }
      const j = await r.json();
      achados = (j.data || []).filter((x) => x.attributes && x.attributes.moviehash_match).map((x) => {
        const f = x.attributes.feature_details || {};
        return { imdb: ttDe(f.imdb_id), serie: ttDe(f.parent_imdb_id), titulo: f.movie_name || f.title || '' };
      });
    } else { // sem chave: endereço antigo do OpenSubtitles (pode ser desligado a qualquer momento)
      const r = await fetch(`https://rest.opensubtitles.org/search/moviebytesize-${tamanho}/moviehash-${hash}`, {
        headers: { 'X-User-Agent': 'TemporaryUserAgent', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) { console.log(`[opensubtitles] ${hash}: consulta falhou (HTTP ${r.status}, endereço antigo sem chave)`); return undefined; }
      const j = await r.json();
      achados = (Array.isArray(j) ? j : []).filter((x) => x.MatchedBy === 'moviehash').map((x) => ({
        imdb: ttDe(x.IDMovieImdb), serie: ttDe(x.SeriesIMDBParent), titulo: x.MovieName || '',
      }));
    }
  } catch (e) { console.log(`[opensubtitles] ${hash}: consulta falhou (${String((e && e.message) || e)})`); return undefined; }
  await cGravar('os', hash, achados);
  console.log(`[opensubtitles] ${hash}: ${resumoOS(achados)}`);
  return achados;
}

// compara o que o OpenSubtitles sabe sobre o hash com o título pedido
async function autenticidadePorHash(hash, tamanho, id) {
  const achados = await consultarOpenSubtitles(hash, tamanho);
  const POR = 'autenticidade, OpenSubtitles';
  if (!achados || !achados.length) { console.log(`[opensubtitles] ${id}: não verificado (${achados ? 'hash desconhecido' : 'consulta sem resposta'})`); return { status: 'nao_verificado' }; }
  const pedido = String(id).split(':')[0];
  console.log(`[opensubtitles] ${id}: pedido ${pedido}, OpenSubtitles diz ${resumoOS(achados)}`);
  if (achados.some((a) => a.imdb === pedido || a.serie === pedido)) return { status: 'ok', por: POR, texto: 'o arquivo é reconhecido como este título' };
  const a = achados.find((x) => x.imdb || x.serie);
  if (!a) return { status: 'nao_verificado' };
  return { status: 'errado', por: POR, texto: `este arquivo é conhecido como ${a.titulo ? `"${a.titulo}" ` : ''}(${a.serie || a.imdb}), não ${pedido}` };
}

async function autenticidadeDoLink(url, id) {
  try {
    const h = await hashDoArquivo(url);
    if (!h) { console.log(`[opensubtitles] ${id}: hash não calculado em ${hostDe(url)} (servidor sem Range ou arquivo pequeno)`); return { status: 'nao_verificado' }; }
    return await autenticidadePorHash(h.hash, h.tamanho, id);
  } catch { return { status: 'nao_verificado' }; }
}

// { min, total (bytes), titulo gravado } ou null se não deu para abrir o arquivo (min = null se a duração não foi lida)
async function duracaoArquivo(url) {
  try {
    const ini = await lerFaixa(url, 0, 65536);
    if (!ini || !ini.dados || ini.dados.length < 12) return null;
    const d = ini.dados;
    let seg = null;
    let titulo = '';
    let total = ini.total;
    if (d[0] === 0x23 && d[1] === 0x45 && d[2] === 0x58 && d[3] === 0x54 && d[4] === 0x4D && d[5] === 0x33 && d[6] === 0x55) { // '#EXTM3U' = HLS
      seg = await duracaoHLS(url);
      total = null;
    } else if (d[4] === 0x66 && d[5] === 0x74 && d[6] === 0x79 && d[7] === 0x70) { // 'ftyp' = MP4/MOV
      seg = await duracaoMP4(url, ini);
    } else if (d[0] === 0x1A && d[1] === 0x45 && d[2] === 0xDF && d[3] === 0xA3) { // EBML = MKV/WebM
      let r = duracaoMKV(d);
      if ((!r || r.seg == null) && d.length >= 65536) {
        const mais = await lerFaixa(url, 0, 524288);
        if (mais && mais.dados) r = duracaoMKV(mais.dados) || r;
      }
      if (r) { seg = r.seg; titulo = r.titulo || ''; }
    }
    return { min: Number.isFinite(seg) && seg > 0 ? seg / 60 : null, total: total || null, titulo };
  } catch { return null; }
}

// compara o título gravado dentro do arquivo (MKV) com os títulos do filme; devolve o motivo ou null
const PALAVRAS_VAZIAS = new Set(['the', 'and', 'for', 'dos', 'das', 'del', 'uma', 'com', 'que']);
const palavrasDe = (t) => normalizar(t).split(' ').filter((w) => w.length > 2 && !PALAVRAS_VAZIAS.has(w));
function checarTituloGravado(titulo, info) {
  const t = String(titulo || '').trim();
  if (t.length < 4 || !info) return null;
  // lixo de release (site, qualidade, codificador) não é título: não conta
  if (/www\.|https?:|\.(com|net|org|to|cc|tv)\b|encod|releas|\brip\b|x26[45]|1080p|720p|2160p|blu-?ray|web-?dl|yts|rarbg|torrent/i.test(t)) return null;
  const doArquivo = palavrasDe(t);
  const doFilme = new Set(palavrasDe((info.titulos || []).join(' ')));
  if (!doArquivo.length || !doFilme.size) return null;
  if (doArquivo.some((w) => doFilme.has(w))) return null;
  return `o título gravado no arquivo é "${t.slice(0, 60)}" e o filme é "${(info.titulos || [])[0] || ''}"`;
}

// 'ok' | 'errado' | 'nao_verificado'  (só "errado" impede o vídeo de abrir)
async function veredito({ u, i, t }, rtConhecido) {
  const chave = `${i}|${t}|${u}`;
  const c = await cLer('vered', chave);
  if (c) return c;
  if (!TMDB_KEY) return { status: 'nao_verificado' };
  let r;
  try {
    const [info, arq] = await Promise.all([infoTMDB(i, t).catch(() => null), duracaoArquivo(u)]);
    const rt = info ? info.min : (rtConhecido || null);
    const dur = arq && arq.min;
    const tit = t === 'movie' && arq ? checarTituloGravado(arq.titulo, info) : null;
    const kbps = dur && arq.total ? (arq.total * 8) / (dur * 60) / 1000 : null;
    if (tit) {
      r = { status: 'errado', por: 'título gravado no arquivo', texto: tit };
    } else if (kbps !== null && dur > 20 && kbps < MIN_KBPS) {
      r = { status: 'errado', por: 'tamanho do arquivo', texto: `só ${Math.round(arq.total / 1048576)} MB para ${Math.round(dur)} min: pequeno demais, provavelmente não é o filme` };
    } else if (rt && dur) {
      const folga = Math.max(rt * (t === 'series' ? TOL * 1.5 : TOL), TOL_MIN);
      if (Math.abs(dur - rt) > folga) {
        r = { status: 'errado', tmdbMin: rt, arquivoMin: Math.round(dur) };
      } else {
        const ext = await autenticidadeDoLink(u, i); // duração bate: confirma pelo reconhecimento do arquivo
        r = ext.status === 'errado' ? ext : { status: 'ok', tmdbMin: rt, arquivoMin: Math.round(dur) };
      }
    } else {
      const ext = dur ? null : await autenticidadeDoLink(u, i); // duração ilegível: pergunta ao site externo
      if (ext && ext.status !== 'nao_verificado') r = ext;
      else return { status: 'nao_verificado', tmdbMin: rt, arquivoMin: dur && Math.round(dur) };
    }
  } catch {
    return { status: 'nao_verificado' };
  }
  await cGravar('vered', chave, r); // falha passageira não fica guardada
  return r;
}

// ---------- lista de addons da conta do Stremio ----------
function lerConfigConta(b64) {
  if (!b64) return null;
  try {
    const j = JSON.parse(td.decode(b64uParaBytes(b64)));
    if (!j || typeof j !== 'object') return null;
    const a = (Array.isArray(j.a) ? j.a : [])
      .filter((x) => x && typeof x.u === 'string' && /^https?:\/\//i.test(x.u))
      .slice(0, 40)
      .map((x) => ({ n: String(x.n || hostDe(x.u)).slice(0, 60), u: limparUrl(x.u), types: Array.isArray(x.t) ? x.t : [], prefixes: Array.isArray(x.p) ? x.p : [] }));
    const k = typeof j.k === 'string' ? j.k : '';
    const fora = (Array.isArray(j.x) ? j.x : []).filter((u) => typeof u === 'string').slice(0, 80).map(limparUrl);
    return k || a.length ? { k, a, x: fora } : null;
  } catch { return null; }
}
const limparUrl = (u) => String(u || '').trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
function hostDe(u) { try { return new URL(u).hostname; } catch { return ''; } }

// devolve { types, prefixes } se o manifest tem o recurso "stream" (como texto ou como objeto), senão null
function recursoStream(m) {
  for (const r of (m.resources || [])) {
    if (typeof r === 'string') { if (r === 'stream') return { types: m.types || [], prefixes: m.idPrefixes || [] }; }
    else if (r && r.name === 'stream') return { types: r.types || m.types || [], prefixes: r.idPrefixes || m.idPrefixes || [] };
  }
  return null;
}

function recursoMeta(m) {
  for (const r of (m.resources || [])) {
    if (typeof r === 'string') { if (r === 'meta') return { types: m.types || [], prefixes: m.idPrefixes || [] }; }
    else if (r && r.name === 'meta') return { types: r.types || m.types || [], prefixes: r.idPrefixes || m.idPrefixes || [] };
  }
  return null;
}

// decide se o addon pode ser origem de vídeos: { rec } se sim, { ignorar: motivo } se não
function avaliarAddon(m) {
  if (!m) return { ignorar: 'inválido' };
  if (m.id === SELF_ID || RE_PROPRIO.test(m.name || '')) return { ignorar: 'é o próprio verificador' };
  if (RE_PARENTAL.test([m.id, m.name, m.description].join(' '))) return { ignorar: 'controle de impróprios' };
  const rec = recursoStream(m);
  if (!rec) return { ignorar: 'sem stream (só catálogo/metadados)' };
  return { rec };
}

const cacheContas = new Map();
async function addonsDaConta(authKey) {
  const hit = cacheContas.get(authKey);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.lista;
  const r = await fetch(`${STREMIO_API}/addonCollectionGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ type: 'AddonCollectionGet', authKey, update: true }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('Stremio HTTP ' + r.status);
  const j = await r.json();
  if (!j.result || !Array.isArray(j.result.addons)) throw new Error('sessão do Stremio inválida ou expirada (gere o link de novo em /configure)');
  const lista = [];
  const ignorados = [];
  const metas = [];
  const catalogos = [];
  let posSelf = -1;
  for (const [idx, a] of j.result.addons.entries()) {
    if (!a || !a.manifest || !/^https?:/i.test(a.transportUrl || '')) continue;
    const ehSelf = a.manifest.id === SELF_ID || RE_PROPRIO.test(a.manifest.name || '');
    if (ehSelf && posSelf < 0) posSelf = idx;
    const rm = ehSelf ? null : recursoMeta(a.manifest);
    const av = avaliarAddon(a.manifest);
    if (!ehSelf) { // um catálogo de filmes sem filtro obrigatório, só para o /diagnostico?catalogos=1
      const cat = (a.manifest.catalogs || []).find((c) => c && c.type === 'movie' && !(c.extra || []).some((e) => e && e.isRequired));
      if (cat) catalogos.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), id: cat.id, nome: cat.name || cat.id });
    }
    // fonte de meta: só quem NÃO é fonte de vídeos (addon
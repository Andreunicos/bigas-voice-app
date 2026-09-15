import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where,
  getDocs, onSnapshot, addDoc, serverTimestamp, limit, orderBy, runTransaction,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

/* A chave aqui embaixo NÃO é segredo — quem trava o acesso de verdade são
   as REGRAS do Firestore, do lado do servidor (firestore.rules). */
const firebaseConfig = {
  apiKey: 'AIzaSyAoPF_DtMb2q6MPFi_3GTyAjvy_Cai0uIU',
  authDomain: 'bigas-voice.firebaseapp.com',
  projectId: 'bigas-voice',
  storageBucket: 'bigas-voice.firebasestorage.app',
  messagingSenderId: '306408978677',
  appId: '1:306408978677:web:f6dd4e9cb68442abd86dbc',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
window.__bigasPronto = true; // o aviso de "sem internet" olha isto

const $ = (id) => document.getElementById(id);
const ponte = window.bigasHome;

// quanto tempo um "está te chamando" vale, e quanto tempo o chamador espera
const CONVITE_VALE_MS = 60 * 1000;
const ESPERA_ATENDER_MS = 45 * 1000;
// presença: batida a cada 40 s; sem batida por 100 s = offline
const BATIDA_MS = 40 * 1000;
const OFFLINE_APOS_MS = 100 * 1000;
// chamadas perdidas: guarda uma semana
const PERDIDA_VALE_MS = 7 * 24 * 60 * 60 * 1000;

function nickParaEmail(nick){
  return nick.trim().toLowerCase().replace(/[^a-z0-9_]/g, '') + '@bigasvoice.app';
}
function iniciais(nome){ return (nome || '?').slice(0, 2).toUpperCase(); }
function ms(carimbo){ return carimbo && typeof carimbo.toMillis === 'function' ? carimbo.toMillis() : null; }
function guardarLocal(chave, valor){ try { localStorage.setItem(chave, JSON.stringify(valor)); } catch {} }
function lerLocal(chave, padrao){ try { const v = localStorage.getItem(chave); return v == null ? padrao : JSON.parse(v); } catch { return padrao; } }
function hora(carimbo){
  const t = ms(carimbo); if (!t) return 'agora';
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function dia(carimbo){
  const t = ms(carimbo); if (!t) return '';
  const d = new Date(t), hoje = new Date();
  if (d.toDateString() === hoje.toDateString()) return 'hoje';
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return 'ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/* =====================================================================
 * ESTADO
 * =================================================================== */
const eu = { uid: null, nick: '', email: '' };
const amigos = new Map();      // uid -> { nick, presenca, parar, pararUltima, ultima, naoLidas }
const bloqueados = new Set();
const bloqueadosNick = new Map();
let pedidosChegando = [];      // docs (para == eu, pendente)
let convitesChegando = [];     // docs de convite ainda tocando pra mim
let perdidas = [];             // docs de convite que não atendi
let paradores = [];            // funções pra desligar listeners no logout
let batida = null;
let carregadoEm = Date.now();  // mensagens anteriores a isto não notificam

const call = {
  estado: 'nenhuma',           // nenhuma | conectando | conectada
  com: '',                     // nick de quem está do outro lado
  papel: '',                   // chamando | atendendo
  link: '',                    // link da sala atual (pra chamar mais gente)
  conviteRef: null,            // meu convite (quando fui eu que chamei)
  extras: [],                  // todos os convites que mandei nesta call (grupo incluso)
  grupo: null, canal: null, grupoNome: '', canalNome: '', // quando a call é um canal de voz de um grupo
  chamando: new Map(),         // convites extras ainda tocando: ref.id → { nick, uid, ref, parar }
  pararConvite: null,
  pararAceito: null,           // (quem atendeu) ouve se quem chamou desligou antes de conectar
  relogio: null,
  mudo: false, surdo: false,
};

const chat = { com: null, nick: '', parar: null, grupo: null }; // grupo = { gid, cid } quando é um canal de texto
const SITE = 'https://andreunicos.github.io/';
let convitesDeGrupo = [];      // pedidos com estado 'grupo' pra mim
let config = {};
let jogoAgora = '';            // jogo conhecido aberto (o app avisa)
let historicoAberto = false;

/* =====================================================================
 * RECADOS E SONS
 * =================================================================== */
let relogioRecado = null;
function recado(texto, tom){
  const r = $('recado');
  r.textContent = texto;
  r.className = 'recado mostra' + (tom ? ' ' + tom : '');
  clearTimeout(relogioRecado);
  relogioRecado = setTimeout(() => { r.className = 'recado'; }, 3800);
}

// toque de chamada (quem recebe) e "tu-tu-tu" (quem chama) — sintetizados,
// sem arquivo de som nenhum
let audio = null, somRelogio = null, somTipo = '';
function nota(freq, inicio, dur, ganho){
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, inicio);
  g.gain.linearRampToValueAtTime(ganho, inicio + 0.02);
  g.gain.setValueAtTime(ganho, inicio + dur - 0.05);
  g.gain.linearRampToValueAtTime(0, inicio + dur);
  o.connect(g).connect(audio.destination);
  o.start(inicio); o.stop(inicio + dur);
}
function tocarSom(tipo){
  if (somTipo === tipo) return;
  pararSom();
  somTipo = tipo;
  try { audio = audio || new AudioContext(); if (audio.state === 'suspended') audio.resume(); } catch { return; }
  const ciclo = () => {
    const t = audio.currentTime + 0.05;
    if (tipo === 'chamada') { nota(880, t, 0.16, 0.18); nota(1175, t + 0.2, 0.16, 0.18); nota(880, t + 0.5, 0.16, 0.18); nota(1175, t + 0.7, 0.22, 0.18); }
    else { nota(440, t, 0.9, 0.06); }
  };
  ciclo();
  somRelogio = setInterval(ciclo, tipo === 'chamada' ? 2200 : 3500);
}
function pararSom(){
  clearInterval(somRelogio); somRelogio = null; somTipo = '';
}

/* =====================================================================
 * LOGIN / CONTA
 * =================================================================== */
let criando = false;
function modoCriar(ligado){
  criando = ligado;
  $('caixa-login').classList.toggle('criando', ligado);
  $('btn-criar').textContent = ligado ? 'Criar a conta' : 'Criar conta';
  $('btn-entrar').style.display = ligado ? 'none' : '';
  $('btn-esqueci').style.display = ligado ? 'none' : '';
  $('btn-voltar-login').style.display = ligado ? '' : 'none';
  $('rotulo-nick').textContent = ligado ? 'Escolhe um nick' : 'Seu nick';
  $('nick').placeholder = ligado ? 'ex: BigHouse' : 'nick (ou e-mail, se cadastrou um)';
  $('erro-login').textContent = '';
}
function travarLogin(travado){
  $('btn-entrar').disabled = travado;
  $('btn-criar').disabled = travado;
}

$('btn-criar').onclick = async () => {
  if (!criando) { modoCriar(true); $('nick').focus(); return; }
  const nick = $('nick').value.trim();
  const email = $('email').value.trim().toLowerCase();
  const senha = $('senha').value;
  $('erro-login').textContent = '';
  if (nick.length < 2) { $('erro-login').textContent = 'O nick precisa de pelo menos 2 letras.'; return; }
  if (nick.length > 18) { $('erro-login').textContent = 'O nick pode ter no máximo 18 letras.'; return; }
  if (!/^[A-Za-z0-9_]+$/.test(nick)) { $('erro-login').textContent = 'Nick só com letras, números e _ (sem espaço).'; return; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('erro-login').textContent = 'Esse e-mail não parece certo.'; return; }
  if (senha.length < 6) { $('erro-login').textContent = 'A senha precisa de pelo menos 6 caracteres.'; return; }
  travarLogin(true);
  try{
    const emailLogin = email || nickParaEmail(nick);
    const cred = await createUserWithEmailAndPassword(auth, emailLogin, senha);
    // nick tem que ser único. Sem e-mail, o próprio e-mail falso já garante
    // isso; com e-mail de verdade, precisa conferir — e só dá pra ler
    // "usuarios" depois de logado, por isso a conferência vem DEPOIS de
    // criar (e desfaz a conta na hora se o nick já tiver dono).
    const q = query(collection(db, 'usuarios'), where('nickBusca', '==', nick.toLowerCase()), limit(1));
    if (!(await getDocs(q)).empty) {
      try { await cred.user.delete(); } catch {}
      $('erro-login').textContent = 'Esse nick já tem dono. Escolhe outro.';
      return;
    }
    await setDoc(doc(db, 'usuarios', cred.user.uid), {
      nick, nickBusca: nick.toLowerCase(), criadoEm: serverTimestamp(),
      ultimoVisto: serverTimestamp(), emChamada: false, temEmail: !!email,
    });
    // neste PC, entrar pelo nick continua funcionando mesmo com e-mail
    const mapa = lerLocal('nickParaEmail', {}); mapa[nick.toLowerCase()] = emailLogin; guardarLocal('nickParaEmail', mapa);
  }catch(e){ $('erro-login').textContent = traduzirErro(e); }
  finally{ travarLogin(false); }
};
$('btn-voltar-login').onclick = () => modoCriar(false);

$('btn-entrar').onclick = async () => {
  const digitado = $('nick').value.trim();
  const senha = $('senha').value;
  $('erro-login').textContent = '';
  if (!digitado || !senha) { $('erro-login').textContent = 'Preenche o nick e a senha.'; return; }
  travarLogin(true);
  try{
    let emailLogin;
    if (digitado.includes('@')) emailLogin = digitado.toLowerCase();
    else emailLogin = lerLocal('nickParaEmail', {})[digitado.toLowerCase()] || nickParaEmail(digitado);
    await signInWithEmailAndPassword(auth, emailLogin, senha);
  }catch(e){ $('erro-login').textContent = traduzirErro(e); }
  finally{ travarLogin(false); }
};
$('senha').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') (criando ? $('btn-criar') : $('btn-entrar')).click(); });
$('nick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('senha').focus(); });

$('btn-esqueci').onclick = async () => {
  const digitado = $('nick').value.trim();
  $('erro-login').textContent = '';
  if (!digitado.includes('@')) {
    $('erro-login').textContent = 'Recuperar senha só funciona com e-mail: digita o e-mail que você cadastrou no campo de cima. (Conta sem e-mail não tem como recuperar.)';
    return;
  }
  try{
    await sendPasswordResetEmail(auth, digitado.toLowerCase());
    $('erro-login').style.color = '#8fe8b3';
    $('erro-login').textContent = 'Mandei um e-mail com o passo a passo pra trocar a senha.';
    setTimeout(() => { $('erro-login').style.color = ''; }, 6000);
  }catch(e){ $('erro-login').textContent = traduzirErro(e); }
};

$('btn-sair-conta').onclick = async () => {
  if (call.estado !== 'nenhuma') { recado('Sai da chamada antes de sair da conta.', 'mal'); return; }
  try{ await updateDoc(doc(db, 'usuarios', eu.uid), { ultimoVisto: null, emChamada: false }); }catch{}
  signOut(auth);
};

function traduzirErro(e){
  const c = (e && e.code) || '';
  if (c.includes('email-already-in-use')) return 'Esse e-mail (ou nick) já tem conta. Tenta "Entrar".';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found'))
    return 'Nick ou senha errados.';
  if (c.includes('invalid-email')) return 'Esse e-mail não parece certo.';
  if (c.includes('weak-password')) return 'Senha muito fraca — usa pelo menos 6 caracteres.';
  if (c.includes('network-request-failed')) return 'Sem internet agora. Tenta de novo.';
  if (c.includes('too-many-requests')) return 'Muitas tentativas. Espera um pouco e tenta de novo.';
  if (c.includes('permission-denied')) return 'O servidor recusou (regras). Avisa quem cuida do app.';
  return 'Não consegui completar (' + (c.replace('auth/', '') || 'erro') + ').';
}

/* =====================================================================
 * QUANDO LOGA / DESLOGA
 * =================================================================== */
onAuthStateChanged(auth, async (usuario) => {
  desligarTudo();

  if (!usuario) {
    if (call.estado !== 'nenhuma') sairDaCall(); // deslogou no meio de uma call: a call não sobrevive à conta
    eu.uid = null; eu.nick = ''; eu.email = '';
    $('tela-login').style.display = 'flex';
    $('tela-casa').style.display = 'none';
    $('senha').value = '';
    return;
  }

  eu.uid = usuario.uid;
  eu.email = (usuario.email || '').endsWith('@bigasvoice.app') ? '' : (usuario.email || '');
  // conta recém-criada: o perfil é gravado logo DEPOIS do login acontecer —
  // dá uns segundos pra ele aparecer antes de desistir. E sem internet o
  // servidor nem responde: aí avisa e tenta de novo, em vez de ficar mudo.
  let meuDoc = null;
  try{
    meuDoc = await getDoc(doc(db, 'usuarios', usuario.uid));
    for (let i = 0; i < 12 && !meuDoc.exists(); i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (auth.currentUser !== usuario) return; // já deslogou (ex.: nick repetido, conta desfeita)
      meuDoc = await getDoc(doc(db, 'usuarios', usuario.uid));
    }
  }catch(e){
    console.warn('perfil', e);
    if (auth.currentUser !== usuario) return;
    $('erro-login').textContent = 'Entrei na conta, mas não consegui carregar seu perfil (' + ((e && e.code) || 'sem rede') + '). Tentando de novo em 5 s…';
    setTimeout(() => { if (auth.currentUser === usuario && !eu.nick) location.reload(); }, 5000);
    return;
  }
  if (auth.currentUser !== usuario) return; // deslogou enquanto o perfil carregava
  eu.nick = meuDoc && meuDoc.exists() ? meuDoc.data().nick : ((usuario.email || '').split('@')[0] || 'Sem nome');
  $('meu-nick').textContent = eu.nick;
  $('meu-av').textContent = iniciais(eu.nick);
  $('aj-nick').textContent = eu.nick;
  $('aj-email').textContent = eu.email ? 'e-mail de recuperação: ' + eu.email : 'sem e-mail de recuperação';

  $('tela-login').style.display = 'none';
  $('tela-casa').style.display = 'flex';
  carregadoEm = Date.now();
  mandarRectDoPalco();

  ligarPresenca();
  ouvirBloqueados();
  ouvirAmigos();
  ouvirPedidos();
  ouvirConvites();
  ouvirPerdidas();
  ouvirGrupos();
});

function desligarTudo(){
  paradores.forEach((p) => { try { p(); } catch {} });
  paradores = [];
  amigos.forEach((a) => { if (a.parar) a.parar(); if (a.pararUltima) a.pararUltima(); });
  amigos.clear();
  bloqueados.clear();
  clearInterval(batida); batida = null;
  pedidosChegando = []; convitesChegando = []; perdidas = []; convitesDeGrupo = [];
  fecharGrupo(); grupos.forEach((g) => { if (g.parar) g.parar(); }); grupos.clear(); pintarTrilho();
  fecharChat(); fecharLateral();
  pararSom();
  pintarConvite(); pintarPedidos(); pintarPerdidas(); pintarAmigos();
}

/* =====================================================================
 * PRESENÇA (online / em chamada) — uma batida de tempos em tempos
 * =================================================================== */
function bater(){
  if (!eu.uid) return;
  if (call.grupo && call.estado !== 'nenhuma') marcarCanalVoz(call.grupo, call.canal);
  setDoc(doc(db, 'usuarios', eu.uid), {
    ultimoVisto: serverTimestamp(), emChamada: call.estado !== 'nenhuma', jogando: jogoAgora || '',
  }, { merge: true }).catch(() => {});
}
function ligarPresenca(){
  bater();
  clearInterval(batida);
  batida = setInterval(bater, BATIDA_MS);
}
// relógios que valem a sessão inteira (não por login): quem ficou sem
// batida cai pra offline sozinho, e convite velho para de tocar sozinho
setInterval(pintarAmigos, 15 * 1000);
setInterval(pintarConvite, 5 * 1000);

function presencaDe(a){
  const p = a.presenca;
  const t = p && ms(p.ultimoVisto);
  if (!t) return 'offline';
  if (Date.now() - t > OFFLINE_APOS_MS) return 'offline';
  return p.emChamada ? 'emcall' : 'online';
}

/* =====================================================================
 * BLOQUEADOS
 * =================================================================== */
function ouvirBloqueados(){
  paradores.push(onSnapshot(collection(db, 'usuarios', eu.uid, 'bloqueados'), (snap) => {
    bloqueados.clear(); bloqueadosNick.clear();
    snap.forEach((d) => { bloqueados.add(d.id); bloqueadosNick.set(d.id, d.data().nick || ''); });
    pintarPedidos(); pintarConvite(); pintarPerdidas(); pintarBloqueados();
  }, () => {}));
}
async function bloquear(uid, nick){
  if (!confirm('Bloquear ' + nick + '? Ele sai da sua lista e não consegue mais te chamar nem te mandar pedido.')) return;
  try{
    await setDoc(doc(db, 'usuarios', eu.uid, 'bloqueados', uid), { nick, quando: serverTimestamp() });
    await deleteDoc(doc(db, 'usuarios', eu.uid, 'amigos', uid)).catch(() => {});
    if (chat.com === uid) fecharChat();
    recado(nick + ' foi bloqueado.', '');
  }catch(e){ recado('Não consegui bloquear agora.', 'mal'); }
}
async function desbloquear(uid){
  try{ await deleteDoc(doc(db, 'usuarios', eu.uid, 'bloqueados', uid)); }catch{}
}
function pintarBloqueados(){
  const caixa = $('lista-bloqueados'); if (!caixa) return;
  caixa.innerHTML = '';
  if (!bloqueados.size) { caixa.innerHTML = '<small style="color:var(--txt3)">ninguém bloqueado</small>'; return; }
  bloqueados.forEach((uid) => {
    const linha = document.createElement('div'); linha.className = 'ajuste';
    const txt = document.createElement('div'); txt.className = 'txt';
    const b = document.createElement('b'); b.textContent = bloqueadosNick.get(uid) || uid.slice(0, 8);
    txt.appendChild(b);
    const btn = document.createElement('button'); btn.className = 'link'; btn.textContent = 'desbloquear';
    btn.onclick = () => desbloquear(uid);
    linha.append(txt, btn); caixa.appendChild(linha);
  });
}

/* =====================================================================
 * AMIGOS — pedido, aceite, lista
 * =================================================================== */
$('btn-add').onclick = mandarPedido;
$('add-nick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') mandarPedido(); });

function avisoAdd(texto, bem){
  const e = $('erro-add'); e.textContent = texto; e.classList.toggle('bem', !!bem);
  if (bem) setTimeout(() => { if (e.textContent === texto) e.textContent = ''; }, 4000);
}

async function mandarPedido(){
  const nickBuscado = $('add-nick').value.trim();
  avisoAdd('');
  if (!nickBuscado) return;
  $('btn-add').disabled = true;
  try{
    const q = query(collection(db, 'usuarios'), where('nickBusca', '==', nickBuscado.toLowerCase()), limit(1));
    const achou = await getDocs(q);
    if (achou.empty) { avisoAdd('Não achei ninguém com esse nick.'); return; }
    const outro = achou.docs[0];
    if (outro.id === eu.uid) { avisoAdd('Esse nick é o seu.'); return; }
    // (se ele já está na SUA lista mas você não na dele — coisa das versões
    // antigas, que só gravavam um lado — o pedido completa o outro lado)
    if (bloqueados.has(outro.id)) { avisoAdd('Você bloqueou ' + outro.data().nick + '. Desbloqueia nos ajustes primeiro.'); return; }
    // ele já me pediu? então é só aceitar
    const jaPediu = pedidosChegando.find((d) => d.data().de === outro.id);
    if (jaPediu) { await aceitarPedido(jaPediu); avisoAdd(outro.data().nick + ' já tinha te pedido — virou amigo agora.', true); $('add-nick').value = ''; return; }
    // eu já pedi e está pendente?
    const meus = await getDocs(query(collection(db, 'pedidos'), where('de', '==', eu.uid), where('para', '==', outro.id), where('estado', '==', 'pendente'), limit(1)));
    if (!meus.empty) { avisoAdd('Você já pediu — ' + outro.data().nick + ' ainda não respondeu.'); return; }
    await addDoc(collection(db, 'pedidos'), {
      de: eu.uid, deNick: eu.nick, para: outro.id, paraNick: outro.data().nick,
      estado: 'pendente', quando: serverTimestamp(),
    });
    $('add-nick').value = '';
    avisoAdd('Pedido enviado pra ' + outro.data().nick + '. Quando ele aceitar, aparece na lista.', true);
  }catch(e){
    console.error(e);
    avisoAdd(e && e.code === 'permission-denied' ? 'Essa pessoa te bloqueou.' : traduzirErro(e));
  }finally{ $('btn-add').disabled = false; }
}

function ouvirPedidos(){
  // pedidos PRA MIM, pendentes
  paradores.push(onSnapshot(query(collection(db, 'pedidos'), where('para', '==', eu.uid), where('estado', '==', 'pendente')), (snap) => {
    const antes = new Set(pedidosChegando.map((d) => d.id));
    pedidosChegando = snap.docs;
    pintarPedidos();
    snap.docs.forEach((d) => {
      const c = d.data();
      if (!antes.has(d.id) && (ms(c.quando) || Date.now()) > carregadoEm && !bloqueados.has(c.de))
        ponte.notificar('Pedido de amizade', c.deNick + ' quer ser seu amigo');
    });
  }, (e) => console.error(e)));

  // convites pra GRUPO (estado 'grupo'): aparecem junto dos pedidos
  paradores.push(onSnapshot(query(collection(db, 'pedidos'), where('para', '==', eu.uid), where('estado', '==', 'grupo')), (snap) => {
    const antes = new Set(convitesDeGrupo.map((d) => d.id));
    convitesDeGrupo = snap.docs;
    pintarPedidos();
    snap.docs.forEach((d) => {
      const c = d.data();
      if (!antes.has(d.id) && (ms(c.quando) || Date.now()) > carregadoEm && !bloqueados.has(c.de))
        ponte.notificar('Convite pra grupo', c.deNick + ' te convidou pro grupo ' + c.gnome);
    });
  }, (e) => console.error(e)));

  // pedidos MEUS que foram aceitos: eu completo o meu lado da amizade
  // (cada pedido uma vez só — o snapshot pode repetir o doc antes de o
  // "concluido" chegar ao servidor)
  const jaTratei = new Set();
  paradores.push(onSnapshot(query(collection(db, 'pedidos'), where('de', '==', eu.uid), where('estado', '==', 'aceito')), (snap) => {
    snap.docs.forEach(async (d) => {
      if (jaTratei.has(d.id)) return;
      jaTratei.add(d.id);
      const c = d.data();
      try{
        await setDoc(doc(db, 'usuarios', eu.uid, 'amigos', c.para), { nick: c.paraNick, desde: serverTimestamp() });
        await updateDoc(d.ref, { estado: 'concluido' });
        recado(c.paraNick + ' aceitou sua amizade!', 'bem');
        ponte.notificar('Bigas Voice', c.paraNick + ' aceitou sua amizade');
      }catch(e){ console.error(e); jaTratei.delete(d.id); }
    });
  }, (e) => console.error(e)));

  // alguém me TIROU da lista: tiro ele da minha também (a amizade acaba dos dois lados)
  paradores.push(onSnapshot(query(collection(db, 'pedidos'), where('para', '==', eu.uid), where('estado', '==', 'desfeito')), (snap) => {
    snap.docs.forEach(async (d) => {
      if (jaTratei.has(d.id)) return;
      jaTratei.add(d.id);
      try{
        await deleteDoc(doc(db, 'usuarios', eu.uid, 'amigos', d.data().de)).catch(() => {});
        await updateDoc(d.ref, { estado: 'concluido' });
      }catch(e){ console.error(e); }
    });
  }, (e) => console.error(e)));
}

async function aceitarPedido(d){
  const c = d.data();
  await setDoc(doc(db, 'usuarios', eu.uid, 'amigos', c.de), { nick: c.deNick, desde: serverTimestamp() });
  await updateDoc(d.ref, { estado: 'aceito' });
}
async function recusarPedido(d){
  await updateDoc(d.ref, { estado: 'recusado' });
}

function pintarPedidos(){
  const vivos = pedidosChegando.filter((d) => !bloqueados.has(d.data().de));
  const deGrupo = convitesDeGrupo.filter((d) => !bloqueados.has(d.data().de) && !grupos.has(d.data().gid));
  const total = vivos.length + deGrupo.length;
  $('bloco-pedidos').hidden = !total;
  $('bolinha-pedidos').hidden = !total;
  $('bolinha-pedidos').textContent = String(total);
  $('bolinha-casa').hidden = !total || !grupo.gid;
  $('bolinha-casa').textContent = String(total);
  const caixa = $('pedidos'); caixa.innerHTML = '';
  deGrupo.forEach((d) => {
    const c = d.data();
    const el = document.createElement('div'); el.className = 'cartinha';
    const av = document.createElement('div'); av.className = 'avatar'; av.textContent = iniciais(c.gnome); av.style.background = corDoGrupo(c.gid); av.style.color = '#fff';
    const txt = document.createElement('div'); txt.className = 'txt';
    const b = document.createElement('b'); b.textContent = c.gnome;
    const sm = document.createElement('small'); sm.textContent = c.deNick + ' te convidou pro grupo';
    txt.append(b, sm);
    const sim = document.createElement('button'); sim.className = 'sim'; sim.textContent = '✓'; sim.title = 'Entrar no grupo';
    sim.onclick = async () => { sim.disabled = true; try { await entrarPorCodigo(c.codigo); await updateDoc(d.ref, { estado: 'concluido' }); recado('Você entrou em ' + c.gnome + '.', 'bem'); } catch (e) { console.error(e); recado('Não consegui entrar no grupo (' + ((e && e.code) || e.message || 'erro') + ').', 'mal'); sim.disabled = false; } };
    const nao = document.createElement('button'); nao.className = 'nao'; nao.textContent = '×'; nao.title = 'Recusar';
    nao.onclick = async () => { nao.disabled = true; try { await updateDoc(d.ref, { estado: 'recusado' }); } catch { nao.disabled = false; } };
    el.append(av, txt, sim, nao);
    caixa.appendChild(el);
  });
  vivos.forEach((d) => {
    const c = d.data();
    const el = document.createElement('div'); el.className = 'cartinha';
    const av = document.createElement('div'); av.className = 'avatar'; av.textContent = iniciais(c.deNick);
    const txt = document.createElement('div'); txt.className = 'txt';
    const b = document.createElement('b'); b.textContent = c.deNick;
    const s = document.createElement('small'); s.textContent = 'quer ser seu amigo';
    txt.append(b, s);
    const sim = document.createElement('button'); sim.className = 'sim'; sim.textContent = '✓'; sim.title = 'Aceitar';
    sim.onclick = async () => { sim.disabled = true; try { await aceitarPedido(d); recado(c.deNick + ' agora é seu amigo.', 'bem'); } catch (e) { recado('Não consegui aceitar.', 'mal'); sim.disabled = false; } };
    const nao = document.createElement('button'); nao.className = 'nao'; nao.textContent = '×'; nao.title = 'Recusar';
    nao.onclick = async () => { nao.disabled = true; try { await recusarPedido(d); } catch { nao.disabled = false; } };
    el.append(av, txt, sim, nao);
    caixa.appendChild(el);
  });
}

async function tirarAmigo(uid, nick){
  if (!confirm('Tirar ' + nick + ' da sua lista? A amizade acaba dos dois lados.')) return;
  try{
    await deleteDoc(doc(db, 'usuarios', eu.uid, 'amigos', uid));
    // o lado dele só ele mesmo pode apagar — um recado "desfeito" pede isso
    await addDoc(collection(db, 'pedidos'), { de: eu.uid, deNick: eu.nick, para: uid, paraNick: nick, estado: 'desfeito', quando: serverTimestamp() }).catch(() => {});
    if (chat.com === uid) fecharChat();
  }catch(e){ recado('Não consegui tirar agora.', 'mal'); }
}

function ouvirAmigos(){
  paradores.push(onSnapshot(collection(db, 'usuarios', eu.uid, 'amigos'), (snap) => {
    const vivos = new Set();
    snap.forEach((d) => {
      vivos.add(d.id);
      let a = amigos.get(d.id);
      if (!a) {
        a = { nick: d.data().nick, presenca: null, parar: null, pararUltima: null, ultima: null, naoLidas: 0, avisou: null };
        // cada amigo tem o próprio "olho": online / em chamada, ao vivo
        a.parar = onSnapshot(doc(db, 'usuarios', d.id), (u) => {
          a.presenca = u.exists() ? u.data() : null;
          if (u.exists() && u.data().nick) a.nick = u.data().nick;
          pintarAmigos();
        }, () => {});
        // e a última mensagem da conversa (pra bolinha de não lida)
        a.pararUltima = onSnapshot(query(collection(db, 'conversas', idConversa(d.id), 'mensagens'), orderBy('quando', 'desc'), limit(1)), (s) => {
          const m = s.docs[0];
          a.ultima = m ? Object.assign({ id: m.id }, m.data()) : null;
          if (m && m.data().de !== eu.uid) {
            const t = ms(m.data().quando) || Date.now();
            if (chat.com === d.id) marcarLido(d.id, t);
            else {
              a.naoLidas = t > lidoAte(d.id) ? 1 : 0;
              if (t > carregadoEm && t > lidoAte(d.id) && a.avisou !== m.id) {
                a.avisou = m.id;
                ponte.notificar(a.nick, String(m.data().texto || '').slice(0, 120));
              }
            }
          } else a.naoLidas = 0;
          pintarAmigos();
        }, () => {});
        amigos.set(d.id, a);
      } else {
        a.nick = d.data().nick || a.nick;
      }
    });
    amigos.forEach((a, id) => { if (!vivos.has(id)) { if (a.parar) a.parar(); if (a.pararUltima) a.pararUltima(); amigos.delete(id); if (chat.com === id) fecharChat(); } });
    pintarAmigos();
  }, (e) => { console.error(e); recado('Não consegui carregar seus amigos.', 'mal'); }));
}

function pintarAmigos(){
  const lista = $('lista-amigos');
  if (!lista) return;
  $('titulo-lista').textContent = amigos.size ? 'Amigos — ' + amigos.size : 'Amigos';
  if (!amigos.size) {
    lista.innerHTML = '<p class="vazio">Ninguém na lista ainda.<br>Manda um pedido pelo nick aí em cima — quando a pessoa aceitar, ela aparece aqui.</p>';
    return;
  }
  const ordem = { emcall: 0, online: 0, offline: 1 };
  const entradas = [...amigos.entries()]
    .map(([id, a]) => ({ id, a, p: presencaDe(a) }))
    .sort((x, y) => (ordem[x.p] - ordem[y.p]) || (y.a.naoLidas - x.a.naoLidas) || x.a.nick.localeCompare(y.a.nick));

  lista.innerHTML = '';
  for (const { id, a, p } of entradas) {
    const linha = document.createElement('div');
    linha.className = 'amigo ' + p + (chat.com === id ? ' aberto' : '');
    linha.onclick = () => abrirChat(id, a.nick);
    linha.oncontextmenu = (ev) => { ev.preventDefault(); abrirMenuAmigo(id, a.nick, ev.clientX, ev.clientY); };

    const av = document.createElement('div'); av.className = 'avatar';
    av.textContent = iniciais(a.nick);
    const luz = document.createElement('span'); luz.className = 'luz'; av.appendChild(luz);

    const txt = document.createElement('div'); txt.className = 'txt';
    const nome = document.createElement('div'); nome.className = 'nome';
    nome.textContent = a.nick;
    if (a.naoLidas) { const b = document.createElement('span'); b.className = 'bolinha'; b.textContent = '●'; b.title = 'mensagem nova'; nome.appendChild(b); }
    const estado = document.createElement('div'); estado.className = 'estado';
    const jogo = p !== 'offline' && a.presenca && a.presenca.jogando ? String(a.presenca.jogando).slice(0, 30) : '';
    estado.textContent = a.ultima && a.naoLidas ? String(a.ultima.texto || '').slice(0, 40)
      : jogo ? '🎮 Jogando ' + jogo + (p === 'emcall' ? ' · em chamada' : '')
      : p === 'emcall' ? 'em chamada' : p === 'online' ? 'online' : 'offline';
    if (jogo && !(a.ultima && a.naoLidas)) estado.classList.add('jogo');
    txt.append(nome, estado);

    const acoes = document.createElement('div'); acoes.className = 'acoes';
    const chamar = document.createElement('button');
    chamar.type = 'button'; chamar.className = 'chamar';
    const naCall = call.estado !== 'nenhuma';
    chamar.textContent = naCall ? '➕' : '📞';
    chamar.title = naCall ? 'Trazer ' + a.nick + ' pra esta chamada' : 'Chamar ' + a.nick;
    if (naCall && !call.link) { chamar.disabled = true; chamar.title = 'Espera a chamada abrir'; }
    chamar.onclick = (ev) => { ev.stopPropagation(); if (naCall) chamarParaCall(id, a.nick); else chamarAmigo(id, a.nick); };
    const mais = document.createElement('button');
    mais.type = 'button'; mais.className = 'mais'; mais.textContent = '⋯'; mais.title = 'Mais';
    mais.onclick = (ev) => { ev.stopPropagation(); const r = mais.getBoundingClientRect(); abrirMenuAmigo(id, a.nick, r.left, r.bottom + 4); };
    acoes.append(chamar, mais);

    linha.append(av, txt, acoes);
    lista.appendChild(linha);
  }
}

/* menu do amigo (botão direito ou ⋯) */
function abrirMenuAmigo(uid, nick, x, y){
  const m = $('menu-amigo');
  m.innerHTML = '';
  const item = (rotulo, fn, perigo) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = rotulo;
    if (perigo) b.className = 'perigo';
    b.onclick = () => { fecharMenuAmigo(); fn(); };
    m.appendChild(b);
  };
  item('💬 Conversar', () => abrirChat(uid, nick));
  if (call.estado !== 'nenhuma') item('➕ Trazer pra esta chamada', () => chamarParaCall(uid, nick));
  else item('📞 Chamar', () => chamarAmigo(uid, nick));
  item('Tirar da lista', () => tirarAmigo(uid, nick));
  item('🚫 Bloquear', () => bloquear(uid, nick), true);
  m.classList.add('mostra');
  posicionarMenu(m, x, y);
  setTimeout(() => document.addEventListener('click', fecharMenuAmigo, { once: true }), 0);
}
function fecharMenuAmigo(){ $('menu-amigo').classList.remove('mostra'); }
// a view da call é uma camada NATIVA por cima do palco: um menu da casa que
// avance sobre o palco fica cortado. Então o menu nunca passa da borda do palco.
function posicionarMenu(m, x, y){
  const limite = (call.estado !== 'nenhuma') ? $('palco').getBoundingClientRect().left - 6 : innerWidth - 6;
  m.style.left = Math.max(6, Math.min(limite - m.offsetWidth, x)) + 'px';
  m.style.top = Math.max(6, Math.min(innerHeight - m.offsetHeight - 6, y)) + 'px';
}
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') fecharMenuAmigo(); });

/* =====================================================================
 * CHAT (conversa por amigo, com histórico)
 * =================================================================== */
function idConversa(outro){ return [eu.uid, outro].sort().join('_'); }
function lidoAte(uid){ return Number(lerLocal('lido:' + eu.uid + ':' + uid, 0)) || 0; }
function marcarLido(uid, t){
  guardarLocal('lido:' + eu.uid + ':' + uid, Math.max(lidoAte(uid), t || Date.now()));
  const a = amigos.get(uid); if (a) a.naoLidas = 0;
}

function abrirChat(uid, nick){
  if (chat.parar) { chat.parar(); chat.parar = null; }
  chat.com = uid; chat.nick = nick; chat.grupo = null;
  $('chat-nick').textContent = nick;
  $('chat-av').textContent = iniciais(nick); $('chat-av').style.background = '';
  $('mensagens').innerHTML = '<p class="vazio">Carregando…</p>';
  mostrarLateral('sec-chat');
  marcarLido(uid, Date.now());
  pintarAmigos();
  ligarMensagens(query(collection(db, 'conversas', idConversa(uid), 'mensagens'), orderBy('quando', 'desc'), limit(200)), () => marcarLido(uid, Date.now()));
}
// canal de texto de um grupo: a mesma lateral, com o nome de quem escreveu
function abrirCanalTexto(cid){
  const c = grupo.canais.get(cid); if (!c) return;
  if (chat.parar) { chat.parar(); chat.parar = null; }
  chat.com = null; chat.nick = '#' + c.nome; chat.grupo = { gid: grupo.gid, cid };
  $('chat-nick').textContent = '# ' + c.nome;
  $('chat-av').textContent = '#'; $('chat-av').style.background = corDoGrupo(grupo.gid);
  $('mensagens').innerHTML = '<p class="vazio">Carregando…</p>';
  mostrarLateral('sec-chat');
  pintarGrupo();
  ligarMensagens(query(collection(db, 'grupos', grupo.gid, 'canais', cid, 'mensagens'), orderBy('quando', 'desc'), limit(200)), null);
}
function ligarMensagens(ref, aoLer){
  chat.parar = onSnapshot(ref, (snap) => {
    const caixa = $('mensagens');
    const estavaEmbaixo = caixa.scrollTop + caixa.clientHeight >= caixa.scrollHeight - 40;
    caixa.innerHTML = '';
    // mensagem recém-enviada ainda não tem carimbo do servidor: usa a
    // estimativa local pra ela não pular pro topo enquanto o servidor responde
    const docs = snap.docs.map((d) => d.data({ serverTimestamps: 'estimate' }))
      .sort((a, b) => (ms(a.quando) || 0) - (ms(b.quando) || 0));
    if (!docs.length) caixa.innerHTML = '<p class="vazio">Nenhuma mensagem ainda. Manda um oi.</p>';
    let diaAnterior = '';
    docs.forEach((m) => {
      const dd = dia(m.quando) || 'agora';
      if (dd !== diaAnterior) { const s = document.createElement('div'); s.className = 'msg dia'; s.textContent = dd; caixa.appendChild(s); diaAnterior = dd; }
      const el = document.createElement('div'); el.className = 'msg' + (m.de === eu.uid ? ' minha' : '');
      if (chat.grupo && m.de !== eu.uid) { const q = document.createElement('div'); q.className = 'quem'; q.textContent = m.deNick || '…'; el.appendChild(q); }
      const t = document.createElement('div'); t.className = 'texto'; t.textContent = m.texto || '';
      const h = document.createElement('div'); h.className = 'hora'; h.textContent = hora(m.quando);
      el.append(t, h); caixa.appendChild(el);
    });
    if (estavaEmbaixo || snap.docChanges().some((c) => c.type === 'added')) caixa.scrollTop = caixa.scrollHeight;
    if (aoLer) aoLer();
  }, (e) => { console.error(e); $('mensagens').innerHTML = '<p class="vazio">Não consegui abrir a conversa (' + (e.code || 'erro') + ').</p>'; });
  setTimeout(() => $('chat-texto').focus(), 50);
}
function fecharChat(){
  if (chat.parar) { chat.parar(); chat.parar = null; }
  chat.com = null; chat.nick = ''; chat.grupo = null;
  if ($('sec-chat').classList.contains('mostra')) fecharLateral();
  pintarAmigos();
  if (grupo.gid) pintarGrupo();
}
$('btn-fechar-chat').onclick = fecharChat;

async function enviarMensagem(){
  const texto = $('chat-texto').value.trim();
  if (!texto || (!chat.com && !chat.grupo)) return;
  $('chat-texto').value = ''; ajustarAltura();
  try{
    if (chat.grupo) await addDoc(collection(db, 'grupos', chat.grupo.gid, 'canais', chat.grupo.cid, 'mensagens'), { de: eu.uid, deNick: eu.nick, texto, quando: serverTimestamp() });
    else await addDoc(collection(db, 'conversas', idConversa(chat.com), 'mensagens'), { de: eu.uid, texto, quando: serverTimestamp() });
  }catch(e){
    console.error(e);
    recado(e && e.code === 'permission-denied' ? 'Não dá pra mandar: vocês não são mais amigos (ou essa pessoa te bloqueou).' : 'A mensagem não foi (' + ((e && e.code) || 'erro') + ').', 'mal');
    $('chat-texto').value = texto;
  }
}
$('btn-enviar').onclick = enviarMensagem;
$('chat-texto').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); enviarMensagem(); }
});
function ajustarAltura(){ const t = $('chat-texto'); t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight) + 'px'; }
$('chat-texto').addEventListener('input', ajustarAltura);

/* lateral: chat OU ajustes */
function mostrarLateral(qual){
  $('lateral').classList.add('mostra');
  ['sec-chat', 'sec-historico'].forEach((id) => $(id).classList.toggle('mostra', id === qual));
  historicoAberto = qual === 'sec-historico';
  $('btn-historico').classList.toggle('ativo', historicoAberto);
  mandarRectDoPalco();
}
function fecharLateral(){
  $('lateral').classList.remove('mostra');
  historicoAberto = false;
  $('btn-historico').classList.remove('ativo');
  mandarRectDoPalco();
}

/* =====================================================================
 * HISTÓRICO DE CHAMADAS — fica só neste PC (localStorage), por conta
 * =================================================================== */
function historicoLer(){ return eu.uid ? lerLocal('historico:' + eu.uid, []) : []; }
function anotarNoHistorico(item){
  if (!eu.uid) return;
  const h = historicoLer();
  h.unshift(Object.assign({ quando: Date.now() }, item));
  guardarLocal('historico:' + eu.uid, h.slice(0, 100));
  if (historicoAberto) pintarHistorico();
}
function duracaoBonita(ms){
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), r = s % 60;
  return m < 60 ? m + ' min' + (r ? ' ' + r + ' s' : '') : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
function pintarHistorico(){
  const caixa = $('historico'); caixa.innerHTML = '';
  const h = historicoLer();
  if (!h.length) { caixa.innerHTML = '<p class="vazio">Nenhuma chamada ainda.</p>'; return; }
  let diaAnterior = '';
  h.forEach((c) => {
    const d = new Date(c.quando);
    const dd = dia({ toMillis: () => c.quando }) || d.toLocaleDateString('pt-BR');
    if (dd !== diaAnterior) { const t = document.createElement('div'); t.className = 'msg dia'; t.textContent = dd; caixa.appendChild(t); diaAnterior = dd; }
    const el = document.createElement('div'); el.className = 'cartinha hist' + (c.tipo === 'perdida' ? ' perdida' : '');
    const tipo = document.createElement('div'); tipo.className = 'tipo';
    tipo.textContent = c.tipo === 'perdida' ? '↙' : c.tipo === 'recebi' ? '↙' : '↗';
    tipo.title = c.tipo === 'perdida' ? 'Perdida' : c.tipo === 'recebi' ? 'Recebida' : 'Feita';
    tipo.style.color = c.tipo === 'perdida' ? '#ff9d94' : c.tipo === 'recebi' ? 'var(--verde)' : 'var(--azul2)';
    const txt = document.createElement('div'); txt.className = 'txt';
    const b = document.createElement('b'); b.textContent = c.nick || '?';
    const sm = document.createElement('small');
    sm.textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + (c.tipo === 'perdida' ? ' · não atendida' : c.duracao ? ' · ' + duracaoBonita(c.duracao) : ' · não completou');
    txt.append(b, sm);
    const voltar = document.createElement('button'); voltar.className = 'sim'; voltar.textContent = '📞'; voltar.title = 'Ligar';
    voltar.onclick = () => { const a = c.uid && amigos.get(c.uid); if (a) chamarAmigo(c.uid, a.nick); else recado((c.nick || 'Essa pessoa') + ' não está na sua lista.', 'mal'); };
    el.append(tipo, txt, voltar);
    caixa.appendChild(el);
  });
}
$('btn-historico').onclick = () => { if (historicoAberto) fecharLateral(); else { if (chat.com) { if (chat.parar) { chat.parar(); chat.parar = null; } chat.com = null; chat.nick = ''; pintarAmigos(); } mostrarLateral('sec-historico'); pintarHistorico(); } };
$('btn-fechar-historico').onclick = fecharLateral;
$('btn-limpar-historico').onclick = () => { if (confirm('Apagar o histórico de chamadas deste PC?')) { guardarLocal('historico:' + eu.uid, []); pintarHistorico(); } };

/* =====================================================================
 * CHAMAR — a call abre no palco; o link fica só no convite
 * =================================================================== */
async function chamarAmigo(amigoUid, amigoNick){
  if (call.estado !== 'nenhuma') { recado('Você já está numa chamada.', 'mal'); return; }
  entrarEmEstado('conectando', amigoNick, 'chamando');
  $('conectando-txt').textContent = 'Chamando ' + amigoNick + '…';
  mandarRectDoPalco(); // garantia: a view nasce já no lugar certo
  try{
    const link = await ponte.iniciarCall(eu.nick, amigoNick);
    if (!link) {
      // o motivo (sem internet, sem sinal…) chega logo em seguida por
      // call:estado 'encerrada', com o recado certo — aqui só desfaz
      if (call.estado !== 'nenhuma') entrarEmEstado('nenhuma');
      return;
    }
    if (call.estado === 'nenhuma') return; // desistiu no meio
    call.link = link;
    call.comUid = amigoUid;
    pintarAmigos();
    await mandarConvite(amigoUid, amigoNick, link, true);
  }catch(e){
    console.error(e);
    if (e && e.code === 'permission-denied') {
      // o servidor só deixa ligar pra quem TE TEM como amigo. Ele ainda não
      // tem (amizade antiga, de um lado só): manda o pedido e explica.
      recado(amigoNick + ' ainda não te tem como amigo — mandei um pedido; quando ele aceitar, a chamada funciona.', 'mal');
      addDoc(collection(db, 'pedidos'), { de: eu.uid, deNick: eu.nick, para: amigoUid, paraNick: amigoNick, estado: 'pendente', quando: serverTimestamp() }).catch(() => {});
    } else {
      recado('Deu erro ao chamar: ' + traduzirErro(e), 'mal');
    }
    sairDaCall();
  }
}

// já numa call: chama mais um pra MESMA sala (o site é um mesh de até 6)
async function chamarParaCall(amigoUid, amigoNick){
  if (call.estado === 'nenhuma' || !call.link) { recado('Abre uma chamada primeiro.', 'mal'); return; }
  try{
    await mandarConvite(amigoUid, amigoNick, call.link, false);
    recado('Chamando ' + amigoNick + ' pra esta chamada…', 'bem');
  }catch(e){ recado('Não consegui chamar ' + amigoNick + ': ' + traduzirErro(e), 'mal'); }
}

async function mandarConvite(amigoUid, amigoNick, link, principal){
  const ref = await addDoc(collection(db, 'convites'), {
    de: eu.uid, deNick: eu.nick, para: amigoUid, paraNick: amigoNick,
    link, estado: 'chamando', quando: serverTimestamp(),
  });
  // a pessoa saiu da call enquanto o convite viajava: ele nasce morto
  if (call.estado === 'nenhuma' || call.link !== link) {
    updateDoc(ref, { estado: 'encerrada' }).catch(() => {});
    return;
  }
  call.extras.push(ref);
  bater();
  if (principal) {
    call.conviteRef = ref;
    tocarSom('chamando');
    // ouve a resposta dele: atendeu / recusou
    call.pararConvite = onSnapshot(ref, (d) => {
      if (!d.exists() || call.conviteRef !== ref) return;
      const c = d.data();
      if (c.estado === 'aceita') {
        clearTimeout(call.relogio); pararSom();
        if (call.estado === 'conectada') return; // já está tudo ligado
        $('call-sub').textContent = amigoNick + ' atendeu — conectando…';
        // atendeu mas não chegou: não fica esperando pra sempre
        call.relogio = setTimeout(() => {
          if (call.conviteRef !== ref || call.estado === 'conectada') return;
          recado(amigoNick + ' atendeu, mas a conexão não fechou. Tenta de novo.', 'mal');
          sairDaCall();
        }, 60 * 1000);
      } else if (c.estado === 'recusada') {
        recado(amigoNick + ' recusou a chamada.', 'mal');
        sairDaCall();
      } else if (c.estado === 'falhou') {
        recado(amigoNick + ' atendeu, mas não conseguiu entrar na chamada.', 'mal');
        sairDaCall();
      }
    });
    // ninguém atende pra sempre
    call.relogio = setTimeout(async () => {
      if (call.conviteRef !== ref || call.estado === 'conectada') return;
      try{ await updateDoc(ref, { estado: 'semResposta' }); }catch{}
      recado(amigoNick + ' não atendeu.', 'mal');
      sairDaCall();
    }, ESPERA_ATENDER_MS);
  } else {
    // convidado extra (grupo): aparece no painel como "chamando X…" com ✕,
    // e a resposta dele vira recado — antes só o outro lado via que tocava
    const item = { nick: amigoNick, uid: amigoUid, ref, parar: null };
    call.chamando.set(ref.id, item);
    pintarCall();
    const tirar = () => { if (item.parar) { item.parar(); item.parar = null; } call.chamando.delete(ref.id); pintarCall(); };
    item.parar = onSnapshot(ref, (d) => {
      if (!d.exists() || !call.chamando.has(ref.id)) return;
      const e = d.data().estado;
      if (e === 'chamando') return;
      tirar();
      if (e === 'aceita') recado(amigoNick + ' atendeu — entrando na chamada…', 'bem');
      else if (e === 'recusada') recado(amigoNick + ' recusou.', 'mal');
      else if (e === 'semResposta') recado(amigoNick + ' não atendeu.', 'mal');
      else if (e === 'falhou') recado(amigoNick + ' atendeu, mas não conseguiu entrar.', 'mal');
    }, () => tirar());
    setTimeout(async () => {
      try{ const d = await getDoc(ref); if (d.exists() && d.data().estado === 'chamando') await updateDoc(ref, { estado: 'semResposta' }); }catch{}
    }, ESPERA_ATENDER_MS);
  }
}

function entrarEmEstado(estado, com, papel){
  call.estado = estado;
  if (estado === 'nenhuma') {
    call.com = ''; call.papel = ''; call.link = '';
    call.mudo = false; call.surdo = false; call.gpu = null; call.ping = 0; call.religando = false;
    call.extras = []; call.comUid = null; call.conectouEm = 0;
    call.chamando.forEach((c) => { if (c.parar) c.parar(); }); call.chamando.clear();
    call.gente = [];
    if (call.grupo) marcarCanalVoz(call.grupo, '');
    call.grupo = null; call.canal = null; call.grupoNome = ''; call.canalNome = '';
    if (grupo.gid) pintarGrupo();
    $('call-rede').hidden = true;
    clearTimeout(call.relogio); call.relogio = null;
    if (call.pararConvite) { call.pararConvite(); call.pararConvite = null; }
    if (call.pararAceito) { call.pararAceito(); call.pararAceito = null; }
    call.conviteRef = null;
    pararSom();
  } else {
    if (com !== undefined) call.com = com;
    if (papel !== undefined) call.papel = papel;
  }
  pintarCall();
  pintarAmigos();
}

function pintarCall(){
  const p = $('painel-call');
  const palco = $('palco');
  p.className = 'painel-call' + (call.estado === 'nenhuma' ? '' : ' tem') + (call.estado === 'conectando' ? ' conectando' : '');
  palco.classList.toggle('conectando', call.estado === 'conectando');
  $('call-girando').hidden = call.estado !== 'conectando';
  if (call.estado === 'conectando') {
    $('call-titulo').textContent = call.papel === 'chamando' ? 'Chamando…' : 'Entrando…';
    $('call-sub').textContent = call.grupo ? '🔊 ' + call.canalNome + ' · ' + call.grupoNome : call.com;
  } else if (call.estado === 'conectada') {
    $('call-titulo').textContent = call.grupo ? '🔊 ' + call.canalNome : '🔊 Em chamada';
    // quem está de fato na call (a view conta), não só quem eu chamei
    const outros = (call.gente || []).filter((g) => !g.eu).map((g) => g.nome).filter(Boolean);
    const com = outros.length ? 'com ' + outros.join(', ') : (call.grupo ? 'só você por enquanto' : 'com ' + call.com);
    $('call-sub').textContent = (call.grupo ? call.grupoNome + ' · ' : '') + com + (call.ping ? ' · ' + call.ping + ' ms' : '') + (Number.isFinite(call.gpu) ? ' · placa ' + call.gpu + '%' : '');
    $('call-rede').hidden = !call.religando;
    $('call-rede').textContent = '⟳ a conexão caiu — reconectando…';
  }
  const cx = $('call-chamando'); cx.innerHTML = '';
  cx.hidden = call.estado === 'nenhuma' || !call.chamando.size;
  call.chamando.forEach((c) => {
    const l = document.createElement('div'); l.className = 'chamando';
    const t = document.createElement('span'); t.textContent = '⏳ chamando ' + c.nick + '…';
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Parar de chamar ' + c.nick;
    x.onclick = () => { if (c.parar) { c.parar(); c.parar = null; } call.chamando.delete(c.ref.id); pintarCall(); pararMeuConvite(c.ref); };
    l.append(t, x); cx.appendChild(l);
  });
  const naCall = call.estado !== 'nenhuma';
  $('btn-mic').disabled = !naCall; $('btn-surdo').disabled = !naCall;
  $('btn-mic').classList.toggle('on', naCall && call.mudo);
  $('btn-surdo').classList.toggle('on', naCall && call.surdo);
  $('btn-mic').textContent = naCall && call.mudo ? '🔇' : '🎙';
  $('btn-surdo').textContent = naCall && call.surdo ? '🔕' : '🎧';
}

async function sairDaCall(){
  ponte.sairDaCall();           // a resposta vem por call:estado → 'encerrada'
}

// se fui eu que chamei e ele ainda não respondeu, o convite para de tocar lá
async function pararMeuConvite(ref){
  if (!ref) return;
  try{
    const atual = await getDoc(ref);
    if (!atual.exists()) return;
    const e = atual.data().estado;
    if (e === 'chamando') await updateDoc(ref, { estado: 'encerrada' });       // ele nem viu: vira "perdida" lá
    else if (e === 'aceita') await updateDoc(ref, { estado: 'desligada' });    // ele estava entrando: avisa que desliguei
  }catch{}
}

$('btn-sair-call').onclick = sairDaCall;
$('btn-mic').onclick = () => ponte.mic();
$('btn-surdo').onclick = () => ponte.surdo();
ponte.aoMudarControles((d) => { call.mudo = !!d.mudo; call.surdo = !!d.surdo; pintarCall(); });
// a placa de vídeo durante a call: mostra no painel e avisa quando está sufocada
ponte.aoMedirPlaca((d) => {
  if (call.estado === 'nenhuma') return;
  call.gpu = d.gpu;
  pintarCall();
  if (d.aviso) {
    recado('Sua placa de vídeo está a ' + d.gpu + '%. Limita o FPS do jogo (60 num monitor de 60 Hz) — a transmissão entrega o dobro de quadros com folga.', 'mal');
    ponte.notificar('Bigas Voice', 'Placa a ' + d.gpu + '%: limita o FPS do jogo pra transmitir liso');
  }
  if (d.exclusivo) {
    recado('A captura está presa em ' + d.fonte + ' quadros com a placa folgada (' + d.gpu + '%): o jogo está em TELA CHEIA EXCLUSIVA. Põe em "janela sem borda" nas opções do jogo.', 'mal');
    ponte.notificar('Bigas Voice', 'Jogo em tela cheia exclusiva: muda pra janela sem borda pra transmissão andar');
  }
});

ponte.aoMudarRede((d) => {
  if (call.estado === 'nenhuma') return;
  const mudou = call.religando !== !!d.religando;
  call.religando = !!d.religando; call.ping = Number(d.ping) || 0;
  pintarCall();
  if (mudou && call.religando) recado('A conexão caiu — reconectando…', 'mal');
  else if (mudou && !call.religando && call.estado === 'conectada') recado('Reconectou.', 'bem');
});
ponte.aoMudarGente((g) => { call.gente = Array.isArray(g) ? g : []; if (call.estado !== 'nenhuma') pintarCall(); });
ponte.aoMudarJogo((d) => {
  jogoAgora = (d && d.nome) || '';
  if (eu.uid) bater();
});
ponte.aoPararSomDoApp(() => { if (call.estado !== 'nenhuma') recado('O som do app que você estava transmitindo parou (o programa fechou?). A imagem continua.', 'mal'); });

// o processo principal conta o que aconteceu com a call de verdade
ponte.aoMudarCall(async (d) => {
  if (d.estado === 'conectando') {
    if (call.estado === 'nenhuma') entrarEmEstado('conectando');
  } else if (d.estado === 'conectada') {
    if (call.estado !== 'nenhuma') { if (!call.conectouEm) call.conectouEm = Date.now(); entrarEmEstado('conectada'); }
    pararSom();
    bater();
    if (call.grupo) marcarCanalVoz(call.grupo, call.canal);
  } else if (d.estado === 'encerrada') {
    const refs = call.extras.slice();
    if (call.com && !call.grupo) anotarNoHistorico({ tipo: call.papel === 'atendendo' ? 'recebi' : 'fiz', nick: call.com, uid: call.comUid, duracao: call.conectouEm ? Date.now() - call.conectouEm : 0 });
    else if (call.grupo) anotarNoHistorico({ tipo: 'fiz', nick: '🔊 ' + call.canalNome + ' · ' + call.grupoNome, uid: null, duracao: call.conectouEm ? Date.now() - call.conectouEm : 0 });
    entrarEmEstado('nenhuma');
    bater();
    for (const ref of refs) await pararMeuConvite(ref);
    if (d.motivo === 'caiu') recado('A chamada travou e foi fechada.', 'mal');
    else if (d.motivo === 'semInternet') recado('Sem conexão com o Bigas Voice agora.', 'mal');
    else if (d.motivo === 'semLink') recado('O servidor de sinal não respondeu. Tenta de novo.', 'mal');
  }
});

/* =====================================================================
 * RECEBER CHAMADAS — só as que ainda estão tocando (recentes)
 * =================================================================== */
function ouvirConvites(){
  const ref = query(collection(db, 'convites'), where('para', '==', eu.uid), where('estado', '==', 'chamando'));
  paradores.push(onSnapshot(ref, (snap) => {
    convitesChegando = snap.docs;
    pintarConvite();
  }, (e) => { console.error(e); recado('Não consegui ligar o aviso de chamadas.', 'mal'); }));
}

function conviteVivo(d){
  const c = d.data();
  if (bloqueados.has(c.de)) return false;
  const t = ms(c.quando);
  if (!t) return true; // ainda sem carimbo do servidor: acabou de nascer
  return Date.now() - t < CONVITE_VALE_MS;
}

let tocandoId = null;
function pintarConvite(){
  const caixa = $('convite');
  const vivo = convitesChegando.find(conviteVivo);
  if (!vivo) {
    caixa.className = 'convite';
    if (tocandoId) { tocandoId = null; if (somTipo === 'chamada') pararSom(); ponte.tocar(false); }
    return;
  }
  const c = vivo.data();
  caixa.className = 'convite tem';
  $('convite-nick').textContent = c.deNick;
  $('convite-av').textContent = iniciais(c.deNick);
  $('convite-sub').textContent = call.estado !== 'nenhuma' && c.link === call.link ? 'está te chamando (mesma chamada)' : 'está te chamando';
  if (tocandoId !== vivo.id) {
    tocandoId = vivo.id;
    if (call.estado === 'nenhuma') tocarSom('chamada');
    ponte.tocar(true, c.deNick);
  }

  $('btn-atender').onclick = async () => {
    $('btn-atender').disabled = true; $('btn-recusar').disabled = true;
    pararSom(); ponte.tocar(false);
    try{
      // só aceita se AINDA está tocando: se quem chamou desistiu há 1 s, não
      // sobrescreve o "não atendeu" nem joga você numa sala vazia
      const aceitou = await runTransaction(db, async (tx) => {
        const d = await tx.get(vivo.ref);
        if (!d.exists() || d.data().estado !== 'chamando') return false;
        tx.update(vivo.ref, { estado: 'aceita' });
        return true;
      });
      if (!aceitou) { recado('Essa chamada já acabou.', 'mal'); convitesChegando = convitesChegando.filter((d) => d.id !== vivo.id); pintarConvite(); return; }
      if (call.estado !== 'nenhuma' && c.link === call.link) { recado('Você já está nessa chamada.', ''); return; }
      // já estava numa call? ela dá lugar a esta (o app fecha a antiga
      // sem avisar 'encerrada' — a casa mesma faz a limpeza aqui)
      if (call.estado !== 'nenhuma') {
        const antigos = call.extras.slice();
        entrarEmEstado('nenhuma');
        antigos.forEach((r) => pararMeuConvite(r));
      }
      entrarEmEstado('conectando', c.deNick, 'atendendo');
      call.link = c.link;
      call.comUid = c.de;
      $('conectando-txt').textContent = 'Entrando na chamada de ' + c.deNick + '…';
      mandarRectDoPalco();
      // se quem chamou desligar enquanto eu entro, eu saio junto
      call.pararAceito = onSnapshot(vivo.ref, (d) => {
        if (!d.exists() || call.estado !== 'conectando') return;
        if (d.data().estado === 'desligada') { recado(c.deNick + ' desligou.', 'mal'); sairDaCall(); }
      });
      const ok = await ponte.entrarComLink(c.link, eu.nick, c.deNick);
      if (!ok) {
        if (call.estado !== 'nenhuma') entrarEmEstado('nenhuma');
        recado('Não consegui entrar na chamada.', 'mal');
        updateDoc(vivo.ref, { estado: 'falhou' }).catch(() => {}); // quem chamou fica sabendo
      }
    }catch(e){
      console.error(e); recado('Não consegui atender: ' + traduzirErro(e), 'mal');
    }finally{ $('btn-atender').disabled = false; $('btn-recusar').disabled = false; }
  };
  $('btn-recusar').onclick = async () => {
    try{ await updateDoc(vivo.ref, { estado: 'recusada' }); }catch{}
  };
}

/* =====================================================================
 * CHAMADAS PERDIDAS
 * =================================================================== */
function ouvirPerdidas(){
  // dois ouvidos (um por estado) em vez de um "in": só igualdade nunca
  // precisa de índice composto no Firestore
  const partes = { semResposta: [], encerrada: [] };
  for (const estado of Object.keys(partes)) {
    const ref = query(collection(db, 'convites'), where('para', '==', eu.uid), where('estado', '==', estado));
    paradores.push(onSnapshot(ref, (snap) => {
      partes[estado] = snap.docs;
      perdidas = partes.semResposta.concat(partes.encerrada);
      pintarPerdidas();
      // vai pro histórico deste PC uma vez só (o id do convite marca)
      snap.docChanges().forEach((ch) => {
        if (ch.type !== 'added') return;
        const c = ch.doc.data(); const t = ms(c.quando);
        if (!t || t < carregadoEm - PERDIDA_VALE_MS) return;
        const h = historicoLer();
        if (h.some((x) => x.convite === ch.doc.id)) return;
        anotarNoHistorico({ tipo: 'perdida', nick: c.deNick, uid: c.de, convite: ch.doc.id, quando: t });
      });
    }, (e) => console.error(e)));
  }
}
function pintarPerdidas(){
  const vistoAte = Number(lerLocal('perdidasVistoAte:' + eu.uid, 0)) || 0;
  const agora = Date.now();
  const vivas = perdidas
    .map((d) => d.data())
    .filter((c) => { const t = ms(c.quando); return t && t > vistoAte && agora - t < PERDIDA_VALE_MS && !bloqueados.has(c.de); })
    .sort((a, b) => ms(b.quando) - ms(a.quando))
    .slice(0, 8);
  $('bloco-perdidas').hidden = !vivas.length;
  const caixa = $('perdidas'); caixa.innerHTML = '';
  vivas.forEach((c) => {
    const el = document.createElement('div'); el.className = 'cartinha perdida';
    const av = document.createElement('div'); av.className = 'avatar'; av.textContent = iniciais(c.deNick);
    const txt = document.createElement('div'); txt.className = 'txt';
    const b = document.createElement('b'); b.textContent = c.deNick + ' te ligou';
    const s = document.createElement('small'); s.textContent = dia(c.quando) + ' às ' + hora(c.quando);
    txt.append(b, s);
    const voltar = document.createElement('button'); voltar.className = 'sim'; voltar.textContent = '📞'; voltar.title = 'Ligar de volta';
    voltar.onclick = () => { const a = amigos.get(c.de); if (a) chamarAmigo(c.de, a.nick); else recado(c.deNick + ' não está mais na sua lista.', 'mal'); };
    el.append(av, txt, voltar);
    caixa.appendChild(el);
  });
}
$('btn-limpar-perdidas').onclick = () => { guardarLocal('perdidasVistoAte:' + eu.uid, Date.now()); pintarPerdidas(); };

/* =====================================================================
 * GRUPOS ("servidores") — canais de texto, canais de voz, membros
 * ---------------------------------------------------------------------
 * Um grupo tem dono, código de entrada (6 letras), canais de texto (chat
 * com histórico, igual o DM) e canais de voz. Um canal de voz é uma SALA
 * FIXA do site (o link nunca muda): entrar no canal = entrar nessa sala,
 * sem tocar pra ninguém — quem está dentro aparece na lista.
 * =================================================================== */
const grupos = new Map();   // gid → { nome, dono, codigo, cor, parar }
const grupo = { gid: null, dados: null, canais: new Map(), membros: new Map(), presenca: new Map(), parar: [] };

function corDoGrupo(gid){ let h = 0; for (const c of String(gid)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 'hsl(' + (h % 360) + ' 55% 42%)'; }
function idAleatorio(n){ const a = 'abcdefghijkmnopqrstuvwxyz23456789'; const b = crypto.getRandomValues(new Uint8Array(n)); return Array.from(b, (x) => a[x % a.length]).join(''); }
function codigoNovo(){ const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.getRandomValues(new Uint8Array(6)); return Array.from(b, (x) => a[x % a.length]).join(''); }
function b64u(bytes){ return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
// a sala fixa de um canal de voz: o MESMO formato de link do site (#e=<id>~<chave>);
// o site continua fazendo tudo (cifra, sinal, malha) — aqui só se sorteia id e chave
function linkDeCanal(){ return SITE + '#e=' + idAleatorio(12) + '~' + b64u(crypto.getRandomValues(new Uint8Array(16))); }
function souDono(){ const g = grupos.get(grupo.gid); return !!(g && g.dono === eu.uid); }

function ouvirGrupos(){
  paradores.push(onSnapshot(collection(db, 'usuarios', eu.uid, 'grupos'), (snap) => {
    const vivos = new Set();
    snap.forEach((d) => {
      vivos.add(d.id);
      if (grupos.has(d.id)) return;
      const g = { nome: d.data().nome || '…', dono: '', codigo: '', cor: corDoGrupo(d.id), parar: null };
      g.parar = onSnapshot(doc(db, 'grupos', d.id), (u) => {
        if (!u.exists()) { sairDoGrupoLocal(d.id); return; } // o grupo foi apagado
        g.nome = u.data().nome || g.nome; g.dono = u.data().dono; g.codigo = u.data().codigo;
        if (grupo.gid === d.id) { grupo.dados = u.data(); pintarGrupo(); }
        pintarTrilho();
      }, (e) => { if (e && e.code === 'permission-denied') sairDoGrupoLocal(d.id); }); // fui tirado do grupo
      grupos.set(d.id, g);
    });
    grupos.forEach((g, id) => { if (!vivos.has(id)) { if (g.parar) g.parar(); grupos.delete(id); if (grupo.gid === id) fecharGrupo(); } });
    pintarTrilho(); pintarPedidos();
  }, (e) => console.error(e)));
}
// o grupo sumiu ou me tiraram: some do meu índice (e do trilho)
function sairDoGrupoLocal(gid){
  deleteDoc(doc(db, 'usuarios', eu.uid, 'grupos', gid)).catch(() => {});
  if (grupo.gid === gid) { fecharGrupo(); recado('Você não está mais nesse grupo.', ''); }
}

function pintarTrilho(){
  const t = $('trilho-grupos'); t.innerHTML = '';
  [...grupos.entries()].sort((a, b) => a[1].nome.localeCompare(b[1].nome)).forEach(([gid, g]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'grupo-ic' + (grupo.gid === gid ? ' ativo' : '');
    b.style.background = g.cor; b.textContent = iniciais(g.nome); b.title = g.nome;
    b.onclick = () => { if (grupo.gid === gid) fecharGrupo(); else abrirGrupo(gid); };
    t.appendChild(b);
  });
  $('btn-casa').classList.toggle('ativo', !grupo.gid);
}

function abrirGrupo(gid){
  fecharGrupo();
  grupo.gid = gid;
  const g = grupos.get(gid);
  $('cab-amigos').hidden = true; $('add-amigo').hidden = true; $('erro-add').hidden = true; $('lista-amigos').parentElement.hidden = true;
  $('cab-grupo').hidden = false; $('rolagem-grupo').hidden = false;
  $('grupo-nome').textContent = g ? g.nome : '…';
  grupo.parar.push(onSnapshot(collection(db, 'grupos', gid, 'canais'), (snap) => {
    grupo.canais.clear();
    snap.forEach((d) => grupo.canais.set(d.id, Object.assign({ id: d.id }, d.data())));
    // o canal de texto aberto sumiu?
    if (chat.grupo && chat.grupo.gid === gid && !grupo.canais.has(chat.grupo.cid)) fecharChat();
    pintarGrupo();
  }, (e) => { console.error(e); if (e.code === 'permission-denied') sairDoGrupoLocal(gid); }));
  grupo.parar.push(onSnapshot(collection(db, 'grupos', gid, 'membros'), (snap) => {
    const vivos = new Set();
    snap.forEach((d) => {
      vivos.add(d.id);
      grupo.membros.set(d.id, Object.assign({ uid: d.id }, d.data()));
      if (!grupo.presenca.has(d.id)) {
        const pr = { dados: null, parar: null };
        pr.parar = onSnapshot(doc(db, 'usuarios', d.id), (u) => { pr.dados = u.exists() ? u.data() : null; pintarGrupo(); }, () => {});
        grupo.presenca.set(d.id, pr);
      }
    });
    [...grupo.membros.keys()].forEach((id) => { if (!vivos.has(id)) { grupo.membros.delete(id); const pr = grupo.presenca.get(id); if (pr && pr.parar) pr.parar(); grupo.presenca.delete(id); } });
    if (!vivos.has(eu.uid)) { sairDoGrupoLocal(gid); return; } // me expulsaram
    pintarGrupo();
  }, (e) => { console.error(e); if (e.code === 'permission-denied') sairDoGrupoLocal(gid); }));
  pintarTrilho(); pintarPedidos(); pintarGrupo();
}
function fecharGrupo(){
  grupo.parar.forEach((p) => { try { p(); } catch {} }); grupo.parar = [];
  grupo.presenca.forEach((pr) => { if (pr.parar) pr.parar(); }); grupo.presenca.clear();
  grupo.canais.clear(); grupo.membros.clear(); grupo.gid = null; grupo.dados = null;
  if (chat.grupo) fecharChat();
  $('cab-amigos').hidden = false; $('add-amigo').hidden = false; $('erro-add').hidden = false; $('lista-amigos').parentElement.hidden = false;
  $('cab-grupo').hidden = true; $('rolagem-grupo').hidden = true;
  pintarTrilho(); pintarPedidos();
}
$('btn-casa').onclick = () => fecharGrupo();

function noCanal(cid){
  // quem está dentro de um canal de voz: canalVoz marcado e batida recente
  return [...grupo.membros.values()].filter((m) => m.canalVoz === cid && ms(m.vistoEm) && Date.now() - ms(m.vistoEm) < OFFLINE_APOS_MS);
}
function pintarGrupo(){
  if (!grupo.gid) return;
  const g = grupos.get(grupo.gid);
  $('grupo-nome').textContent = g ? g.nome : '…';
  const dono = souDono();
  $('btn-novo-canal').hidden = !dono;
  const canais = [...grupo.canais.values()].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || String(a.nome).localeCompare(String(b.nome)));
  // categorias (como no Discord): a ordem é a do primeiro canal de cada uma; sem categoria fica no topo
  const categorias = [];
  canais.forEach((c) => { const k = String(c.categoria || ''); if (!categorias.includes(k)) categorias.push(k); });
  categorias.sort((a, b) => (a === '') - (b === '') || 0);
  const raiz = $('canais'); raiz.innerHTML = '';
  const pintarTexto = (c, lista) => {
    const el = document.createElement('div'); el.className = 'canal' + (chat.grupo && chat.grupo.cid === c.id ? ' aberto' : '');
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '#';
    const n = document.createElement('span'); n.className = 'nome'; n.textContent = c.nome;
    el.append(tag, n);
    el.onclick = () => abrirCanalTexto(c.id);
    el.oncontextmenu = (ev) => { ev.preventDefault(); abrirMenuCanal(c, ev.clientX, ev.clientY); };
    lista.appendChild(el);
  };
  const pintarVoz = (c, cv) => {
    const dentro = noCanal(c.id);
    const euDentro = call.grupo === grupo.gid && call.canal === c.id && call.estado !== 'nenhuma';
    const el = document.createElement('div'); el.className = 'canal canal-voz' + (euDentro ? ' nele' : '');
    const linha = document.createElement('div'); linha.className = 'linha';
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '🔊';
    const n = document.createElement('span'); n.className = 'nome'; n.textContent = c.nome;
    linha.append(tag, n);
    if (dentro.length) { const k = document.createElement('small'); k.style.color = 'var(--txt3)'; k.textContent = String(dentro.length); linha.appendChild(k); }
    el.appendChild(linha);
    if (dentro.length) {
      const lista = document.createElement('div'); lista.className = 'dentro';
      dentro.forEach((m) => {
        const p = document.createElement('div'); p.className = 'p';
        const av = document.createElement('div'); av.className = 'avatar'; av.textContent = iniciais(m.nick);
        const nm = document.createElement('span'); nm.textContent = m.nick + (m.uid === eu.uid ? ' (você)' : '');
        p.append(av, nm); lista.appendChild(p);
      });
      el.appendChild(lista);
    }
    el.onclick = () => entrarNoCanalDeVoz(c.id);
    el.oncontextmenu = (ev) => { ev.preventDefault(); abrirMenuCanal(c, ev.clientX, ev.clientY); };
    cv.appendChild(el);
  };
  categorias.forEach((cat) => {
    if (cat) {
      const h = document.createElement('div'); h.className = 'categoria';
      const t = document.createElement('span'); t.textContent = cat; h.appendChild(t);
      if (dono) {
        const mais = document.createElement('button'); mais.type = 'button'; mais.className = 'mais'; mais.textContent = '+'; mais.title = 'Novo canal em ' + cat;
        mais.onclick = (ev) => { ev.stopPropagation(); abrirNovoCanal('texto', cat); };
        h.appendChild(mais);
        h.oncontextmenu = (ev) => { ev.preventDefault(); abrirMenuCategoria(cat, ev.clientX, ev.clientY); };
      }
      raiz.appendChild(h);
    }
    const lista = document.createElement('div'); lista.className = 'lista';
    canais.filter((c) => String(c.categoria || '') === cat).forEach((c) => { if (c.tipo === 'voz') pintarVoz(c, lista); else pintarTexto(c, lista); });
    raiz.appendChild(lista);
  });
  const dl = $('categorias-existentes'); dl.innerHTML = '';
  categorias.filter(Boolean).forEach((cat) => { const o = document.createElement('option'); o.value = cat; dl.appendChild(o); });
  const membros = [...grupo.membros.values()].map((m) => { const pr = grupo.presenca.get(m.uid); return { m, p: presencaDe({ presenca: pr ? pr.dados : null }) }; })
    .sort((x, y) => ((x.p === 'offline') - (y.p === 'offline')) || (x.m.papel === 'dono' ? -1 : 0) - (y.m.papel === 'dono' ? -1 : 0) || String(x.m.nick).localeCompare(String(y.m.nick)));
  $('titulo-membros').textContent = 'Membros — ' + membros.length;
  const lm = $('membros'); lm.innerHTML = '';
  membros.forEach(({ m, p }) => {
    const linha = document.createElement('div'); linha.className = 'amigo membro ' + p;
    const av = document.createElement('div'); av.className = 'avatar'; av.textContent = iniciais(m.nick);
    const luz = document.createElement('span'); luz.className = 'luz'; av.appendChild(luz);
    const txt = document.createElement('div'); txt.className = 'txt';
    const nome = document.createElement('div'); nome.className = 'nome'; nome.textContent = m.nick + (m.uid === eu.uid ? ' (você)' : '');
    const estado = document.createElement('div'); estado.className = 'estado' + (g && g.dono === m.uid ? ' dono' : '');
    const pr = grupo.presenca.get(m.uid); const jogo = p !== 'offline' && pr && pr.dados && pr.dados.jogando ? pr.dados.jogando : '';
    estado.textContent = (g && g.dono === m.uid ? 'dono · ' : '') + (jogo ? '🎮 ' + jogo : p === 'emcall' ? 'em chamada' : p);
    txt.append(nome, estado);
    linha.append(av, txt);
    linha.oncontextmenu = (ev) => { ev.preventDefault(); abrirMenuMembro(m, ev.clientX, ev.clientY); };
    lm.appendChild(linha);
  });
}

/* ---- entrar / criar / código ---- */
// os modais cobrem a janela inteira — e a view da call ficaria por cima
// deles no palco. Enquanto um modal está aberto, a view some (a call continua).
function abrirModal(id){ $(id).classList.add('mostra'); ponte.viewVisivel(false); }
function fecharModal(id){ $(id).classList.remove('mostra'); if (!document.querySelector('.modal.mostra') && !$('tela-ajustes').classList.contains('mostra')) ponte.viewVisivel(true); }
$('btn-novo-grupo').onclick = () => { $('erro-grupo').textContent = ''; $('erro-codigo').textContent = ''; $('grupo-novo-nome').value = ''; $('grupo-codigo').value = ''; $('grupo-estrutura').value = ''; abrirModal('modal-grupo'); setTimeout(() => $('grupo-novo-nome').focus(), 50); };
$('aba-criar').onclick = () => { $('aba-criar').classList.add('ativa'); $('aba-entrar').classList.remove('ativa'); $('pag-criar').hidden = false; $('pag-entrar').hidden = true; $('grupo-novo-nome').focus(); };
$('aba-entrar').onclick = () => { $('aba-entrar').classList.add('ativa'); $('aba-criar').classList.remove('ativa'); $('pag-entrar').hidden = false; $('pag-criar').hidden = true; $('grupo-codigo').focus(); };
$('btn-grupo-cancelar').onclick = () => fecharModal('modal-grupo');
$('btn-codigo-cancelar').onclick = () => fecharModal('modal-grupo');
document.querySelectorAll('.modal').forEach((m) => { m.addEventListener('click', (ev) => { if (ev.target === m) fecharModal(m.id); }); });

// "estrutura" = o texto do campo Canais: "# nome" texto, "🔊 nome"/"voz nome" voz, o resto é categoria
function lerEstrutura(texto){
  const canais = []; let categoria = '';
  String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => {
    let m;
    if ((m = /^#\s*(.+)$/.exec(l))) canais.push({ nome: m[1].trim().slice(0, 24), tipo: 'texto', categoria });
    else if ((m = /^(?:🔊|🔉|🔈|voz[:\s]|call[:\s])\s*(.+)$/i.exec(l))) canais.push({ nome: m[1].trim().slice(0, 24), tipo: 'voz', categoria });
    else categoria = l.replace(/[▾▸⌄›:]+$/, '').trim().slice(0, 24);
  });
  return canais;
}
async function criarGrupo(nome, estrutura){
  const gref = doc(collection(db, 'grupos'));
  const codigo = codigoNovo();
  await setDoc(gref, { nome, dono: eu.uid, donoNick: eu.nick, codigo, criadoEm: serverTimestamp() });
  await setDoc(doc(db, 'grupos', gref.id, 'membros', eu.uid), { nick: eu.nick, papel: 'dono', entrouEm: serverTimestamp(), canalVoz: '', vistoEm: serverTimestamp() });
  let lista = lerEstrutura(estrutura);
  if (!lista.length) lista = [{ nome: 'geral', tipo: 'texto', categoria: '' }, { nome: 'Geral', tipo: 'voz', categoria: '' }];
  let ordem = 0;
  for (const c of lista) {
    const dados = { nome: c.nome, tipo: c.tipo, categoria: c.categoria || '', ordem: ordem++, criadoEm: serverTimestamp() };
    if (c.tipo === 'voz') dados.link = linkDeCanal();
    await addDoc(collection(db, 'grupos', gref.id, 'canais'), dados);
  }
  await setDoc(doc(db, 'codigosDeGrupo', codigo), { gid: gref.id, nome });
  await setDoc(doc(db, 'usuarios', eu.uid, 'grupos', gref.id), { nome, entrouEm: serverTimestamp() });
  return gref.id;
}
async function entrarPorCodigo(codigo){
  codigo = String(codigo || '').trim().toUpperCase();
  const c = await getDoc(doc(db, 'codigosDeGrupo', codigo));
  if (!c.exists()) throw Object.assign(new Error('código não existe'), { code: 'codigo' });
  const { gid, nome } = c.data();
  await setDoc(doc(db, 'grupos', gid, 'membros', eu.uid), { nick: eu.nick, papel: 'membro', entrouEm: serverTimestamp(), canalVoz: '', vistoEm: serverTimestamp(), codigo });
  await setDoc(doc(db, 'usuarios', eu.uid, 'grupos', gid), { nome, entrouEm: serverTimestamp() });
  return gid;
}
$('btn-grupo-criar').onclick = async () => {
  const nome = $('grupo-novo-nome').value.trim();
  if (nome.length < 2) { $('erro-grupo').textContent = 'Dá um nome com pelo menos 2 letras.'; return; }
  $('btn-grupo-criar').disabled = true;
  try{ const gid = await criarGrupo(nome, $('grupo-estrutura').value); fecharModal('modal-grupo'); recado('Grupo "' + nome + '" criado. Convida os amigos em ⋯.', 'bem'); setTimeout(() => abrirGrupo(gid), 300); }
  catch(e){ console.error(e); $('erro-grupo').textContent = e && e.code === 'permission-denied' ? 'O servidor recusou (as regras de grupos não foram publicadas).' : 'Não consegui criar (' + ((e && e.code) || 'erro') + ').'; }
  finally{ $('btn-grupo-criar').disabled = false; }
};
$('btn-codigo-entrar').onclick = async () => {
  const codigo = $('grupo-codigo').value.trim().toUpperCase();
  if (codigo.length < 4) { $('erro-codigo').textContent = 'Digita o código do grupo.'; return; }
  $('btn-codigo-entrar').disabled = true;
  try{ const gid = await entrarPorCodigo(codigo); fecharModal('modal-grupo'); recado('Você entrou no grupo.', 'bem'); setTimeout(() => abrirGrupo(gid), 300); }
  catch(e){ console.error(e); $('erro-codigo').textContent = e && e.code === 'codigo' ? 'Esse código não existe.' : e && e.code === 'permission-denied' ? 'O servidor recusou esse código.' : 'Não consegui entrar (' + ((e && e.code) || 'erro') + ').'; }
  finally{ $('btn-codigo-entrar').disabled = false; }
};
$('grupo-novo-nome').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('btn-grupo-criar').click(); });
$('grupo-codigo').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('btn-codigo-entrar').click(); });

/* ---- menu do grupo (⋯): convidar, código, renomear, sair, apagar ---- */
$('btn-menu-grupo').onclick = (ev) => {
  const g = grupos.get(grupo.gid); if (!g) return;
  const m = $('menu-amigo'); m.innerHTML = '';
  const item = (rotulo, fn, perigo) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = rotulo; if (perigo) b.className = 'perigo'; b.onclick = () => { fecharMenuAmigo(); fn(); }; m.appendChild(b); };
  item('👥 Convidar amigo', abrirConvidar);
  if (souDono()) item('➕ Novo canal / categoria', () => abrirNovoCanal('texto', ''));
  item('🔑 Copiar código (' + (g.codigo || '…') + ')', async () => { try { await navigator.clipboard.writeText(g.codigo); recado('Código ' + g.codigo + ' copiado. Quem digitar em + › Entrar com código entra no grupo.', 'bem'); } catch { recado('Código do grupo: ' + g.codigo, ''); } });
  if (souDono()) {
    item('✏️ Renomear grupo', async () => { const n = prompt('Novo nome do grupo:', g.nome); if (!n || n.trim().length < 2) return; try { await updateDoc(doc(db, 'grupos', grupo.gid), { nome: n.trim().slice(0, 30) }); await setDoc(doc(db, 'usuarios', eu.uid, 'grupos', grupo.gid), { nome: n.trim().slice(0, 30) }, { merge: true }); } catch { recado('Não consegui renomear.', 'mal'); } });
    item('🗑 Apagar grupo', apagarGrupo, true);
  } else item('🚪 Sair do grupo', sairDoGrupo, true);
  m.classList.add('mostra');
  const r = ev.currentTarget.getBoundingClientRect();
  posicionarMenu(m, r.left, r.bottom + 4);
  setTimeout(() => document.addEventListener('click', fecharMenuAmigo, { once: true }), 0);
};
async function sairDoGrupo(){
  const g = grupos.get(grupo.gid); if (!g) return;
  if (!confirm('Sair do grupo "' + g.nome + '"?')) return;
  const gid = grupo.gid;
  if (call.grupo === gid) sairDaCall();
  try{ await deleteDoc(doc(db, 'grupos', gid, 'membros', eu.uid)); }catch{}
  await deleteDoc(doc(db, 'usuarios', eu.uid, 'grupos', gid)).catch(() => {});
  fecharGrupo();
}
async function apagarGrupo(){
  const g = grupos.get(grupo.gid); if (!g) return;
  if (!confirm('Apagar o grupo "' + g.nome + '" pra todo mundo? Não tem volta.')) return;
  const gid = grupo.gid;
  if (call.grupo === gid) sairDaCall();
  try{
    // apaga o que dá: canais e membros (as mensagens antigas ficam órfãs e inacessíveis — as regras exigem membro)
    const cs = await getDocs(collection(db, 'grupos', gid, 'canais')); for (const d of cs.docs) await deleteDoc(d.ref).catch(() => {});
    const ms2 = await getDocs(collection(db, 'grupos', gid, 'membros')); for (const d of ms2.docs) if (d.id !== eu.uid) await deleteDoc(d.ref).catch(() => {});
    if (g.codigo) await deleteDoc(doc(db, 'codigosDeGrupo', g.codigo)).catch(() => {});
    await deleteDoc(doc(db, 'grupos', gid, 'membros', eu.uid)).catch(() => {});
    await deleteDoc(doc(db, 'grupos', gid));
  }catch(e){ console.error(e); recado('Não consegui apagar tudo (' + ((e && e.code) || 'erro') + ').', 'mal'); }
  await deleteDoc(doc(db, 'usuarios', eu.uid, 'grupos', gid)).catch(() => {});
  fecharGrupo();
}

/* ---- convidar amigos (vira um pedido com estado 'grupo') ---- */
function abrirConvidar(){
  const g = grupos.get(grupo.gid); if (!g) return;
  $('convidar-titulo').textContent = 'Convidar pro grupo ' + g.nome;
  const lista = $('lista-convidar'); lista.innerHTML = '';
  const candidatos = [...amigos.entries()].filter(([uid]) => !grupo.membros.has(uid)).sort((a, b) => a[1].nick.localeCompare(b[1].nick));
  if (!candidatos.length) lista.innerHTML = '<p class="vazio">Todos os seus amigos já estão no grupo (ou você ainda não tem amigos na lista).</p>';
  candidatos.forEach(([uid, a]) => {
    const linha = document.createElement('div'); linha.className = 'amigo ' + presencaDe(a);
    const av = document.createElement('div'); av.className = 'avatar'; av.textContent = iniciais(a.nick);
    const luz = document.createElement('span'); luz.className = 'luz'; av.appendChild(luz);
    const txt = document.createElement('div'); txt.className = 'txt';
    const nome = document.createElement('div'); nome.className = 'nome'; nome.textContent = a.nick; txt.appendChild(nome);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'b-azul'; b.textContent = 'Convidar';
    b.onclick = async () => { b.disabled = true; try { await convidarParaGrupo(uid, a.nick); b.textContent = 'Convidado ✓'; } catch (e) { console.error(e); b.disabled = false; recado('Não consegui convidar ' + a.nick + '.', 'mal'); } };
    linha.append(av, txt, b); lista.appendChild(linha);
  });
  abrirModal('modal-convidar');
}
$('btn-convidar-fechar').onclick = () => fecharModal('modal-convidar');
async function convidarParaGrupo(uid, nick){
  const g = grupos.get(grupo.gid);
  await addDoc(collection(db, 'pedidos'), { de: eu.uid, deNick: eu.nick, para: uid, paraNick: nick, estado: 'grupo', gid: grupo.gid, gnome: g.nome, codigo: g.codigo, quando: serverTimestamp() });
}

/* ---- canais: criar / renomear / apagar (dono) ---- */
let canalNovoTipo = 'texto';
function pintarTipoCanal(){ $('canal-tipo-texto').classList.toggle('ativa', canalNovoTipo === 'texto'); $('canal-tipo-voz').classList.toggle('ativa', canalNovoTipo === 'voz'); }
function abrirNovoCanal(tipo, categoria){
  canalNovoTipo = tipo || 'texto'; pintarTipoCanal();
  $('canal-titulo').textContent = 'Novo canal'; $('canal-nome').value = ''; $('canal-categoria').value = categoria || ''; $('erro-canal').textContent = '';
  abrirModal('modal-canal'); setTimeout(() => $('canal-nome').focus(), 50);
}
$('btn-novo-canal').onclick = () => abrirNovoCanal('texto', '');
$('canal-tipo-texto').onclick = () => { canalNovoTipo = 'texto'; pintarTipoCanal(); };
$('canal-tipo-voz').onclick = () => { canalNovoTipo = 'voz'; pintarTipoCanal(); };
$('btn-canal-cancelar').onclick = () => fecharModal('modal-canal');
$('btn-canal-criar').onclick = async () => {
  const nome = $('canal-nome').value.trim().replace(/^#/, '');
  if (nome.length < 1) { $('erro-canal').textContent = 'Dá um nome pro canal.'; return; }
  $('btn-canal-criar').disabled = true;
  try{
    const ordem = grupo.canais.size;
    const dados = { nome: nome.slice(0, 24), tipo: canalNovoTipo, categoria: $('canal-categoria').value.trim().slice(0, 24), ordem, criadoEm: serverTimestamp() };
    if (canalNovoTipo === 'voz') dados.link = linkDeCanal();
    await addDoc(collection(db, 'grupos', grupo.gid, 'canais'), dados);
    fecharModal('modal-canal');
  }catch(e){ console.error(e); $('erro-canal').textContent = 'Não consegui criar (' + ((e && e.code) || 'erro') + ').'; }
  finally{ $('btn-canal-criar').disabled = false; }
};
$('canal-nome').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('btn-canal-criar').click(); });
function abrirMenuCanal(c, x, y){
  if (!souDono()) return;
  const m = $('menu-amigo'); m.innerHTML = '';
  const item = (rotulo, fn, perigo) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = rotulo; if (perigo) b.className = 'perigo'; b.onclick = () => { fecharMenuAmigo(); fn(); }; m.appendChild(b); };
  item('✏️ Renomear canal', async () => { const n = prompt('Novo nome do canal:', c.nome); if (!n || !n.trim()) return; try { await updateDoc(doc(db, 'grupos', grupo.gid, 'canais', c.id), { nome: n.trim().replace(/^#/, '').slice(0, 24) }); } catch { recado('Não consegui renomear.', 'mal'); } });
  item('📁 Mover pra categoria…', async () => { const n = prompt('Categoria (vazio = nenhuma):', c.categoria || ''); if (n === null) return; try { await updateDoc(doc(db, 'grupos', grupo.gid, 'canais', c.id), { categoria: n.trim().slice(0, 24) }); } catch { recado('Não consegui mover.', 'mal'); } });
  item('⬆ Subir', () => moverCanal(c, -1));
  item('⬇ Descer', () => moverCanal(c, +1));
  item('🗑 Apagar canal', async () => { if (!confirm('Apagar o canal "' + c.nome + '"?')) return; if (call.grupo === grupo.gid && call.canal === c.id) sairDaCall(); try { await deleteDoc(doc(db, 'grupos', grupo.gid, 'canais', c.id)); } catch { recado('Não consegui apagar.', 'mal'); } }, true);
  m.classList.add('mostra');
  posicionarMenu(m, x, y);
  setTimeout(() => document.addEventListener('click', fecharMenuAmigo, { once: true }), 0);
}
// troca a ordem com o vizinho da mesma categoria
async function moverCanal(c, direcao){
  const irmaos = [...grupo.canais.values()].filter((x) => String(x.categoria || '') === String(c.categoria || '')).sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  const i = irmaos.findIndex((x) => x.id === c.id); const j = i + direcao;
  if (i < 0 || j < 0 || j >= irmaos.length) return;
  const a = irmaos[i], b = irmaos[j];
  const oa = a.ordem || 0, ob = b.ordem || 0;
  try{
    await updateDoc(doc(db, 'grupos', grupo.gid, 'canais', a.id), { ordem: oa === ob ? ob + direcao : ob });
    await updateDoc(doc(db, 'grupos', grupo.gid, 'canais', b.id), { ordem: oa === ob ? oa : oa });
  }catch{ recado('Não consegui mover.', 'mal'); }
}
function abrirMenuCategoria(cat, x, y){
  if (!souDono()) return;
  const m = $('menu-amigo'); m.innerHTML = '';
  const item = (rotulo, fn, perigo) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = rotulo; if (perigo) b.className = 'perigo'; b.onclick = () => { fecharMenuAmigo(); fn(); }; m.appendChild(b); };
  const dela = () => [...grupo.canais.values()].filter((c) => String(c.categoria || '') === cat);
  item('➕ Novo canal aqui', () => abrirNovoCanal('texto', cat));
  item('✏️ Renomear categoria', async () => { const n = prompt('Novo nome da categoria:', cat); if (!n || !n.trim()) return; try { for (const c of dela()) await updateDoc(doc(db, 'grupos', grupo.gid, 'canais', c.id), { categoria: n.trim().slice(0, 24) }); } catch { recado('Não consegui renomear.', 'mal'); } });
  item('🗑 Desfazer categoria (os canais ficam)', async () => { try { for (const c of dela()) await updateDoc(doc(db, 'grupos', grupo.gid, 'canais', c.id), { categoria: '' }); } catch { recado('Não consegui.', 'mal'); } }, true);
  m.classList.add('mostra');
  posicionarMenu(m, x, y);
  setTimeout(() => document.addEventListener('click', fecharMenuAmigo, { once: true }), 0);
}
function abrirMenuMembro(mb, x, y){
  if (mb.uid === eu.uid) return;
  const m = $('menu-amigo'); m.innerHTML = '';
  const item = (rotulo, fn, perigo) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = rotulo; if (perigo) b.className = 'perigo'; b.onclick = () => { fecharMenuAmigo(); fn(); }; m.appendChild(b); };
  if (amigos.has(mb.uid)) item('💬 Conversar', () => abrirChat(mb.uid, mb.nick));
  else item('➕ Pedir amizade', () => { $('add-nick').value = mb.nick; fecharGrupo(); $('btn-add').click(); });
  if (souDono()) item('🚫 Tirar do grupo', async () => { if (!confirm('Tirar ' + mb.nick + ' do grupo?')) return; try { await deleteDoc(doc(db, 'grupos', grupo.gid, 'membros', mb.uid)); } catch { recado('Não consegui tirar.', 'mal'); } }, true);
  if (!m.children.length) return;
  m.classList.add('mostra');
  posicionarMenu(m, x, y);
  setTimeout(() => document.addEventListener('click', fecharMenuAmigo, { once: true }), 0);
}

/* ---- canal de voz: entrar = entrar na sala fixa do canal ---- */
function marcarCanalVoz(gid, cid){
  if (!eu.uid || !gid) return;
  updateDoc(doc(db, 'grupos', gid, 'membros', eu.uid), { canalVoz: cid || '', vistoEm: serverTimestamp() }).catch(() => {});
}
async function entrarNoCanalDeVoz(cid){
  const c = grupo.canais.get(cid); if (!c || !c.link) return;
  if (call.grupo === grupo.gid && call.canal === cid && call.estado !== 'nenhuma') { recado('Você já está nesse canal.', ''); return; }
  const g = grupos.get(grupo.gid);
  const gid = grupo.gid;
  if (call.estado !== 'nenhuma') {
    // troca de call: a anterior fecha por dentro do app (motivo 'trocou'); os convites dela param
    const antigos = call.extras.slice();
    entrarEmEstado('nenhuma');
    antigos.forEach((r) => pararMeuConvite(r));
  }
  entrarEmEstado('conectando', '#' + c.nome, 'canal');
  call.link = c.link; call.grupo = gid; call.canal = cid; call.grupoNome = g ? g.nome : ''; call.canalNome = c.nome;
  $('conectando-txt').textContent = 'Entrando em 🔊 ' + c.nome + '…';
  pintarCall(); pintarGrupo();
  mandarRectDoPalco();
  const ok = await ponte.entrarComLink(c.link, eu.nick, '#' + c.nome);
  if (!ok) { if (call.estado !== 'nenhuma') entrarEmEstado('nenhuma'); recado('Não consegui entrar no canal.', 'mal'); return; }
  marcarCanalVoz(gid, cid);
}

/* =====================================================================
 * O PALCO: avisa o app onde a call se encaixa
 * =================================================================== */
function mandarRectDoPalco(){
  const r = $('palco').getBoundingClientRect();
  if (r.width > 0 && r.height > 0) ponte.palcoMudou({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(mandarRectDoPalco).observe($('palco'));
window.addEventListener('resize', mandarRectDoPalco);

/* =====================================================================
 * AJUSTES — tela cheia do app. A call (se houver) fica escondida enquanto
 * isto está aberto, mas continua rodando; volta ao fechar.
 * =================================================================== */
const QUALIDADES = [
  { id: 'auto',       titulo: 'Automático',     sub: 'Mede sua máquina e escolhe — com jogo aberto costuma cair pra 720p.' },
  { id: '1080-60-8',  titulo: '1080p · 60 fps', sub: 'Jogo rápido, monitor 1080p. ~8 Mbps. Recomendado.' },
  { id: '1080-30-5',  titulo: '1080p · 30 fps', sub: 'Nítido, gasta menos. ~5 Mbps.' },
  { id: '1440-60-14', titulo: '1440p · 60 fps', sub: 'Só com placa e internet fortes. ~14 Mbps.' },
  { id: '720-30-3',   titulo: '720p · 30 fps',  sub: 'Internet fraca. ~3 Mbps.' },
  { id: '480-120-5',  titulo: '480p · 120 fps', sub: 'Fluidez acima de tudo, imagem pequena.' },
];

const medidor = { stream: null, ctx: null, quadro: null };

function abrirAjustes(secao){
  $('tela-ajustes').classList.add('mostra');
  ponte.viewVisivel(false);
  irParaSecao(secao || 'conta');
  carregarConfig().then(() => { pintarAjustes(); listarDispositivos(); });
  lerJogosJanela();
  pintarBloqueados();
}
function fecharAjustes(){
  $('tela-ajustes').classList.remove('mostra');
  pararMedidor();
  ponte.viewVisivel(true);
}
function irParaSecao(nome){
  document.querySelectorAll('.aj-nav button[data-sec]').forEach((b) => b.classList.toggle('ativa', b.dataset.sec === nome));
  document.querySelectorAll('.aj-corpo section[data-sec]').forEach((sec) => sec.classList.toggle('mostra', sec.dataset.sec === nome));
  if (nome === 'voz') ligarMedidor(); else pararMedidor();
}
$('btn-ajustes').onclick = () => { if ($('tela-ajustes').classList.contains('mostra')) fecharAjustes(); else abrirAjustes(); };
$('btn-fechar-ajustes').onclick = fecharAjustes;
document.querySelectorAll('.aj-nav button[data-sec]').forEach((b) => { b.onclick = () => irParaSecao(b.dataset.sec); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && $('tela-ajustes').classList.contains('mostra') && !capturandoTecla) fecharAjustes(); });
$('btn-sair-conta-aj').onclick = () => { fecharAjustes(); $('btn-sair-conta').click(); };

async function carregarConfig(){
  try { config = await ponte.configLer(); } catch { config = {}; }
}
async function mudarConfig(mudancas){
  try { config = await ponte.configMudar(mudancas); } catch (e) { recado('Não consegui salvar o ajuste.', 'mal'); }
  pintarAjustes();
  // já numa call: vale agora, sem reiniciar nada
  if (call.estado !== 'nenhuma' && ['micRotulo', 'saidaRotulo', 'fala', 'teclaPtt', 'limpar', 'volume', 'qualidade', 'codec', 'prioridadeGpu', 'nitidezExtra', 'ruidoForte', 'portao', 'portaoCorta'].some((k) => k in mudancas)) ponte.reaplicar();
}

function bonitinho(combo){ return String(combo || '—').replace('Control', 'Ctrl').replace(/\+/g, ' + '); }

function pintarAjustes(){
  $('chave-bandeja').classList.toggle('on', !!config.bandeja);
  $('chave-iniciar').classList.toggle('on', !!config.iniciarComWindows);
  $('chave-limpar').classList.toggle('on', config.limpar !== false);
  $('chave-som-tela').classList.toggle('on', config.somDaTela !== false);
  $('chave-gpu').classList.toggle('on', config.prioridadeGpu !== false);
  $('chave-nitidez').classList.toggle('on', !!config.nitidezExtra);
  $('chave-ruido').classList.toggle('on', !!config.ruidoForte);
  const portao = Math.max(5, Math.min(50, Number(config.portao) || 12));
  $('portao-app').value = portao; $('portao-app-txt').textContent = String(portao); $('marca-portao').style.left = portao + '%';
  $('chave-portao').classList.toggle('on', config.portaoCorta !== false);
  $('chave-sobrepor').classList.toggle('on', config.sobrepor !== false);
  $('linha-canto').style.display = config.sobrepor !== false ? '' : 'none';
  $('sel-canto').value = config.cantoSobreposicao || 'esq-cima';
  $('chave-jogo').classList.toggle('on', config.mostrarJogo !== false);
  $('tecla-mic').textContent = bonitinho(config.atalhoMic);
  $('tecla-surdo').textContent = bonitinho(config.atalhoSurdo);
  $('tecla-ptt').textContent = config.nomeTeclaPtt || 'V';
  document.querySelectorAll('.cartao[data-fala]').forEach((c) => c.classList.toggle('escolhido', (config.fala || 'voz') === c.dataset.fala));
  $('linha-ptt').style.display = config.fala === 'ptt' ? '' : 'none';
  const vol = Number.isFinite(Number(config.volume)) ? Number(config.volume) : 100;
  $('vol-app').value = vol; $('vol-app-txt').textContent = vol + '%';
  $('sel-codec-app').value = config.codec || 'auto';
  document.querySelectorAll('.cartao[data-captura]').forEach((c) => c.classList.toggle('escolhido', (config.captura || 'dxgi') === c.dataset.captura));
  const cx = $('cartoes-qualidade');
  if (!cx.children.length) QUALIDADES.forEach((q) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'cartao'; b.dataset.q = q.id;
    const t = document.createElement('b'); t.textContent = q.titulo; const sm = document.createElement('small'); sm.textContent = q.sub;
    b.append(t, sm); b.onclick = () => mudarConfig({ qualidade: q.id }); cx.appendChild(b);
  });
  cx.querySelectorAll('.cartao').forEach((c) => c.classList.toggle('escolhido', (config.qualidade || 'auto') === c.dataset.q));
  if ($('sel-mic-app').options.length > 1) $('sel-mic-app').value = config.micRotulo || '';
  if ($('sel-saida-app').options.length > 1) $('sel-saida-app').value = config.saidaRotulo || '';
}

/* ---- dispositivos (por NOME: o id muda de site pra site) ---- */
async function listarDispositivos(){
  let ds = [];
  try { ds = await navigator.mediaDevices.enumerateDevices(); } catch { ds = []; }
  const semNome = ds.some((d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && !d.label);
  if (semNome && !medidor.stream) {
    // os nomes só aparecem depois que o app usou o microfone uma vez
    try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); ds = await navigator.mediaDevices.enumerateDevices(); }
    catch (e) { $('aviso-mic').hidden = false; $('aviso-mic').textContent = 'Não consegui acessar o microfone (' + (e && e.name || 'erro') + '). Confere em Windows › Privacidade › Microfone.'; }
  }
  const encher = (sel, tipo, atual) => {
    const vistos = new Set();
    sel.innerHTML = '<option value="">Padrão do Windows</option>';
    ds.filter((d) => d.kind === tipo && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications').forEach((d) => {
      if (vistos.has(d.label)) return; vistos.add(d.label);
      const o = document.createElement('option'); o.value = d.label; o.textContent = d.label; sel.appendChild(o);
    });
    sel.value = vistos.has(atual) ? atual : '';
  };
  encher($('sel-mic-app'), 'audioinput', config.micRotulo || '');
  encher($('sel-saida-app'), 'audiooutput', config.saidaRotulo || '');
}
navigator.mediaDevices.addEventListener('devicechange', () => { if ($('tela-ajustes').classList.contains('mostra')) listarDispositivos(); });

$('sel-mic-app').onchange = async () => { await mudarConfig({ micRotulo: $('sel-mic-app').value }); ligarMedidor(true); };
$('sel-saida-app').onchange = () => mudarConfig({ saidaRotulo: $('sel-saida-app').value });

/* medidor de nível do microfone (só enquanto a aba Voz está aberta) */
async function ligarMedidor(reiniciar){
  if (medidor.stream && !reiniciar) return;
  pararMedidor();
  try{
    const ds = await navigator.mediaDevices.enumerateDevices();
    const mic = ds.find((d) => d.kind === 'audioinput' && d.label === (config.micRotulo || '—'));
    const audioC = mic ? { deviceId: { exact: mic.deviceId } } : true;
    medidor.stream = await navigator.mediaDevices.getUserMedia({ audio: audioC });
    medidor.ctx = new AudioContext();
    const src = medidor.ctx.createMediaStreamSource(medidor.stream);
    const an = medidor.ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const passo = () => {
      if (!medidor.ctx) return;
      an.getFloatTimeDomainData(buf);
      let soma = 0; for (let i = 0; i < buf.length; i++) soma += buf[i] * buf[i];
      const rms = Math.sqrt(soma / buf.length);
      // a MESMA régua do site (nivel()): assim o ponto de corte daqui vale igual lá dentro
      const pct = Math.min(100, Math.round(Math.sqrt(rms) * 145));
      $('nivel-mic').style.width = pct + '%';
      $('nivel-mic').classList.toggle('passa', pct > (Number(config.portao) || 12));
      medidor.quadro = requestAnimationFrame(passo);
    };
    passo();
    $('aviso-mic').hidden = true;
  }catch(e){
    $('aviso-mic').hidden = false;
    $('aviso-mic').textContent = 'Não consegui abrir esse microfone (' + (e && e.name || 'erro') + ').';
  }
}
function pararMedidor(){
  if (medidor.quadro) cancelAnimationFrame(medidor.quadro); medidor.quadro = null;
  if (medidor.stream) { medidor.stream.getTracks().forEach((t) => t.stop()); medidor.stream = null; }
  if (medidor.ctx) { medidor.ctx.close().catch(() => {}); medidor.ctx = null; }
  $('nivel-mic').style.width = '0';
}

/* testar a saída: duas notas pelo aparelho escolhido */
$('btn-testar-saida').onclick = async () => {
  const b = $('btn-testar-saida'); b.disabled = true;
  try{
    const ctx = new AudioContext();
    const rotulo = $('sel-saida-app').value;
    if (rotulo && typeof ctx.setSinkId === 'function') {
      const ds = await navigator.mediaDevices.enumerateDevices();
      const d = ds.find((x) => x.kind === 'audiooutput' && x.label === rotulo);
      if (d) await ctx.setSinkId(d.deviceId).catch(() => {});
    }
    const t = ctx.currentTime;
    [[523, 0], [659, 0.18], [784, 0.36]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + dt); g.gain.linearRampToValueAtTime(0.25, t + dt + 0.02); g.gain.linearRampToValueAtTime(0, t + dt + 0.3);
      o.connect(g).connect(ctx.destination); o.start(t + dt); o.stop(t + dt + 0.32);
    });
    setTimeout(() => { ctx.close().catch(() => {}); b.disabled = false; }, 900);
  }catch(e){ recado('Não consegui tocar nesse aparelho.', 'mal'); b.disabled = false; }
};

/* voz: modo, tecla de falar, limpeza, volume, compressão, som da tela, janela */
document.querySelectorAll('.cartao[data-fala]').forEach((c) => { c.onclick = () => mudarConfig({ fala: c.dataset.fala }); });
document.querySelectorAll('.cartao[data-captura]').forEach((c) => { c.onclick = async () => { await mudarConfig({ captura: c.dataset.captura }); recado('Método de captura salvo. Vale na próxima vez que abrir o Bigas Voice.', 'bem'); }; });
$('chave-limpar').onclick = () => mudarConfig({ limpar: config.limpar === false });
$('chave-som-tela').onclick = () => mudarConfig({ somDaTela: config.somDaTela === false });
$('chave-gpu').onclick = () => mudarConfig({ prioridadeGpu: config.prioridadeGpu === false });
$('chave-nitidez').onclick = () => mudarConfig({ nitidezExtra: !config.nitidezExtra });
$('chave-ruido').onclick = () => mudarConfig({ ruidoForte: !config.ruidoForte });
$('chave-portao').onclick = () => mudarConfig({ portaoCorta: config.portaoCorta === false });
$('portao-app').oninput = () => { const v = Number($('portao-app').value); $('portao-app-txt').textContent = String(v); $('marca-portao').style.left = v + '%'; config.portao = v; };
$('portao-app').onchange = () => mudarConfig({ portao: Number($('portao-app').value) });
$('chave-sobrepor').onclick = () => mudarConfig({ sobrepor: config.sobrepor === false });
$('sel-canto').onchange = () => mudarConfig({ cantoSobreposicao: $('sel-canto').value });
$('chave-jogo').onclick = () => mudarConfig({ mostrarJogo: config.mostrarJogo === false });
$('btn-diagnostico').onclick = async () => {
  const b = $('btn-diagnostico'); b.disabled = true; b.textContent = 'Gerando…';
  try{
    let ds = [];
    try { ds = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind !== 'videoinput').map((d) => d.kind + ': ' + (d.label || '(sem nome)')); } catch {}
    const r = await ponte.diagnostico({ nick: eu.nick, call: { estado: call.estado, com: call.com, papel: call.papel, ping: call.ping, gpu: call.gpu, religando: call.religando, mudo: call.mudo, surdo: call.surdo }, amigos: amigos.size, jogo: jogoAgora, online: navigator.onLine, aparelhos: ds });
    if (r && r.caminho) recado('Diagnóstico salvo na Área de Trabalho e copiado. É só colar pra quem cuida do app.', 'bem');
    else if (r && r.texto) recado('Diagnóstico copiado (não consegui salvar o arquivo).', 'bem');
    else recado('Não consegui gerar o diagnóstico.', 'mal');
  }catch(e){ recado('Não consegui gerar o diagnóstico.', 'mal'); }
  finally{ b.disabled = false; b.textContent = '📋 Gerar'; }
};
$('chave-bandeja').onclick = () => mudarConfig({ bandeja: !config.bandeja });
$('chave-iniciar').onclick = () => mudarConfig({ iniciarComWindows: !config.iniciarComWindows });
$('sel-codec-app').onchange = () => mudarConfig({ codec: $('sel-codec-app').value });
$('vol-app').oninput = () => { $('vol-app-txt').textContent = $('vol-app').value + '%'; };
$('vol-app').onchange = () => mudarConfig({ volume: Number($('vol-app').value) });

let jogosJanela = null;
async function lerJogosJanela(){
  try { jogosJanela = await ponte.jogosJanela(); } catch { jogosJanela = null; }
  $('chave-jogos').classList.toggle('on', jogosJanela === true);
  $('chave-jogos').disabled = jogosJanela === null;
}
$('chave-jogos').onclick = async () => {
  try { jogosJanela = await ponte.jogosJanela(!jogosJanela); } catch { recado('Não consegui mudar essa configuração do Windows.', 'mal'); }
  $('chave-jogos').classList.toggle('on', jogosJanela === true);
  recado(jogosJanela ? 'Ligada. Reabre o jogo pra valer.' : 'Desligada. Reabre o jogo pra valer.', jogosJanela ? 'bem' : '');
};

/* captura de tecla: atalhos globais (acelerador do Electron) e tecla de falar (código do teclado) */
let capturandoTecla = false;
function ligarCapturaDeTecla(botao, aoTerminar, aceitaMouse){
  botao.onclick = () => {
    if (capturandoTecla) return;
    capturandoTecla = true;
    botao.classList.add('gravando'); botao.textContent = aceitaMouse ? 'aperta a tecla ou botão…' : 'aperta a tecla…';
    const terminar = () => { window.removeEventListener('keydown', ouvir, true); window.removeEventListener('mousedown', ouvirMouse, true); botao.classList.remove('gravando'); capturandoTecla = false; };
    const ouvir = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key)) return; // só modificador: espera a tecla
      terminar();
      if (ev.key === 'Escape') { pintarAjustes(); return; }
      aoTerminar(ev);
    };
    // botões laterais e do meio do mouse (o esquerdo e o direito não: iam travar tudo)
    const ouvirMouse = (ev) => {
      if (![1, 3, 4].includes(ev.button)) return;
      ev.preventDefault(); ev.stopPropagation();
      terminar();
      aoTerminar({ code: 'Mouse' + ev.button, key: ev.button === 1 ? 'Botão do meio' : ev.button === 3 ? 'Botão lateral 1' : 'Botão lateral 2', mouse: true });
    };
    window.addEventListener('keydown', ouvir, true);
    // o clique que abriu a captura já passou; só a partir do próximo
    if (aceitaMouse) setTimeout(() => { if (capturandoTecla) window.addEventListener('mousedown', ouvirMouse, true); }, 50);
  };
}
function aceleradorDe(ev){
  const partes = [];
  if (ev.ctrlKey) partes.push('Control');
  if (ev.altKey) partes.push('Alt');
  if (ev.shiftKey) partes.push('Shift');
  let k = ev.key;
  if (k === ' ') k = 'Space';
  else if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
  else if (/^F\d{1,2}$/.test(k) || /^\d$/.test(k)) { /* serve como está */ }
  else if (ev.code.startsWith('Numpad')) k = 'num' + ev.code.slice(6).toLowerCase();
  else return null;
  partes.push(k);
  return partes;
}
ligarCapturaDeTecla($('tecla-mic'), (ev) => {
  const p = aceleradorDe(ev);
  if (!p) { recado('Essa tecla não dá pra usar como atalho. Tenta letra, número ou F1–F12.', 'mal'); pintarAjustes(); return; }
  if (p.length === 1) { recado('Usa junto com Ctrl, Alt ou Shift — senão a tecla some do jogo.', 'mal'); pintarAjustes(); return; }
  mudarConfig({ atalhoMic: p.join('+') });
});
ligarCapturaDeTecla($('tecla-surdo'), (ev) => {
  const p = aceleradorDe(ev);
  if (!p) { recado('Essa tecla não dá pra usar como atalho. Tenta letra, número ou F1–F12.', 'mal'); pintarAjustes(); return; }
  if (p.length === 1) { recado('Usa junto com Ctrl, Alt ou Shift — senão a tecla some do jogo.', 'mal'); pintarAjustes(); return; }
  mudarConfig({ atalhoSurdo: p.join('+') });
});
ligarCapturaDeTecla($('tecla-ptt'), (ev) => {
  // a tecla de falar vale no site (janela em foco) E no ajudante nativo (jogo na frente)
  const nome = ev.mouse ? ev.key : ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
  mudarConfig({ teclaPtt: ev.code, nomeTeclaPtt: nome });
}, true);

carregarConfig().then(pintarAjustes);

/* =====================================================================
 * VERSÃO E ATUALIZAÇÃO (o botão faz o processo inteiro)
 * =================================================================== */
ponte.versao().then((v) => {
  document.querySelectorAll('.versao').forEach((el) => { el.textContent = 'v' + v; });
}).catch(() => {});

/* Dois botões (um na tela de login, um no rodapé da casa), UM estado:
   o que o processo principal conta vale pros dois ao mesmo tempo. */
(function botoesAtualizar(){
  const botoes = [...document.querySelectorAll('.btn-atualizar')];
  let atual = 'ocioso';
  let voltar = null;

  function pintar(b, nome, extra){
    const barra = b.querySelector('.barra');
    const rotulo = b.querySelector('span:last-child');
    b.className = 'btn-atualizar'; b.disabled = false;
    barra.style.transform = 'scaleX(0)';
    const g = b.querySelector('.girando'); if (g) g.remove();
    if (nome === 'ocioso') rotulo.textContent = '🔄 Verificar atualização';
    else if (nome === 'verificando') {
      b.disabled = true;
      const s = document.createElement('span'); s.className = 'girando'; b.insertBefore(s, rotulo);
      rotulo.textContent = 'Procurando atualização…';
    } else if (nome === 'baixando') {
      b.className = 'btn-atualizar achou'; b.disabled = true;
      const pc = (extra && extra.percentual) || 0;
      barra.style.transform = 'scaleX(' + (pc / 100) + ')';
      rotulo.textContent = 'Baixando… ' + Math.round(pc) + '%';
    } else if (nome === 'pronto') {
      b.className = 'btn-atualizar pronto';
      rotulo.textContent = '🔁 Reiniciar e atualizar agora';
    } else if (nome === 'atualizado') {
      rotulo.textContent = '✅ Já está na versão mais nova';
    } else if (nome === 'erro') {
      rotulo.textContent = '⚠️ Não consegui checar agora';
    }
  }

  function estado(nome, extra){
    clearTimeout(voltar);
    atual = nome;
    botoes.forEach((b) => pintar(b, nome, extra));
    if (nome === 'atualizado') voltar = setTimeout(() => estado('ocioso'), 3500);
    if (nome === 'erro') voltar = setTimeout(() => estado('ocioso'), 4000);
  }

  estado('ocioso');
  botoes.forEach((b) => {
    b.onclick = () => {
      if (atual === 'pronto') {
        if (call.estado !== 'nenhuma' && !confirm('Atualizar agora encerra a chamada. Continuar?')) return;
        ponte.instalarAtualizacao(); return;
      }
      ponte.verificarAtualizacao();
    };
  });
  ponte.aoMudarEstadoAtualizacao((d) => estado(d.estado, d));
})();

// pro teste mecânico (npm test) enxergar o estado da casa; nada de fora usa isto
window.__bigasEstado = { call, amigos, eu, chat, bloqueados, historicoLer, tirarAmigo, bloquear, desbloquear, chamarParaCall, entrarEmEstado, pintarCall, grupos, grupo, criarGrupo, entrarPorCodigo, abrirGrupo, fecharGrupo, convidarParaGrupo, entrarNoCanalDeVoz, apagarGrupo, sairDoGrupo, pintarGrupo, pintarTrilho, lerEstrutura,
  expulsar: (gid, uid) => deleteDoc(doc(db, 'grupos', gid, 'membros', uid)) };

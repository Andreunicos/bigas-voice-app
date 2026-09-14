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
  pararConvite: null,
  pararAceito: null,           // (quem atendeu) ouve se quem chamou desligou antes de conectar
  relogio: null,
  mudo: false, surdo: false,
};

const chat = { com: null, nick: '', parar: null };
let config = {};

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
});

function desligarTudo(){
  paradores.forEach((p) => { try { p(); } catch {} });
  paradores = [];
  amigos.forEach((a) => { if (a.parar) a.parar(); if (a.pararUltima) a.pararUltima(); });
  amigos.clear();
  bloqueados.clear();
  clearInterval(batida); batida = null;
  pedidosChegando = []; convitesChegando = []; perdidas = [];
  fecharChat(); fecharLateral();
  pararSom();
  pintarConvite(); pintarPedidos(); pintarPerdidas(); pintarAmigos();
}

/* =====================================================================
 * PRESENÇA (online / em chamada) — uma batida de tempos em tempos
 * =================================================================== */
function bater(){
  if (!eu.uid) return;
  setDoc(doc(db, 'usuarios', eu.uid), {
    ultimoVisto: serverTimestamp(), emChamada: call.estado !== 'nenhuma',
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
  $('bloco-pedidos').hidden = !vivos.length;
  $('bolinha-pedidos').hidden = !vivos.length;
  $('bolinha-pedidos').textContent = String(vivos.length);
  const caixa = $('pedidos'); caixa.innerHTML = '';
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
    estado.textContent = a.ultima && a.naoLidas ? String(a.ultima.texto || '').slice(0, 40)
      : p === 'emcall' ? 'em chamada' : p === 'online' ? 'online' : 'offline';
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
  m.style.left = Math.max(6, Math.min(innerWidth - m.offsetWidth - 6, x)) + 'px';
  m.style.top = Math.max(6, Math.min(innerHeight - m.offsetHeight - 6, y)) + 'px';
  setTimeout(() => document.addEventListener('click', fecharMenuAmigo, { once: true }), 0);
}
function fecharMenuAmigo(){ $('menu-amigo').classList.remove('mostra'); }
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
  chat.com = uid; chat.nick = nick;
  $('chat-nick').textContent = nick;
  $('chat-av').textContent = iniciais(nick);
  $('mensagens').innerHTML = '<p class="vazio">Carregando…</p>';
  mostrarLateral('sec-chat');
  marcarLido(uid, Date.now());
  pintarAmigos();
  const ref = query(collection(db, 'conversas', idConversa(uid), 'mensagens'), orderBy('quando', 'desc'), limit(200));
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
      const t = document.createElement('div'); t.className = 'texto'; t.textContent = m.texto || '';
      const h = document.createElement('div'); h.className = 'hora'; h.textContent = hora(m.quando);
      el.append(t, h); caixa.appendChild(el);
    });
    if (estavaEmbaixo || snap.docChanges().some((c) => c.type === 'added')) caixa.scrollTop = caixa.scrollHeight;
    marcarLido(uid, Date.now());
  }, (e) => { console.error(e); $('mensagens').innerHTML = '<p class="vazio">Não consegui abrir a conversa (' + (e.code || 'erro') + ').</p>'; });
  setTimeout(() => $('chat-texto').focus(), 50);
}
function fecharChat(){
  if (chat.parar) { chat.parar(); chat.parar = null; }
  chat.com = null; chat.nick = '';
  if ($('sec-chat').classList.contains('mostra')) fecharLateral();
  pintarAmigos();
}
$('btn-fechar-chat').onclick = fecharChat;

async function enviarMensagem(){
  const texto = $('chat-texto').value.trim();
  if (!texto || !chat.com) return;
  $('chat-texto').value = ''; ajustarAltura();
  try{
    await addDoc(collection(db, 'conversas', idConversa(chat.com), 'mensagens'), { de: eu.uid, texto, quando: serverTimestamp() });
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
  ['sec-chat'].forEach((id) => $(id).classList.toggle('mostra', id === qual));
  mandarRectDoPalco();
}
function fecharLateral(){
  $('lateral').classList.remove('mostra');
  mandarRectDoPalco();
}

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
    // convidado extra: se ninguém atender, o convite só para de tocar
    setTimeout(async () => {
      try{ const d = await getDoc(ref); if (d.exists() && d.data().estado === 'chamando') await updateDoc(ref, { estado: 'semResposta' }); }catch{}
    }, ESPERA_ATENDER_MS);
  }
}

function entrarEmEstado(estado, com, papel){
  call.estado = estado;
  if (estado === 'nenhuma') {
    call.com = ''; call.papel = ''; call.link = '';
    call.mudo = false; call.surdo = false;
    call.extras = [];
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
    $('call-sub').textContent = call.com;
  } else if (call.estado === 'conectada') {
    $('call-titulo').textContent = '🔊 Em chamada';
    $('call-sub').textContent = 'com ' + call.com;
  }
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

// o processo principal conta o que aconteceu com a call de verdade
ponte.aoMudarCall(async (d) => {
  if (d.estado === 'conectando') {
    if (call.estado === 'nenhuma') entrarEmEstado('conectando');
  } else if (d.estado === 'conectada') {
    if (call.estado !== 'nenhuma') entrarEmEstado('conectada');
    pararSom();
    bater();
  } else if (d.estado === 'encerrada') {
    const refs = call.extras.slice();
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
  { id: 'auto',       titulo: 'Automático',     sub: 'Mede sua máquina e escolhe. Recomendado.' },
  { id: '1080-60-8',  titulo: '1080p · 60 fps', sub: 'Jogo rápido, monitor 1080p. ~8 Mbps.' },
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
  if (call.estado !== 'nenhuma' && ['micRotulo', 'saidaRotulo', 'fala', 'teclaPtt', 'limpar', 'volume', 'qualidade', 'codec'].some((k) => k in mudancas)) ponte.reaplicar();
}

function bonitinho(combo){ return String(combo || '—').replace('Control', 'Ctrl').replace(/\+/g, ' + '); }

function pintarAjustes(){
  $('chave-bandeja').classList.toggle('on', !!config.bandeja);
  $('chave-iniciar').classList.toggle('on', !!config.iniciarComWindows);
  $('chave-limpar').classList.toggle('on', config.limpar !== false);
  $('chave-som-tela').classList.toggle('on', config.somDaTela !== false);
  $('tecla-mic').textContent = bonitinho(config.atalhoMic);
  $('tecla-surdo').textContent = bonitinho(config.atalhoSurdo);
  $('tecla-ptt').textContent = config.nomeTeclaPtt || 'V';
  document.querySelectorAll('.cartao[data-fala]').forEach((c) => c.classList.toggle('escolhido', (config.fala || 'voz') === c.dataset.fala));
  $('linha-ptt').style.display = config.fala === 'ptt' ? '' : 'none';
  const vol = Number.isFinite(Number(config.volume)) ? Number(config.volume) : 100;
  $('vol-app').value = vol; $('vol-app-txt').textContent = vol + '%';
  $('sel-codec-app').value = config.codec || 'auto';
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
      const pct = Math.min(100, Math.round(Math.sqrt(rms) * 140));
      $('nivel-mic').style.width = pct + '%';
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
$('chave-limpar').onclick = () => mudarConfig({ limpar: config.limpar === false });
$('chave-som-tela').onclick = () => mudarConfig({ somDaTela: config.somDaTela === false });
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
function ligarCapturaDeTecla(botao, aoTerminar, precisaModificador){
  botao.onclick = () => {
    if (capturandoTecla) return;
    capturandoTecla = true;
    botao.classList.add('gravando'); botao.textContent = 'aperta a tecla…';
    const ouvir = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key)) return; // só modificador: espera a tecla
      window.removeEventListener('keydown', ouvir, true);
      botao.classList.remove('gravando'); capturandoTecla = false;
      if (ev.key === 'Escape') { pintarAjustes(); return; }
      aoTerminar(ev);
    };
    window.addEventListener('keydown', ouvir, true);
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
  // a tecla de falar é do SITE (dentro da call): guarda o código e o nome, como ele faz
  const nome = ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
  mudarConfig({ teclaPtt: ev.code, nomeTeclaPtt: nome });
});

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

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where,
  getDocs, onSnapshot, addDoc, serverTimestamp, limit,
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

const $ = (id) => document.getElementById(id);
const ponte = window.bigasHome;

// quanto tempo um "está te chamando" vale, e quanto tempo o chamador espera
const CONVITE_VALE_MS = 60 * 1000;
const ESPERA_ATENDER_MS = 45 * 1000;
// presença: batida a cada 40 s; sem batida por 100 s = offline
const BATIDA_MS = 40 * 1000;
const OFFLINE_APOS_MS = 100 * 1000;

function nickParaEmail(nick){
  return nick.trim().toLowerCase().replace(/[^a-z0-9_]/g, '') + '@bigasvoice.app';
}
function iniciais(nome){ return (nome || '?').slice(0, 2).toUpperCase(); }

/* =====================================================================
 * ESTADO
 * =================================================================== */
const eu = { uid: null, nick: '' };
const amigos = new Map();      // uid -> { nick, presenca, parar }
let pararAmigos = null;
let pararConvites = null;
let batida = null;
let convitesChegando = [];     // docs de convite ainda tocando pra mim

const call = {
  estado: 'nenhuma',           // nenhuma | conectando | conectada
  com: '',                     // nick de quem está do outro lado
  papel: '',                   // chamando | atendendo
  conviteRef: null,            // meu convite (quando fui eu que chamei)
  pararConvite: null,
  relogio: null,
};

/* =====================================================================
 * RECADOS
 * =================================================================== */
let relogioRecado = null;
function recado(texto, tom){
  const r = $('recado');
  r.textContent = texto;
  r.className = 'recado mostra' + (tom ? ' ' + tom : '');
  clearTimeout(relogioRecado);
  relogioRecado = setTimeout(() => { r.className = 'recado'; }, 3800);
}

/* =====================================================================
 * LOGIN / CONTA
 * =================================================================== */
function travarLogin(travado){
  $('btn-entrar').disabled = travado;
  $('btn-criar').disabled = travado;
}

$('btn-criar').onclick = async () => {
  const nick = $('nick').value.trim();
  const senha = $('senha').value;
  $('erro-login').textContent = '';
  if (nick.length < 2) { $('erro-login').textContent = 'O nick precisa de pelo menos 2 letras.'; return; }
  if (!/^[A-Za-z0-9_]+$/.test(nick)) { $('erro-login').textContent = 'Nick só com letras, números e _ (sem espaço).'; return; }
  if (senha.length < 6) { $('erro-login').textContent = 'A senha precisa de pelo menos 6 caracteres.'; return; }
  travarLogin(true);
  try{
    // nick já existe? (a conta é por e-mail sintético, mas o nick tem que ser único)
    const q = query(collection(db, 'usuarios'), where('nickBusca', '==', nick.toLowerCase()), limit(1));
    if (!(await getDocs(q)).empty) { $('erro-login').textContent = 'Esse nick já tem dono. Escolhe outro.'; return; }
    const cred = await createUserWithEmailAndPassword(auth, nickParaEmail(nick), senha);
    await setDoc(doc(db, 'usuarios', cred.user.uid), {
      nick, nickBusca: nick.toLowerCase(), criadoEm: serverTimestamp(),
      ultimoVisto: serverTimestamp(), emChamada: false,
    });
  }catch(e){ $('erro-login').textContent = traduzirErro(e); }
  finally{ travarLogin(false); }
};

$('btn-entrar').onclick = async () => {
  const nick = $('nick').value.trim();
  const senha = $('senha').value;
  $('erro-login').textContent = '';
  if (!nick || !senha) { $('erro-login').textContent = 'Preenche o nick e a senha.'; return; }
  travarLogin(true);
  try{ await signInWithEmailAndPassword(auth, nickParaEmail(nick), senha); }
  catch(e){ $('erro-login').textContent = traduzirErro(e); }
  finally{ travarLogin(false); }
};
$('senha').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('btn-entrar').click(); });
$('nick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('senha').focus(); });

$('btn-sair-conta').onclick = async () => {
  if (call.estado !== 'nenhuma') { recado('Sai da chamada antes de sair da conta.', 'mal'); return; }
  try{ await updateDoc(doc(db, 'usuarios', eu.uid), { ultimoVisto: null, emChamada: false }); }catch{}
  signOut(auth);
};

function traduzirErro(e){
  const c = (e && e.code) || '';
  if (c.includes('email-already-in-use')) return 'Esse nick já tem conta. Tenta "Entrar" em vez de criar.';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found'))
    return 'Nick ou senha errados.';
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
    eu.uid = null; eu.nick = '';
    $('tela-login').style.display = 'flex';
    $('tela-casa').style.display = 'none';
    $('senha').value = '';
    return;
  }

  eu.uid = usuario.uid;
  const meuDoc = await getDoc(doc(db, 'usuarios', usuario.uid));
  eu.nick = meuDoc.exists() ? meuDoc.data().nick : 'Sem nome';
  $('meu-nick').textContent = eu.nick;
  $('meu-av').textContent = iniciais(eu.nick);

  $('tela-login').style.display = 'none';
  $('tela-casa').style.display = 'flex';
  mandarRectDoPainel();

  ligarPresenca();
  ouvirAmigos();
  ouvirConvites();
});

function desligarTudo(){
  if (pararConvites) { pararConvites(); pararConvites = null; }
  if (pararAmigos) { pararAmigos(); pararAmigos = null; }
  amigos.forEach((a) => { if (a.parar) a.parar(); });
  amigos.clear();
  clearInterval(batida); batida = null;
  convitesChegando = [];
  pintarConvite();
  pintarAmigos();
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
  if (!p || !p.ultimoVisto || typeof p.ultimoVisto.toMillis !== 'function') return 'offline';
  if (Date.now() - p.ultimoVisto.toMillis() > OFFLINE_APOS_MS) return 'offline';
  return p.emChamada ? 'emcall' : 'online';
}

/* =====================================================================
 * AMIGOS
 * =================================================================== */
$('btn-add').onclick = adicionarAmigo;
$('add-nick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') adicionarAmigo(); });

async function adicionarAmigo(){
  const nickBuscado = $('add-nick').value.trim();
  $('erro-add').textContent = '';
  if (!nickBuscado) return;
  $('btn-add').disabled = true;
  try{
    const q = query(collection(db, 'usuarios'), where('nickBusca', '==', nickBuscado.toLowerCase()), limit(1));
    const achou = await getDocs(q);
    if (achou.empty) { $('erro-add').textContent = 'Não achei ninguém com esse nick.'; return; }
    const amigoDoc = achou.docs[0];
    if (amigoDoc.id === eu.uid) { $('erro-add').textContent = 'Esse nick é o seu.'; return; }
    if (amigos.has(amigoDoc.id)) { $('erro-add').textContent = amigoDoc.data().nick + ' já está na sua lista.'; return; }
    await setDoc(doc(db, 'usuarios', eu.uid, 'amigos', amigoDoc.id), {
      nick: amigoDoc.data().nick, desde: serverTimestamp(),
    });
    $('add-nick').value = '';
    recado(amigoDoc.data().nick + ' entrou na sua lista.', 'bem');
  }catch(e){
    console.error(e);
    $('erro-add').textContent = traduzirErro(e);
  }finally{ $('btn-add').disabled = false; }
}

async function tirarAmigo(uid, nick){
  if (!confirm('Tirar ' + nick + ' da sua lista?')) return;
  try{ await deleteDoc(doc(db, 'usuarios', eu.uid, 'amigos', uid)); }
  catch(e){ recado('Não consegui tirar agora.', 'mal'); }
}

function ouvirAmigos(){
  const ref = collection(db, 'usuarios', eu.uid, 'amigos');
  pararAmigos = onSnapshot(ref, (snap) => {
    const vivos = new Set();
    snap.forEach((d) => {
      vivos.add(d.id);
      let a = amigos.get(d.id);
      if (!a) {
        a = { nick: d.data().nick, presenca: null, parar: null };
        // cada amigo tem o próprio "olho": online / em chamada, ao vivo
        a.parar = onSnapshot(doc(db, 'usuarios', d.id), (u) => {
          a.presenca = u.exists() ? u.data() : null;
          if (u.exists() && u.data().nick) a.nick = u.data().nick;
          pintarAmigos();
        }, () => {});
        amigos.set(d.id, a);
      } else {
        a.nick = d.data().nick || a.nick;
      }
    });
    amigos.forEach((a, id) => { if (!vivos.has(id)) { if (a.parar) a.parar(); amigos.delete(id); } });
    pintarAmigos();
  }, (e) => { console.error(e); recado('Não consegui carregar seus amigos.', 'mal'); });
}

function pintarAmigos(){
  const lista = $('lista-amigos');
  if (!lista) return;
  $('titulo-lista').textContent = amigos.size ? 'Amigos — ' + amigos.size : 'Amigos';
  if (!amigos.size) {
    lista.innerHTML = '<p class="vazio">Ninguém na lista ainda.<br>Adiciona um amigo pelo nick aí em cima — ele precisa ter conta no Bigas Voice.</p>';
    return;
  }
  const ordem = { emcall: 0, online: 0, offline: 1 };
  const entradas = [...amigos.entries()]
    .map(([id, a]) => ({ id, a, p: presencaDe(a) }))
    .sort((x, y) => (ordem[x.p] - ordem[y.p]) || x.a.nick.localeCompare(y.a.nick));

  lista.innerHTML = '';
  for (const { id, a, p } of entradas) {
    const linha = document.createElement('div');
    linha.className = 'amigo ' + p;

    const av = document.createElement('div'); av.className = 'avatar';
    av.textContent = iniciais(a.nick);
    const luz = document.createElement('span'); luz.className = 'luz'; av.appendChild(luz);

    const txt = document.createElement('div'); txt.className = 'txt';
    const nome = document.createElement('div'); nome.className = 'nome'; nome.textContent = a.nick;
    const estado = document.createElement('div'); estado.className = 'estado';
    estado.textContent = p === 'emcall' ? 'em chamada' : p === 'online' ? 'online' : 'offline';
    txt.append(nome, estado);

    const acoes = document.createElement('div'); acoes.className = 'acoes';
    const chamar = document.createElement('button');
    chamar.type = 'button'; chamar.className = 'chamar'; chamar.textContent = '📞';
    chamar.title = 'Chamar ' + a.nick;
    if (call.estado !== 'nenhuma') { chamar.disabled = true; chamar.title = 'Você já está numa chamada'; }
    chamar.onclick = () => chamarAmigo(id, a.nick);
    const tirar = document.createElement('button');
    tirar.type = 'button'; tirar.className = 'tirar'; tirar.textContent = '×';
    tirar.title = 'Tirar da lista';
    tirar.onclick = () => tirarAmigo(id, a.nick);
    acoes.append(chamar, tirar);

    linha.append(av, txt, acoes);
    lista.appendChild(linha);
  }
}

/* =====================================================================
 * CHAMAR — a call abre AQUI no painel; o link fica só no convite
 * =================================================================== */
async function chamarAmigo(amigoUid, amigoNick){
  if (call.estado !== 'nenhuma') { recado('Você já está numa chamada.', 'mal'); return; }
  entrarEmEstado('conectando', amigoNick, 'chamando');
  $('conectando-txt').textContent = 'Chamando ' + amigoNick + '…';
  try{
    const link = await ponte.iniciarCall(eu.nick, amigoNick);
    if (!link) {
      // o motivo (sem internet, sem sinal…) chega logo em seguida por
      // call:estado 'encerrada', com o recado certo — aqui só desfaz
      if (call.estado !== 'nenhuma') entrarEmEstado('nenhuma');
      return;
    }
    if (call.estado === 'nenhuma') return; // desistiu no meio
    const ref = await addDoc(collection(db, 'convites'), {
      de: eu.uid, deNick: eu.nick, para: amigoUid, paraNick: amigoNick,
      link, estado: 'chamando', quando: serverTimestamp(),
    });
    call.conviteRef = ref;
    bater();

    // ouve a resposta dele: atendeu / recusou
    call.pararConvite = onSnapshot(ref, (d) => {
      if (!d.exists() || call.conviteRef !== ref) return;
      const c = d.data();
      if (c.estado === 'aceita') {
        clearTimeout(call.relogio); call.relogio = null;
        $('call-sub').textContent = amigoNick + ' atendeu — conectando…';
      } else if (c.estado === 'recusada') {
        recado(amigoNick + ' recusou a chamada.', 'mal');
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
  }catch(e){
    console.error(e);
    recado('Deu erro ao chamar: ' + traduzirErro(e), 'mal');
    sairDaCall();
  }
}

function entrarEmEstado(estado, com, papel){
  call.estado = estado;
  if (estado === 'nenhuma') {
    call.com = ''; call.papel = '';
    clearTimeout(call.relogio); call.relogio = null;
    if (call.pararConvite) { call.pararConvite(); call.pararConvite = null; }
    call.conviteRef = null;
  } else {
    if (com !== undefined) call.com = com;
    if (papel !== undefined) call.papel = papel;
  }
  pintarCall();
  pintarAmigos();
}

function pintarCall(){
  const p = $('painel-call');
  const painel = $('painel');
  p.className = 'painel-call' + (call.estado === 'nenhuma' ? '' : ' tem') + (call.estado === 'conectando' ? ' conectando' : '');
  painel.classList.toggle('conectando', call.estado === 'conectando');
  $('call-girando').hidden = call.estado !== 'conectando';
  if (call.estado === 'conectando') {
    $('call-titulo').textContent = call.papel === 'chamando' ? 'Chamando…' : 'Entrando…';
    $('call-sub').textContent = call.com;
  } else if (call.estado === 'conectada') {
    $('call-titulo').textContent = '🔊 Em chamada';
    $('call-sub').textContent = 'com ' + call.com;
  }
}

async function sairDaCall(){
  ponte.sairDaCall();           // a resposta vem por call:estado → 'encerrada'
}

// se fui eu que chamei e ele ainda não respondeu, o convite para de tocar lá
async function pararMeuConvite(ref){
  if (!ref) return;
  try{
    const atual = await getDoc(ref);
    if (atual.exists() && atual.data().estado === 'chamando') await updateDoc(ref, { estado: 'encerrada' });
  }catch{}
}

$('btn-sair-call').onclick = sairDaCall;

// o processo principal conta o que aconteceu com a call de verdade
ponte.aoMudarCall(async (d) => {
  if (d.estado === 'conectando') {
    if (call.estado === 'nenhuma') entrarEmEstado('conectando');
  } else if (d.estado === 'conectada') {
    if (call.estado !== 'nenhuma') entrarEmEstado('conectada');
    bater();
  } else if (d.estado === 'encerrada') {
    const ref = call.conviteRef;
    entrarEmEstado('nenhuma');
    bater();
    await pararMeuConvite(ref);
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
  pararConvites = onSnapshot(ref, (snap) => {
    convitesChegando = snap.docs;
    pintarConvite();
  }, (e) => { console.error(e); recado('Não consegui ligar o aviso de chamadas.', 'mal'); });
}

function conviteVivo(d){
  const q = d.data().quando;
  if (!q || typeof q.toMillis !== 'function') return true; // ainda sem carimbo do servidor: acabou de nascer
  return Date.now() - q.toMillis() < CONVITE_VALE_MS;
}

function pintarConvite(){
  const caixa = $('convite');
  const vivo = convitesChegando.find(conviteVivo);
  if (!vivo) { caixa.className = 'convite'; return; }
  const c = vivo.data();
  caixa.className = 'convite tem';
  $('convite-nick').textContent = c.deNick;
  $('convite-av').textContent = iniciais(c.deNick);

  $('btn-atender').onclick = async () => {
    $('btn-atender').disabled = true; $('btn-recusar').disabled = true;
    try{
      await updateDoc(vivo.ref, { estado: 'aceita' });
      // já estava numa call? ela dá lugar a esta (o app fecha a antiga
      // sem avisar 'encerrada' — a casa mesma faz a limpeza aqui)
      if (call.estado !== 'nenhuma') {
        const antigo = call.conviteRef;
        entrarEmEstado('nenhuma');
        pararMeuConvite(antigo);
      }
      entrarEmEstado('conectando', c.deNick, 'atendendo');
      $('conectando-txt').textContent = 'Entrando na chamada de ' + c.deNick + '…';
      const ok = await ponte.entrarComLink(c.link, eu.nick, c.deNick);
      if (!ok) { if (call.estado !== 'nenhuma') entrarEmEstado('nenhuma'); recado('Não consegui entrar na chamada.', 'mal'); }
    }catch(e){
      console.error(e); recado('Não consegui atender: ' + traduzirErro(e), 'mal');
    }finally{ $('btn-atender').disabled = false; $('btn-recusar').disabled = false; }
  };
  $('btn-recusar').onclick = async () => {
    try{ await updateDoc(vivo.ref, { estado: 'recusada' }); }catch{}
  };
}

/* =====================================================================
 * O PAINEL: avisa o app onde a call se encaixa
 * =================================================================== */
function mandarRectDoPainel(){
  const r = $('painel').getBoundingClientRect();
  if (r.width > 0 && r.height > 0) ponte.painelMudou({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(mandarRectDoPainel).observe($('painel'));
window.addEventListener('resize', mandarRectDoPainel);

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

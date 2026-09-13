import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs,
  onSnapshot, addDoc, updateDoc, serverTimestamp, limit,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

/* A chave aqui embaixo NÃO é segredo — é assim que o Firebase funciona:
   quem trava o acesso de verdade são as REGRAS do Firestore (do lado do
   servidor do Google), não esconder essa chave. Ela só identifica QUAL
   projeto, não dá permissão nenhuma sozinha. */
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

/* ---------------------------------------------------------------------
 * NICK VIRA E-MAIL POR BAIXO DOS PANOS
 * ---------------------------------------------------------------------
 * O Firebase Auth (no plano de graça) só faz login com formato de
 * e-mail. Em vez de pedir e-mail de verdade pro André, o nick vira um
 * e-mail fake e válido — a pessoa nunca vê isso, só digita o nick. */
function nickParaEmail(nick){
  const limpo = nick.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  return limpo + '@bigasvoice.app';
}

const $ = (id) => document.getElementById(id);
const telaLogin = $('tela-login');
const telaConta = $('tela-conta');

let paraDeOuvirConvites = null;
let paraDeOuvirAmigos = null;

/* ---------------------------------------------------------------------
 * CRIAR CONTA / ENTRAR
 * ------------------------------------------------------------------ */
$('btn-criar').onclick = async () => {
  const nick = $('nick').value.trim();
  const senha = $('senha').value;
  $('erro-login').textContent = '';
  if (nick.length < 2) { $('erro-login').textContent = 'O nick precisa de pelo menos 2 letras.'; return; }
  if (senha.length < 6) { $('erro-login').textContent = 'A senha precisa de pelo menos 6 caracteres.'; return; }
  try{
    const cred = await createUserWithEmailAndPassword(auth, nickParaEmail(nick), senha);
    await setDoc(doc(db, 'usuarios', cred.user.uid), {
      nick, nickBusca: nick.toLowerCase(), criadoEm: serverTimestamp(),
    });
  }catch(e){
    $('erro-login').textContent = traduzirErro(e);
  }
};

$('btn-entrar').onclick = async () => {
  const nick = $('nick').value.trim();
  const senha = $('senha').value;
  $('erro-login').textContent = '';
  if (!nick || !senha) { $('erro-login').textContent = 'Preenche o nick e a senha.'; return; }
  try{
    await signInWithEmailAndPassword(auth, nickParaEmail(nick), senha);
  }catch(e){
    $('erro-login').textContent = traduzirErro(e);
  }
};

$('btn-sair').onclick = () => signOut(auth);

function traduzirErro(e){
  const c = e && e.code || '';
  if (c.includes('email-already-in-use')) return 'Esse nick já tem conta. Tenta "Entrar" em vez de criar.';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found'))
    return 'Nick ou senha errados.';
  if (c.includes('weak-password')) return 'Senha muito fraca — usa pelo menos 6 caracteres.';
  return 'Não consegui completar (' + c.replace('auth/', '') + ').';
}

/* ---------------------------------------------------------------------
 * QUANDO LOGA / DESLOGA
 * ------------------------------------------------------------------ */
onAuthStateChanged(auth, async (usuario) => {
  if (paraDeOuvirConvites) { paraDeOuvirConvites(); paraDeOuvirConvites = null; }
  if (paraDeOuvirAmigos) { paraDeOuvirAmigos(); paraDeOuvirAmigos = null; }

  if (!usuario) {
    telaLogin.style.display = 'flex';
    telaConta.style.display = 'none';
    return;
  }

  telaLogin.style.display = 'none';
  telaConta.style.display = 'flex';

  const meuDoc = await getDoc(doc(db, 'usuarios', usuario.uid));
  const meuNick = meuDoc.exists() ? meuDoc.data().nick : '?';
  $('meu-nick').textContent = meuNick;

  ouvirAmigos(usuario.uid);
  ouvirConvites(usuario.uid, meuNick);
});

/* ---------------------------------------------------------------------
 * ADICIONAR AMIGO (busca por nick)
 * ------------------------------------------------------------------ */
$('btn-add').onclick = async () => {
  const nickBuscado = $('add-nick').value.trim();
  $('erro-add').textContent = '';
  if (!nickBuscado) return;
  const meuUid = auth.currentUser.uid;

  const q = query(collection(db, 'usuarios'), where('nickBusca', '==', nickBuscado.toLowerCase()), limit(1));
  const achou = await getDocs(q);
  if (achou.empty) { $('erro-add').textContent = 'Não achei ninguém com esse nick.'; return; }

  const amigoDoc = achou.docs[0];
  if (amigoDoc.id === meuUid) { $('erro-add').textContent = 'Esse nick é o seu.'; return; }

  await setDoc(doc(db, 'usuarios', meuUid, 'amigos', amigoDoc.id), {
    nick: amigoDoc.data().nick, desde: serverTimestamp(),
  });
  $('add-nick').value = '';
};

function ouvirAmigos(meuUid){
  const ref = collection(db, 'usuarios', meuUid, 'amigos');
  paraDeOuvirAmigos = onSnapshot(ref, (snap) => {
    const lista = $('lista-amigos');
    if (snap.empty) { lista.innerHTML = '<p class="vazio">Nenhum amigo salvo ainda.</p>'; return; }
    lista.innerHTML = '';
    snap.forEach((d) => {
      const amigo = d.data();
      const linha = document.createElement('div');
      linha.className = 'amigo';
      const nome = document.createElement('b'); nome.textContent = amigo.nick;
      const chamar = document.createElement('button');
      chamar.className = 'b-azul'; chamar.type = 'button'; chamar.textContent = '📞 Chamar';
      chamar.onclick = () => chamarAmigo(d.id, amigo.nick, chamar);
      linha.append(nome, chamar);
      lista.appendChild(linha);
    });
  });
}

/* ---------------------------------------------------------------------
 * CHAMAR: gera um link de verdade (pedindo pro site fazer isso, é ele
 * quem sabe o protocolo) e grava um convite que o amigo recebe na hora.
 * ------------------------------------------------------------------ */
async function chamarAmigo(amigoUid, amigoNick, botao){
  botao.disabled = true;
  const textoOriginal = botao.textContent;
  botao.textContent = 'Gerando link...';
  try{
    const link = await window.bigasConta.gerarLinkDeConvite();
    if (!link) { botao.textContent = 'Não consegui gerar o link'; setTimeout(() => botao.textContent = textoOriginal, 2500); return; }
    const meuDoc = await getDoc(doc(db, 'usuarios', auth.currentUser.uid));
    await addDoc(collection(db, 'convites'), {
      de: auth.currentUser.uid, deNick: meuDoc.data().nick,
      para: amigoUid, link, aberto: false, quando: serverTimestamp(),
    });
    botao.textContent = '✅ Chamado!';
  }catch(e){
    botao.textContent = 'Deu erro';
    console.error(e);
  }
  setTimeout(() => { botao.disabled = false; botao.textContent = textoOriginal; }, 2500);
}

/* ---------------------------------------------------------------------
 * RECEBER CHAMADAS — escuta em tempo real enquanto esta janela existir
 * ------------------------------------------------------------------ */
function ouvirConvites(meuUid){
  const ref = query(collection(db, 'convites'), where('para', '==', meuUid), where('aberto', '==', false));
  paraDeOuvirConvites = onSnapshot(ref, (snap) => {
    const caixa = $('caixa-convites');
    const lista = $('lista-convites');
    if (snap.empty) { caixa.className = 'convites'; lista.innerHTML = ''; return; }
    caixa.className = 'convites tem';
    lista.innerHTML = '';
    snap.forEach((d) => {
      const convite = d.data();
      const linha = document.createElement('div');
      linha.className = 'convite';
      const texto = document.createElement('b'); texto.textContent = convite.deNick + ' está te chamando';
      const entrar = document.createElement('button');
      entrar.className = 'b-verde'; entrar.type = 'button'; entrar.textContent = 'Entrar';
      entrar.onclick = async () => {
        entrar.disabled = true;
        await updateDoc(doc(db, 'convites', d.id), { aberto: true });
        window.bigasConta.entrarComLink(convite.link);
      };
      linha.append(texto, entrar);
      lista.appendChild(linha);
    });
  });
}

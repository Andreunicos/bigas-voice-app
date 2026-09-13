/* =====================================================================
 * BIGAS VOICE — a casca do aplicativo (Etapa 1)
 * ---------------------------------------------------------------------
 * Este app NÃO tem o Bigas Voice dentro dele. Ele abre o site de sempre
 * (https://andreunicos.github.io) numa janela própria, com ícone e tudo.
 * Vantagem: quando o site atualiza, o app mostra a versão nova na hora,
 * sem precisar baixar nada — só o que É do aplicativo (esta casca) passa
 * pelo auto-update.
 *
 * O que esta casca resolve que o navegador sozinho não resolve:
 *   1) uma janela própria, com ícone, separada do navegador;
 *   2) atualização automática da CASCA (electron-updater), de graça,
 *      puxando do GitHub Releases deste mesmo repositório;
 *   3) o seletor de tela (Electron não mostra o seletor nativo do Chrome
 *      sozinho — tem que ser construído, é o que `seletor-de-tela.*` faz).
 *
 * O que esta casca AINDA NÃO resolve (fica para a Etapa 2/3): captura de
 * tela sem o teto de fps, e áudio isolado por programa. Isso exige código
 * nativo de verdade, e essa etapa aqui é só o alicerce.
 * ================================================================== */
const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const SITE = 'https://andreunicos.github.io/';

let janelaPrincipal = null;

function criarJanelaPrincipal(){
  janelaPrincipal = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'Bigas Voice',
    backgroundColor: '#121419', // mesma cor de fundo do site, evita o "flash branco" ao abrir
    autoHideMenuBar: true,      // ninguém precisa da barra de menu padrão do Electron aqui
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  janelaPrincipal.loadURL(SITE);

  // link "abrir em nova aba" ou pop-up (ex.: convite compartilhado por outro
  // app) deve abrir no navegador de verdade, não numa segunda janela do app
  janelaPrincipal.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  janelaPrincipal.webContents.on('did-finish-load', injetarBotaoDeLink);
}

/* ---------------------------------------------------------------------
 * "ENTRAR COM UM LINK" — a peça que faltava
 * ---------------------------------------------------------------------
 * No site, clicar no link do convite JÁ É a entrada — o navegador abre
 * aquela URL, com a chave da sala no fragmento (#), e o próprio site lê
 * isso e entra sozinho. O app não tem barra de endereço nenhuma: sempre
 * abre a MESMA tela inicial. Sem um jeito de "colar o link aqui dentro",
 * quem só tem o app nunca consegue entrar na sala de ninguém.
 *
 * O botão flutuante chama uma janelinha (preload separado, mesmo padrão
 * do seletor de tela) que pede o link colado e manda a janela principal
 * navegar pra ele — validando que é mesmo do nosso site antes, pra não
 * virar um jeito de abrir qualquer coisa dentro do app.
 * ------------------------------------------------------------------ */
function injetarBotaoDeLink(){
  janelaPrincipal.webContents.insertCSS(`
    /* a versão do APLICATIVO (a casca) — não é a mesma VERSAO do site,
       que já aparece no canto do próprio Bigas Voice. Essa aqui existe
       pra responder "atualizou ou não" sem precisar clicar em nada. */
    #bigas-versao{
      position:fixed; right:10px; bottom:6px; z-index:999999;
      font:500 11px system-ui,-apple-system,'Segoe UI',sans-serif;
      color:#6d7583; pointer-events:none; user-select:none;
    }
    #bigas-botoes-app{
      position:fixed; left:16px; bottom:16px; z-index:999999;
      display:flex; gap:8px; font:600 12.5px/1 system-ui,-apple-system,'Segoe UI',sans-serif;
    }
    #bigas-botoes-app button{
      border:0; border-radius:22px; padding:10px 18px; cursor:pointer;
      font:inherit; color:#fff; box-shadow:0 8px 22px rgba(0,0,0,.45);
      display:flex; align-items:center; gap:8px; position:relative; overflow:hidden;
    }
    #bigas-link, #bigas-conta{ background:#171a21; border:1px solid #2a2f3a }
    #bigas-link:hover, #bigas-conta:hover{ background:#1d212a; border-color:#0891b2 }
    /* estados do botão de atualizar — cor muda com o que está acontecendo,
       não é só o texto: parado é neutro, achou é azul, pronto é verde */
    #bigas-atualizar{ background:#171a21; border:1px solid #2a2f3a; min-width:190px; justify-content:center }
    #bigas-atualizar.achou{ border-color:#0891b2 }
    #bigas-atualizar.pronto{ background:#3fd07a; border-color:#3fd07a; color:#0c0d10; font-weight:700 }
    #bigas-atualizar.pronto:hover{ background:#59d98d }
    #bigas-atualizar:disabled{ cursor:default; opacity:.85 }
    /* a barra de progresso é o próprio fundo do botão enchendo — não um
       elemento à parte, pra não precisar de outra camada de layout */
    #bigas-atualizar .barra{
      position:absolute; inset:0; background:#0891b2; z-index:0;
      transform-origin:left; transform:scaleX(0); transition:transform .25s linear;
    }
    #bigas-atualizar span{ position:relative; z-index:1; white-space:nowrap }
    @keyframes bigas-gira{ to{ transform:rotate(360deg) } }
    #bigas-atualizar .girando{
      width:12px; height:12px; border:2px solid rgba(255,255,255,.35);
      border-top-color:#fff; border-radius:50%; animation:bigas-gira .7s linear infinite;
      position:relative; z-index:1; flex-shrink:0;
    }
  `);
  janelaPrincipal.webContents.executeJavaScript(`
    (function(){
      if (!document.getElementById('bigas-versao')) {
        var v = document.createElement('div');
        v.id = 'bigas-versao';
        v.textContent = 'aplicativo v${app.getVersion()}';
        document.body.appendChild(v);
      }
      if (document.getElementById('bigas-botoes-app')) return;

      var caixa = document.createElement('div');
      caixa.id = 'bigas-botoes-app';

      var bLink = document.createElement('button');
      bLink.id = 'bigas-link'; bLink.type = 'button';
      bLink.textContent = '🔗 Entrar com um link';
      bLink.onclick = function(){ window.bigasApp.abrirColarLink(); };

      var bConta = document.createElement('button');
      bConta.id = 'bigas-conta'; bConta.type = 'button';
      bConta.textContent = '👤 Conta e amigos';
      bConta.onclick = function(){ window.bigasApp.abrirConta(); };

      var bAt = document.createElement('button');
      bAt.id = 'bigas-atualizar'; bAt.type = 'button';
      var barra = document.createElement('div'); barra.className = 'barra';
      var rotulo = document.createElement('span'); rotulo.textContent = '🔄 Verificar atualização';
      bAt.append(barra, rotulo);

      var voltarPraOcioso = null;
      function estado(nome, extra){
        clearTimeout(voltarPraOcioso);
        bAt.className = '';
        bAt.disabled = false;
        barra.style.transform = 'scaleX(0)';
        var girando = bAt.querySelector('.girando');
        if (girando) girando.remove();

        if (nome === 'ocioso') {
          rotulo.textContent = '🔄 Verificar atualização';
        } else if (nome === 'verificando') {
          bAt.disabled = true;
          var g = document.createElement('span'); g.className = 'girando';
          bAt.insertBefore(g, rotulo);
          rotulo.textContent = 'Procurando atualização...';
        } else if (nome === 'baixando') {
          bAt.className = 'achou'; bAt.disabled = true;
          barra.style.transform = 'scaleX(' + ((extra && extra.percentual || 0) / 100) + ')';
          rotulo.textContent = 'Baixando... ' + Math.round(extra && extra.percentual || 0) + '%';
        } else if (nome === 'pronto') {
          bAt.className = 'pronto'; bAt.disabled = false;
          rotulo.textContent = '🔁 Reiniciar e atualizar agora';
        } else if (nome === 'atualizado') {
          rotulo.textContent = '✅ Já está atualizado';
          voltarPraOcioso = setTimeout(function(){ estado('ocioso'); }, 3500);
        } else if (nome === 'erro') {
          rotulo.textContent = '⚠️ Não consegui checar agora';
          voltarPraOcioso = setTimeout(function(){ estado('ocioso'); }, 4000);
        }
      }
      estado('ocioso');

      bAt.onclick = function(){
        if (bAt.className === 'pronto') { window.bigasApp.instalarAtualizacao(); return; }
        window.bigasApp.verificarAtualizacao();
      };
      window.bigasApp.aoMudarEstadoAtualizacao(function(dados){ estado(dados.estado, dados); });

      caixa.append(bLink, bConta, bAt);
      document.body.appendChild(caixa);
    })();
  `).catch(() => {});
}

function abrirColarLink(){
  const janela = new BrowserWindow({
    width: 480,
    height: 240,
    parent: janelaPrincipal,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Entrar com um link',
    backgroundColor: '#121419',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  janela.loadFile('colar-link.html');
}

function linkEhValido(url){
  try { return new URL(url).origin === new URL(SITE).origin; } catch { return false; }
}

function ligarEntradaPorLink(){
  ipcMain.on('colar-link:abrir', () => abrirColarLink());
  ipcMain.on('colar-link:entrar', (ev, url) => {
    const valido = linkEhValido(url);
    if (valido) {
      janelaPrincipal.loadURL(url);
      const janela = BrowserWindow.fromWebContents(ev.sender);
      if (janela && !janela.isDestroyed()) janela.close();
    }
    ev.returnValue = valido;
  });
  // mesma coisa, mas sem fechar a janela de quem pediu — usado pela tela
  // de Conta, que continua aberta depois de mandar você pra call
  ipcMain.on('colar-link:entrar-silencioso', (ev, url) => {
    if (linkEhValido(url)) janelaPrincipal.loadURL(url);
  });
}

/* ---------------------------------------------------------------------
 * CONTA E AMIGOS
 * ---------------------------------------------------------------------
 * Essa janela roda o SDK do Firebase (autenticação + Firestore) — não
 * mexe no site nem no protocolo dele. A única ponte com o site real é
 * pedir um link de sala de verdade: em vez de reimplementar a criptografia
 * do Bigas Voice aqui (arriscado, duplicaria lógica e quebraria fácil se o
 * site mudar), a gente pede pra JANELA PRINCIPAL — que já tem o site
 * carregado — clicar no próprio botão "Criar sala" dela mesma, e devolve
 * o link que apareceu. Sempre o site quem gera o link; a Conta só pede.
 * ------------------------------------------------------------------ */
let janelaConta = null;

function abrirConta(){
  if (janelaConta && !janelaConta.isDestroyed()) { janelaConta.focus(); return; }
  janelaConta = new BrowserWindow({
    width: 420,
    height: 620,
    parent: janelaPrincipal,
    title: 'Conta e amigos — Bigas Voice',
    backgroundColor: '#121419',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'conta-preload.js'),
    },
  });
  janelaConta.loadFile('conta.html');
  janelaConta.on('closed', () => { janelaConta = null; });
}

async function gerarLinkNoSite(){
  if (!janelaPrincipal || janelaPrincipal.isDestroyed()) return null;
  try{
    return await janelaPrincipal.webContents.executeJavaScript(`
      (async function(){
        var jaTem = document.getElementById('sala-link');
        if (jaTem && jaTem.value) return jaTem.value;
        var botao = document.getElementById('btn-sala');
        if (!botao) return null; // não está na tela de entrada — não dá pra criar sala agora
        botao.click();
        for (var i = 0; i < 60; i++) {
          await new Promise(function(r){ setTimeout(r, 300); });
          var campo = document.getElementById('sala-link');
          if (campo && campo.value) return campo.value;
        }
        return null;
      })();
    `);
  }catch(e){
    console.error('gerar link pro convite falhou', e);
    return null;
  }
}

function ligarConta(){
  ipcMain.on('conta:abrir', () => abrirConta());
  ipcMain.handle('conta:gerar-link', () => gerarLinkNoSite());
}

/* ---------------------------------------------------------------------
 * MICROFONE E CÂMERA
 * ---------------------------------------------------------------------
 * O Electron, ao contrário do Chrome de verdade, não pergunta sozinho —
 * ele nega por padrão a não ser que o app decida. Aqui a regra é simples:
 * só o próprio site do Bigas Voice pode pedir, e só media (mic/câmera/
 * tela) — qualquer outra permissão (notificação, geolocalização etc.)
 * continua negada.
 * ------------------------------------------------------------------ */
function ligarPermissoes(){
  const permitido = new Set(['media']);
  session.defaultSession.setPermissionRequestHandler((webContents, permissao, callback) => {
    const origem = webContents.getURL();
    callback(permitido.has(permissao) && origem.startsWith(SITE));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permissao) => {
    const origem = webContents ? webContents.getURL() : '';
    return permitido.has(permissao) && origem.startsWith(SITE);
  });
}

/* ---------------------------------------------------------------------
 * O SELETOR DE TELA
 * ---------------------------------------------------------------------
 * getDisplayMedia() dentro do Electron não abre sozinho aquele painel do
 * Chrome com miniaturas de tela/janela — quem tem que desenhar esse
 * painel é o próprio app. `desktopCapturer.getSources` traz a lista com
 * miniaturas; `seletor-de-tela.html` mostra e devolve a escolha.
 * ------------------------------------------------------------------ */
function ligarSeletorDeTela(){
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const fontes = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });

    const janelaSeletor = new BrowserWindow({
      width: 760,
      height: 560,
      parent: janelaPrincipal,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Escolha o que compartilhar — Bigas Voice',
      backgroundColor: '#121419',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    const lista = fontes.map(f => ({
      id: f.id,
      nome: f.name,
      miniatura: f.thumbnail.toDataURL(),
      ehTela: f.id.startsWith('screen:'),
    }));

    let respondido = false;
    const responder = (escolhaId) => {
      if(respondido) return;
      respondido = true;
      const escolhida = fontes.find(f => f.id === escolhaId);
      if(!janelaSeletor.isDestroyed()) janelaSeletor.close();
      if(!escolhida){ callback({}); return; } // cancelou: nenhuma fonte = sem captura
      // 'loopback' pede o som do sistema inteiro — o Electron sabe fazer
      // isso no Windows; em outros sistemas ele ignora sozinho.
      callback({ video: escolhida, audio: 'loopback' });
    };

    ipcMain.once('seletor-de-tela:escolheu', (ev, id) => responder(id));
    janelaSeletor.once('closed', () => responder(null));

    janelaSeletor.loadFile('seletor-de-tela.html');
    janelaSeletor.webContents.once('did-finish-load', () => {
      janelaSeletor.webContents.send('seletor-de-tela:fontes', lista);
    });
  }, { useSystemPicker: false });
}

/* ---------------------------------------------------------------------
 * ATUALIZAÇÃO AUTOMÁTICA DA CASCA
 * ---------------------------------------------------------------------
 * Isto NÃO atualiza o Bigas Voice em si (o site já se atualiza sozinho
 * comparando VERSAO, e este app sempre carrega o site ao vivo). Isto
 * atualiza o APLICATIVO — a janela, o seletor de tela, e mais pra frente
 * a captura nativa. Fonte: GitHub Releases deste mesmo repositório,
 * publicado com "npm run publicar".
 * ------------------------------------------------------------------ */
/* ---------------------------------------------------------------------
 * O ESTADO VAI PRO BOTÃO SEMPRE, NÃO SÓ QUANDO A PESSOA CLICA
 * ---------------------------------------------------------------------
 * Versão anterior só respondia quando a pessoa clicava — se o app achasse
 * e baixasse uma atualização sozinho, em segundo plano, o botão continuava
 * dizendo "Verificar atualização" como se nada tivesse acontecido. Errado:
 * quem olhar a tela tem que VER que tem atualização pronta, sem precisar
 * clicar pra descobrir. Por isso todo evento do autoUpdater — clicado ou
 * não — transmite pro botão via 'atualizar:estado'.
 * ------------------------------------------------------------------ */
function transmitirEstadoAtualizacao(estado, extra){
  if (janelaPrincipal && !janelaPrincipal.isDestroyed())
    janelaPrincipal.webContents.send('atualizar:estado', Object.assign({ estado }, extra||{}));
}

function ligarAtualizacaoAutomatica(){
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => transmitirEstadoAtualizacao('verificando'));
  autoUpdater.on('update-available', () => transmitirEstadoAtualizacao('baixando', { percentual: 0 }));
  autoUpdater.on('download-progress', (p) =>
    transmitirEstadoAtualizacao('baixando', { percentual: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', () => transmitirEstadoAtualizacao('pronto'));
  autoUpdater.on('update-not-available', () => transmitirEstadoAtualizacao('atualizado'));
  autoUpdater.on('error', (erro) => {
    transmitirEstadoAtualizacao('erro');
    console.error('atualização automática falhou (não é crítico):', erro);
  });

  autoUpdater.checkForUpdatesAndNotify().catch(() => transmitirEstadoAtualizacao('erro'));
}

function ligarVerificacaoManual(){
  ipcMain.on('atualizar:verificar', () => {
    autoUpdater.checkForUpdates().catch(() => transmitirEstadoAtualizacao('erro'));
  });
  ipcMain.on('atualizar:instalar', () => autoUpdater.quitAndInstall());
}

app.whenReady().then(() => {
  ligarPermissoes();
  ligarSeletorDeTela();
  ligarEntradaPorLink();
  ligarConta();
  ligarVerificacaoManual();
  criarJanelaPrincipal();
  ligarAtualizacaoAutomatica();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) criarJanelaPrincipal();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

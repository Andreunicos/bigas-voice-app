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
const { app, BrowserWindow, session, desktopCapturer, ipcMain, dialog } = require('electron');
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
    #bigas-botoes-app{
      position:fixed; left:16px; bottom:16px; z-index:999999;
      display:flex; gap:8px;
    }
    #bigas-botoes-app button{
      background:#171a21; color:#eef1f6; border:1px solid #2a2f3a;
      border-radius:22px; padding:9px 16px; font:600 12.5px system-ui,sans-serif;
      cursor:pointer; box-shadow:0 8px 22px rgba(0,0,0,.4);
    }
    #bigas-botoes-app button:hover{ background:#1d212a; border-color:#0891b2 }
    #bigas-botoes-app button:disabled{ opacity:.6; cursor:default }
  `);
  janelaPrincipal.webContents.executeJavaScript(`
    (function(){
      if (document.getElementById('bigas-botoes-app')) return;
      var caixa = document.createElement('div');
      caixa.id = 'bigas-botoes-app';

      var bLink = document.createElement('button');
      bLink.type = 'button';
      bLink.textContent = '🔗 Entrar com um link';
      bLink.onclick = function(){ window.bigasApp.abrirColarLink(); };

      var bAtualizar = document.createElement('button');
      bAtualizar.type = 'button';
      bAtualizar.textContent = '🔄 Verificar atualização';
      bAtualizar.onclick = function(){
        bAtualizar.disabled = true;
        bAtualizar.textContent = '🔄 Checando...';
        window.bigasApp.verificarAtualizacao();
        setTimeout(function(){
          bAtualizar.disabled = false;
          bAtualizar.textContent = '🔄 Verificar atualização';
        }, 8000); // se a resposta demorar mais que isso, o botão libera de novo sozinho
      };

      caixa.append(bLink, bAtualizar);
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

function ligarEntradaPorLink(){
  ipcMain.on('colar-link:abrir', () => abrirColarLink());
  ipcMain.on('colar-link:entrar', (ev, url) => {
    let valido = false;
    try { valido = new URL(url).origin === new URL(SITE).origin; } catch { valido = false; }
    if (valido) {
      janelaPrincipal.loadURL(url);
      const janela = BrowserWindow.fromWebContents(ev.sender);
      if (janela && !janela.isDestroyed()) janela.close();
    }
    ev.returnValue = valido;
  });
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
/* ---- estado da atualização, pra o botão manual saber o que fazer ---- */
let atualizacaoPronta = false;   // já baixou, só falta reiniciar pra valer
let verificandoNaMao = false;    // a pessoa clicou no botão — dar retorno visível

function fecharAtualizarEAbrir(){
  dialog.showMessageBox(janelaPrincipal, {
    type: 'info', title: 'Bigas Voice',
    message: 'Atualização baixada. O Bigas Voice vai fechar e abrir de novo, já atualizado.',
    buttons: ['Ok'],
  }).then(() => autoUpdater.quitAndInstall());
}

function ligarAtualizacaoAutomatica(){
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', () => {
    atualizacaoPronta = true;
    // instala sozinho na próxima vez que o app fechar — sem interromper
    // quem está no meio de uma call. Mas se foi a PESSOA que pediu pra
    // checar agora (clicou no botão), ela está esperando ver algo
    // acontecer — não faz sentido fazer ela esperar fechar sozinha depois.
    if (verificandoNaMao) { verificandoNaMao = false; fecharAtualizarEAbrir(); }
  });
  autoUpdater.on('update-not-available', () => {
    if (verificandoNaMao) {
      verificandoNaMao = false;
      dialog.showMessageBox(janelaPrincipal, {
        type: 'info', title: 'Bigas Voice',
        message: 'Você já está na versão mais recente.',
      });
    }
  });
  autoUpdater.on('error', (erro) => {
    if (verificandoNaMao) {
      verificandoNaMao = false;
      dialog.showMessageBox(janelaPrincipal, {
        type: 'error', title: 'Bigas Voice',
        message: 'Não consegui checar agora (sem internet, ou nenhuma versão publicada ainda).',
      });
    }
    console.error('atualização automática falhou (não é crítico):', erro);
  });

  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    // sem internet, ou ainda não existe nenhum Release publicado — segue
    // a vida normalmente com a versão que já está instalada
  });
}

/* O botão "Verificar atualização" na tela: se já tem uma baixada e
   esperando (aconteceu de fundo, sem a pessoa pedir), instala na hora.
   Senão, dispara uma checagem nova e avisa o resultado — "já está
   atualizado" ou baixa e instala, sempre com retorno visível dessa vez. */
function ligarVerificacaoManual(){
  ipcMain.on('atualizar:verificar', () => {
    if (atualizacaoPronta) { fecharAtualizarEAbrir(); return; }
    verificandoNaMao = true;
    autoUpdater.checkForUpdates().catch(() => { verificandoNaMao = false; });
  });
}

app.whenReady().then(() => {
  ligarPermissoes();
  ligarSeletorDeTela();
  ligarEntradaPorLink();
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

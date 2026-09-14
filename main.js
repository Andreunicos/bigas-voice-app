/* =====================================================================
 * BIGAS VOICE — o aplicativo (Discord 2.0)
 * ---------------------------------------------------------------------
 * A janela principal mostra SEMPRE a casa (home.html): login, depois a
 * lista de amigos + chat. Ela nunca navega pra outro lugar.
 *
 * Uma call é uma `WebContentsView` encaixada por cima do palco da casa
 * (a área grande à direita). Dentro dela roda o site de verdade do
 * Bigas Voice — e o app veste esse site com CSS e um pouquinho de JS pra
 * que nada de "link", "código", "criar sala" apareça: só a call em si.
 * Quando a call acaba, a view é destruída e o palco volta. A lista de
 * amigos nunca sai da tela.
 *
 * Quem cria a sala continua sendo o PRÓPRIO site (clicando de verdade no
 * botão dele, dentro da view) — nunca reimplementamos a criptografia
 * aqui. E quem cria é a view VISÍVEL, então você é o dono da sala.
 * ================================================================== */
const {
  app, BrowserWindow, WebContentsView, session, desktopCapturer, ipcMain,
  shell, Menu, Tray, Notification, globalShortcut, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const SITE = 'https://andreunicos.github.io/';
const ICONE = path.join(__dirname, 'icone.png');

let janelaPrincipal = null;
let viewCall = null;          // a call em andamento (ou null)
let bandeja = null;           // ícone na bandeja (só se a pessoa ligar)
let nickAtual = '';           // nick da conta logada, pra assinar dentro do site
let outroNick = '';           // nick de quem está do outro lado (só pra textos)
let rectPalco = { x: 346, y: 0, width: 934, height: 820 }; // onde a call se encaixa (a casa avisa)
let emTelaCheia = false;      // alguém pediu "tela cheia" num vídeo dentro da call
let saindoDeVerdade = false;  // "Sair" na bandeja / quitAndInstall: ignora "minimizar pra bandeja"

/* ---------------------------------------------------------------------
 * CONFIGURAÇÃO (fica em userData/config.json; a casa manda mudanças)
 * ------------------------------------------------------------------ */
const ARQ_CONFIG = () => path.join(app.getPath('userData'), 'config.json');
let config = { bandeja: false, iniciarComWindows: false, atalhoMic: 'Control+Shift+M', atalhoSurdo: 'Control+Shift+D' };
function lerConfig(){
  try { Object.assign(config, JSON.parse(fs.readFileSync(ARQ_CONFIG(), 'utf8'))); } catch {}
}
function guardarConfig(){
  try { fs.writeFileSync(ARQ_CONFIG(), JSON.stringify(config, null, 2)); } catch (e) { console.error('config', e); }
}
function aplicarConfig(){
  if (config.bandeja) criarBandeja(); else destruirBandeja();
  try { app.setLoginItemSettings({ openAtLogin: !!config.iniciarComWindows }); } catch {}
  registrarAtalhos();
}

function linkEhValido(url){
  try { return new URL(url).origin === new URL(SITE).origin; } catch { return false; }
}

/* ---------------------------------------------------------------------
 * A JANELA
 * ------------------------------------------------------------------ */
function criarJanelaPrincipal(){
  janelaPrincipal = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Bigas Voice',
    icon: ICONE,
    backgroundColor: '#0c0d10',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // zoom na casa desalinharia a view da call (ela é posicionada em pixels
  // CSS da casa) — então zoom desligado, e sem menu escondido com atalhos
  janelaPrincipal.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  janelaPrincipal.webContents.on('did-finish-load', () => {
    janelaPrincipal.webContents.setZoomFactor(1);
  });

  janelaPrincipal.loadFile('home.html');

  janelaPrincipal.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  janelaPrincipal.on('resize', posicionarView);
  janelaPrincipal.on('focus', () => { janelaPrincipal.flashFrame(false); });

  // fechar a janela: encerra o app — OU, se a pessoa LIGOU "bandeja",
  // some pra bandeja (numa call, continua na call). Nunca fica em segundo
  // plano sem a pessoa ter pedido.
  janelaPrincipal.on('close', (ev) => {
    if (config.bandeja && !saindoDeVerdade) {
      ev.preventDefault();
      janelaPrincipal.hide();
    }
  });
  janelaPrincipal.on('closed', () => { janelaPrincipal = null; viewCall = null; app.quit(); });
}

function mostrarJanela(){
  if (!janelaPrincipal || janelaPrincipal.isDestroyed()) return;
  if (!janelaPrincipal.isVisible()) janelaPrincipal.show();
  if (janelaPrincipal.isMinimized()) janelaPrincipal.restore();
  janelaPrincipal.focus();
}

function avisarHome(canal, dados){
  if (janelaPrincipal && !janelaPrincipal.isDestroyed())
    janelaPrincipal.webContents.send(canal, dados || {});
}

/* ---------------------------------------------------------------------
 * BANDEJA (opcional) E NOTIFICAÇÕES
 * ------------------------------------------------------------------ */
function criarBandeja(){
  if (bandeja) return;
  try{
    const img = nativeImage.createFromPath(ICONE).resize({ width: 16, height: 16 });
    bandeja = new Tray(img);
    bandeja.setToolTip('Bigas Voice');
    bandeja.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir o Bigas Voice', click: mostrarJanela },
      { type: 'separator' },
      { label: 'Sair', click: () => { saindoDeVerdade = true; app.quit(); } },
    ]));
    bandeja.on('click', mostrarJanela);
    bandeja.on('double-click', mostrarJanela);
  }catch(e){ console.error('bandeja', e); bandeja = null; }
}
function destruirBandeja(){
  if (bandeja) { try { bandeja.destroy(); } catch {} bandeja = null; }
}

function notificar(titulo, texto){
  if (!Notification.isSupported()) return;
  try{
    const n = new Notification({ title: titulo, body: texto, icon: ICONE, silent: true });
    n.on('click', mostrarJanela);
    n.show();
  }catch(e){ console.warn('notificação', e); }
}

/* ---------------------------------------------------------------------
 * ATALHOS GLOBAIS — mutar / silenciar de dentro do jogo
 * ---------------------------------------------------------------------
 * O Electron só sabe quando a tecla DESCE (não quando solta), então isto
 * é liga/desliga, não "segurar pra falar". Segurar pra falar de verdade
 * fora da janela precisaria de um gancho nativo de teclado — fica pra
 * quando valer a pena instalar um.
 * ------------------------------------------------------------------ */
function registrarAtalhos(){
  globalShortcut.unregisterAll();
  const ligar = (combo, funcao) => {
    if (!combo) return;
    try { if (!globalShortcut.register(combo, funcao)) console.warn('atalho ocupado:', combo); }
    catch (e) { console.warn('atalho inválido:', combo, e.message); }
  };
  ligar(config.atalhoMic, () => acionarNaCall('mic'));
  ligar(config.atalhoSurdo, () => acionarNaCall('surdo'));
}

/* aperta o botão do site (mic / fone) dentro da call, se houver call */
function acionarNaCall(qual){
  if (!viewCall) return;
  const fn = qual === 'mic' ? 'alternarMudo' : 'alternarSurdo';
  viewCall.webContents.executeJavaScript('try{ ' + fn + '(); }catch(e){} true').catch(() => {});
}

/* ---------------------------------------------------------------------
 * A VIEW DA CALL
 * ------------------------------------------------------------------ */
function posicionarView(){
  if (!viewCall || !janelaPrincipal || janelaPrincipal.isDestroyed()) return;
  if (emTelaCheia) {
    const b = janelaPrincipal.getContentBounds();
    viewCall.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  } else {
    viewCall.setBounds(rectPalco);
  }
}

function criarViewCall(){
  viewCall = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // uma call não pode "dormir" quando a janela minimiza
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  viewCall.setBackgroundColor('#0c0d10');
  janelaPrincipal.contentView.addChildView(viewCall);
  posicionarView();

  const wc = viewCall.webContents;
  const estaView = viewCall;

  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (ev, url) => {
    if (!linkEhValido(url)) { ev.preventDefault(); shell.openExternal(url); }
  });

  // veste o site a cada carga (o site se recarrega sozinho quando sai
  // versão nova dele — e volta pra mesma sala; a roupa tem que voltar junto)
  wc.on('dom-ready', () => vestirSite(wc));

  // "tela cheia" num vídeo: a view cobre a janela inteira e a janela vai
  // pra tela cheia de verdade — igual maximizar a transmissão no Discord
  wc.on('enter-html-full-screen', () => {
    emTelaCheia = true;
    janelaPrincipal.setFullScreen(true);
    posicionarView();
  });
  wc.on('leave-html-full-screen', () => {
    emTelaCheia = false;
    janelaPrincipal.setFullScreen(false);
    posicionarView();
  });

  wc.on('render-process-gone', () => { if (viewCall === estaView) encerrarCall('caiu'); });
  wc.on('did-fail-load', (ev, codigo, desc, url, principal) => {
    // -3 é "abortado" (a própria página trocou de endereço no meio) — não é falha
    if (principal && codigo !== -3 && viewCall === estaView) encerrarCall('semInternet');
  });

  return viewCall;
}

async function encerrarCall(motivo){
  if (!viewCall) return;
  const v = viewCall;
  viewCall = null;
  if (emTelaCheia) {
    emTelaCheia = false;
    if (janelaPrincipal && !janelaPrincipal.isDestroyed()) janelaPrincipal.setFullScreen(false);
  }
  // avisa os outros da call antes de fechar ("tchau" — senão vira fantasma
  // por alguns segundos na tela deles)
  try{
    await Promise.race([
      v.webContents.executeJavaScript('try{ darAdeus(); }catch(e){} true'),
      new Promise((r) => setTimeout(r, 400)),
    ]);
  }catch{}
  try { if (janelaPrincipal && !janelaPrincipal.isDestroyed()) janelaPrincipal.contentView.removeChildView(v); } catch {}
  try { v.webContents.close(); } catch {}
  // "trocou" = já vem outra call no lugar; a casa mesma cuidou da anterior
  if (motivo !== 'trocou') avisarHome('call:estado', { estado: 'encerrada', motivo: motivo || '' });
}

/* ---------------------------------------------------------------------
 * VESTIR O SITE: só a call aparece
 * ---------------------------------------------------------------------
 * O site tem a tela de entrada dele (criar sala, link, WhatsApp, modo
 * manual, "use fone"…). Dentro do app nada disso faz sentido — o app já
 * resolveu quem chama quem. Então: esconde tudo do cartão de entrada,
 * menos o texto de estado ("esperando…", "conectando…") e erros.
 *
 * Também: assina com o nick da conta; "botão direito" numa pessoa abre o
 * menu dela (volume, silenciar) igual no Discord; o botão de encerrar do
 * site devolve a pessoa pra casa; e mic/fone são espelhados pro rodapé.
 * ------------------------------------------------------------------ */
function vestirSite(wc){
  wc.insertCSS(`
    #entrada{ background-image:none !important; padding:0 !important }
    #entrada .cartao{
      background:transparent !important; border:0 !important; box-shadow:none !important;
      width:min(520px,100%) !important; text-align:center;
    }
    #entrada .cartao-topo, #entrada .campo-nome, #manual-bloco, #entrada .fone, #entrada .cartao-pe,
    #sala-bloco > .ajuda, #btn-sala, #btn-teste, #sala-link, #sala-envio, #aviso-link, .voce-pronto{
      display:none !important;
    }
    #sala-cx{ margin-top:0 !important; animation:none !important }
    .sala{ padding:0 24px !important; animation:none !important }
    .sala-estado{ justify-content:center; font-size:15px !important; color:#a2aab8 !important }
    #erro{ margin:14px 24px 0 !important }
    #btn-sala-denovo{ max-width:260px; margin:14px auto 0 !important }
  `).catch(() => {});

  wc.executeJavaScript(`
    (function(){
      if (window.__bigasVestido) return;
      window.__bigasVestido = true;

      // assina com o nick da conta (o site guarda e manda pros outros)
      var nick = ${JSON.stringify(nickAtual || '')};
      var n = document.getElementById('meu-nome');
      if (n && nick && n.value !== nick) {
        n.value = nick;
        n.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // o site copia o link da sala pra área de transferência ao criar —
      // dentro do app o link não é pra ninguém ver, nem colar sem querer
      try { navigator.clipboard.writeText = function(){ return Promise.reject(new Error('desligado no app')); }; } catch(e){}

      // O ECO DA VOZ NA TRANSMISSÃO, resolvido de vez: a captura do som do
      // sistema passa a EXCLUIR o som que o próprio app está tocando — ou
      // seja, as vozes da call. Jogo, YouTube, tudo continua indo; a voz
      // dos amigos não volta pra eles. (restrictOwnAudio: Chromium ≥ 152;
      // medido aqui: o som próprio cai de -58 dB pra -107 dB na captura.)
      try {
        var md = navigator.mediaDevices;
        var gdmOriginal = md.getDisplayMedia.bind(md);
        md.getDisplayMedia = function(c){
          c = Object.assign({}, c || {});
          if (c.audio) c.audio = Object.assign({}, c.audio === true ? {} : c.audio, { restrictOwnAudio: true });
          return gdmOriginal(c);
        };
      } catch(e){}

      // os textos de estado do site falam em "link", "aba", "modo manual" —
      // aqui dentro nada disso existe. Traduz na saída, sem mexer no site.
      var outro = ${JSON.stringify(outroNick || '')} || 'seu amigo';
      var dizerOriginal = window.dizerSala;
      if (typeof dizerOriginal === 'function') {
        window.dizerSala = function(t){
          t = String(t == null ? '' : t)
            .replace('esperando seu amigo abrir o link…', 'chamando ' + outro + '…')
            .replace('ninguém aqui ainda — pode deixar esta aba aberta', 'ainda procurando ' + outro + '…')
            .replace('procurando quem já está na call…', 'entrando na chamada de ' + outro + '…');
          return dizerOriginal(t);
        };
      }
      if (typeof window.caiuPraManual === 'function' && typeof window.erro === 'function') {
        window.caiuPraManual = function(e){
          console.warn('sala', e);
          var m = String((e && e.message) || e || '');
          window.erro(m === 'SEM_SINAL'
            ? 'Não consegui falar com o servidor de sinal (a rede daqui pode estar bloqueando). Tenta de novo em alguns segundos.'
            : 'Deu problema na chamada: ' + m + '. Tenta de novo.');
        };
      }

      // encerrar = voltar pra casa (o app fecha a call; o site não recarrega)
      document.addEventListener('click', function(ev){
        var b = ev.target && ev.target.closest && ev.target.closest('#btn-sair');
        if (!b) return;
        ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
        window.bigasApp.sairDaCall();
      }, true);

      // botão direito numa pessoa (ficha no topo OU a tela que ela está
      // transmitindo) abre o menu dela: volume só dela, silenciar, etc.
      document.addEventListener('contextmenu', function(ev){
        var alvo = ev.target;
        if (!alvo || !alvo.closest) return;
        var f = alvo.closest('.ficha:not(.eu)');
        var q = f ? null : alvo.closest('.quadro[id^="q-p-"]');
        if (!f && !q) return;
        ev.preventDefault();
        var id = f ? f.id.slice('ficha-'.length) : q.id.slice('q-p-'.length);
        var par = (typeof pares !== 'undefined') && pares.get(id);
        if (!par || typeof abrirMenuDaPessoa !== 'function') return;
        abrirMenuDaPessoa(par, f || q);
        var m = document.getElementById('menu-pessoa');
        if (m) {
          m.style.left = Math.max(10, Math.min(innerWidth - m.offsetWidth - 10, ev.clientX)) + 'px';
          m.style.top  = Math.max(10, Math.min(innerHeight - m.offsetHeight - 10, ev.clientY)) + 'px';
        }
      });

      // avisa a casa no instante em que a call conecta de verdade, e
      // espelha mic/fone (o rodapé da casa mostra e controla os dois)
      var ch = document.getElementById('chamada');
      if (ch) {
        var avisado = false;
        var ver = function(){ if (!ch.hidden && !avisado) { avisado = true; window.bigasApp.avisar('conectada'); } };
        new MutationObserver(ver).observe(ch, { attributes: true, attributeFilter: ['hidden'] });
        ver();
      }
      var bm = document.getElementById('btn-mic'), bs = document.getElementById('btn-surdo');
      var espelhar = function(){
        window.bigasApp.avisar('controles:' + (bm && bm.classList.contains('on') ? 1 : 0) + (bs && bs.classList.contains('on') ? 1 : 0));
      };
      if (bm) new MutationObserver(espelhar).observe(bm, { attributes: true, attributeFilter: ['class'] });
      if (bs) new MutationObserver(espelhar).observe(bs, { attributes: true, attributeFilter: ['class'] });
      espelhar();
    })();
  `).catch(() => {});
}

/* dentro da view: clica no botão do site de criar sala e espera o link */
const SCRIPT_CRIAR_SALA = `
  (async function(){
    var campo = document.getElementById('sala-link');
    if (campo && campo.value) return campo.value; // o site já voltou pra sala sozinho
    var b = document.getElementById('btn-sala');
    if (!b) return null;
    if (!b.disabled) b.click();
    for (var i = 0; i < 120; i++) {
      await new Promise(function(r){ setTimeout(r, 250); });
      campo = document.getElementById('sala-link');
      if (campo && campo.value) return campo.value;
      var erro = document.getElementById('erro');
      if (erro && !erro.hidden && erro.textContent) return null;
    }
    return null;
  })();
`;

function ligarChamadas(){
  // chamar um amigo: abre a call, o site cria a sala, e o link volta só
  // pra casa guardar no convite (a pessoa nunca vê esse link)
  ipcMain.handle('call:iniciar', async (ev, nick, comQuem) => {
    if (!janelaPrincipal || janelaPrincipal.isDestroyed()) return null;
    nickAtual = String(nick || '').slice(0, 18);
    outroNick = String(comQuem || '').slice(0, 18);
    if (viewCall) await encerrarCall('trocou');
    const v = criarViewCall();
    avisarHome('call:estado', { estado: 'conectando' });
    try{
      await v.webContents.loadURL(SITE);
      if (viewCall !== v) return null;
      const link = await v.webContents.executeJavaScript(SCRIPT_CRIAR_SALA);
      if (viewCall !== v) return null;
      if (!link || !linkEhValido(link)) { encerrarCall('semLink'); return null; }
      v.webContents.focus();
      return link;
    }catch(e){
      console.error('iniciar call falhou', e);
      if (viewCall === v) encerrarCall('semInternet');
      return null;
    }
  });

  // aceitar um convite: abre a call direto no link que veio no convite
  ipcMain.handle('call:entrar', async (ev, link, nick, comQuem) => {
    if (!janelaPrincipal || janelaPrincipal.isDestroyed()) return false;
    if (!linkEhValido(link)) return false;
    nickAtual = String(nick || '').slice(0, 18);
    outroNick = String(comQuem || '').slice(0, 18);
    if (viewCall) await encerrarCall('trocou');
    const v = criarViewCall();
    avisarHome('call:estado', { estado: 'conectando' });
    try{
      await v.webContents.loadURL(link);
      if (viewCall !== v) return false;
      v.webContents.focus();
      return true;
    }catch(e){
      console.error('entrar na call falhou', e);
      if (viewCall === v) encerrarCall('semInternet');
      return false;
    }
  });

  ipcMain.on('call:sair', () => encerrarCall('saiu'));
  ipcMain.on('call:mic', () => acionarNaCall('mic'));
  ipcMain.on('call:surdo', () => acionarNaCall('surdo'));

  // recados de dentro da call (ex.: "conectou de verdade", mic/fone)
  ipcMain.on('call:aviso', (ev, o) => {
    if (!viewCall || ev.sender !== viewCall.webContents) return;
    o = String(o || '');
    if (o === 'conectada') avisarHome('call:estado', { estado: 'conectada' });
    else if (o.startsWith('controles:')) avisarHome('call:controles', { mudo: o[10] === '1', surdo: o[11] === '1' });
  });

  // a casa avisa onde fica o palco (a view da call se encaixa ali)
  ipcMain.on('palco:rect', (ev, r) => {
    if (!r || !(r.width > 0) || !(r.height > 0)) return;
    rectPalco = {
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width), height: Math.round(r.height),
    };
    posicionarView();
  });

  // tocando: pisca na barra de tarefas e avisa pelo Windows se a janela
  // não está na frente (o som quem faz é a casa)
  ipcMain.on('tocar', (ev, ligado, quem) => {
    if (!janelaPrincipal || janelaPrincipal.isDestroyed()) return;
    janelaPrincipal.flashFrame(!!ligado);
    if (ligado && !janelaPrincipal.isFocused()) notificar('Bigas Voice', (quem || 'Alguém') + ' está te chamando');
  });
  ipcMain.on('notificar', (ev, titulo, texto) => {
    if (janelaPrincipal && janelaPrincipal.isFocused() && janelaPrincipal.isVisible()) return;
    notificar(String(titulo || 'Bigas Voice').slice(0, 60), String(texto || '').slice(0, 200));
  });

  ipcMain.handle('app:versao', () => app.getVersion());

  // "Otimizações para jogos em janela" do Windows: por usuário, sem admin.
  // Deixa a captura de um jogo em janela quase de graça (o Windows entrega
  // o quadro em vez de copiar). Guardado como texto "chave=valor;" numa
  // string única — mexe SÓ na chave certa e preserva o resto (Auto HDR…).
  ipcMain.handle('windows:jogosJanela', async (ev, ligar) => {
    if (process.platform !== 'win32') return null;
    const { execFile } = require('child_process');
    const CHAVE = ['HKCU', 'Software', 'Microsoft', 'DirectX', 'UserGpuPreferences'].join('\\');
    const VALOR = 'DirectXUserGlobalSettings';
    const reg = (args) => new Promise((r) => execFile('reg.exe', args, { windowsHide: true }, (e, out) => r(e ? '' : String(out || ''))));
    const ler = async () => {
      const out = await reg(['query', CHAVE, '/v', VALOR]);
      const m = out.match(/REG_SZ\s+(.*)$/m);
      return m ? m[1].trim() : '';
    };
    let atual = await ler();
    if (ligar === true || ligar === false) {
      const partes = atual.split(';').map((x) => x.trim()).filter((x) => x && !/^SwapEffectUpgradeEnable=/i.test(x));
      partes.push('SwapEffectUpgradeEnable=' + (ligar ? '1' : '0'));
      await reg(['add', CHAVE, '/v', VALOR, '/t', 'REG_SZ', '/d', partes.join(';') + ';', '/f']);
      atual = await ler();
    }
    return /SwapEffectUpgradeEnable=1/i.test(atual);
  });
  ipcMain.handle('config:ler', () => config);
  ipcMain.handle('config:mudar', (ev, mudancas) => {
    const permitidas = ['bandeja', 'iniciarComWindows', 'atalhoMic', 'atalhoSurdo'];
    for (const k of permitidas) if (mudancas && k in mudancas) config[k] = mudancas[k];
    guardarConfig();
    aplicarConfig();
    return config;
  });
}

/* ---------------------------------------------------------------------
 * MICROFONE E CÂMERA
 * ---------------------------------------------------------------------
 * O Electron, ao contrário do Chrome de verdade, não pergunta sozinho —
 * ele nega por padrão a não ser que o app decida. Só o próprio site do
 * Bigas Voice pode pedir, e só media (mic/câmera/tela).
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
 * painel é o próprio app.
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
      icon: ICONE,
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
    const aoEscolher = (ev, id) => responder(id);
    const responder = (escolhaId) => {
      if(respondido) return;
      respondido = true;
      // o ouvinte morre junto com o pedido: se ficasse vivo (fechou o seletor
      // sem escolher), ele engoliria a escolha da PRÓXIMA transmissão e o
      // seletor seguinte nunca responderia
      ipcMain.removeListener('seletor-de-tela:escolheu', aoEscolher);
      const escolhida = fontes.find(f => f.id === escolhaId);
      if(!janelaSeletor.isDestroyed()) janelaSeletor.close();
      // negar = callback sem nada. Com `{}` o Electron 44 lança "Video was
      // requested, but no video stream was provided" e a promessa do site
      // nunca resolve — o botão de compartilhar ficava travado até sair da call.
      // E a resposta vai DEPOIS do evento: responder de dentro do 'closed' da
      // janela (a pessoa fechou o seletor no X) derrubava o app inteiro.
      setTimeout(() => {
        try{
          if(!escolhida){ callback(); return; }
          callback({ video: escolhida, audio: 'loopback' });
        }catch(e){ console.error('seletor de tela', e); try{ callback(); }catch{} }
      }, 0);
    };

    ipcMain.on('seletor-de-tela:escolheu', aoEscolher);
    janelaSeletor.once('closed', () => responder(null));

    janelaSeletor.loadFile('seletor-de-tela.html');
    janelaSeletor.webContents.once('did-finish-load', () => {
      janelaSeletor.webContents.send('seletor-de-tela:fontes', lista);
    });
  }, { useSystemPicker: false });
}

/* ---------------------------------------------------------------------
 * ATUALIZAÇÃO AUTOMÁTICA DO APLICATIVO
 * ---------------------------------------------------------------------
 * Fonte: GitHub Releases deste repositório, publicado com "npm run
 * publicar". Baixa sozinho; instala ao fechar o app, ou na hora se a
 * pessoa clicar no botão da casa quando ele ficar verde.
 * ------------------------------------------------------------------ */
function transmitirEstadoAtualizacao(estado, extra){
  avisarHome('atualizar:estado', Object.assign({ estado }, extra || {}));
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
  // e de tempo em tempo, pra quem deixa o app aberto o dia inteiro
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

function ligarVerificacaoManual(){
  ipcMain.on('atualizar:verificar', () => {
    autoUpdater.checkForUpdates().catch(() => transmitirEstadoAtualizacao('erro'));
  });
  ipcMain.on('atualizar:instalar', () => { saindoDeVerdade = true; autoUpdater.quitAndInstall(); });
}

/* ------------------------------------------------------------------ */
// uma instância só: abrir de novo traz a janela que já existe pra frente
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', mostrarJanela);

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    lerConfig();
    ligarPermissoes();
    ligarSeletorDeTela();
    ligarChamadas();
    ligarVerificacaoManual();
    criarJanelaPrincipal();
    aplicarConfig();
    ligarAtualizacaoAutomatica();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) criarJanelaPrincipal();
    });
  });

  app.on('before-quit', () => { saindoDeVerdade = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => app.quit());
}

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
  shell, Menu, Tray, Notification, globalShortcut, nativeImage, screen, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

// modo de teste: nenhuma janela pode aparecer na tela (o harness liga isto)
const INVISIVEL = process.env.BIGAS_INVISIVEL === '1';

/* ---------------------------------------------------------------------
 * REGISTRO — as últimas linhas de log ficam na memória pro Diagnóstico
 * ------------------------------------------------------------------ */
const registro = [];
function anotar(nivel, partes){
  try{
    const txt = partes.map((x) => (x instanceof Error) ? (x.stack || x.message) : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    registro.push(new Date().toLocaleTimeString('pt-BR') + ' ' + nivel + ' ' + txt.slice(0, 400));
    if (registro.length > 200) registro.shift();
  }catch{}
}
for (const n of ['log', 'warn', 'error']) {
  const original = console[n].bind(console);
  console[n] = (...a) => { anotar(n, a); original(...a); };
}

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
let config = {
  bandeja: false, iniciarComWindows: false,
  atalhoMic: 'Control+Shift+M', atalhoSurdo: 'Control+Shift+D',
  // voz / som / transmissão — o app guarda e EMPURRA pra dentro do site na call
  micRotulo: '',        // nome do microfone (o id muda de site pra site; o nome não)
  saidaRotulo: '',      // nome da saída de som
  fala: 'voz',          // 'voz' (aberto) | 'ptt' (segurar pra falar)
  teclaPtt: 'KeyV', nomeTeclaPtt: 'V',
  limpar: true,         // cancelamento de eco / ruído no mic
  volume: 100,          // volume geral dos amigos (0–200)
  qualidade: '1080-60-8', // perfil da transmissão (chaves do site). 'auto' mede a máquina e, com jogo aberto, escolhe 720p — no app o padrão é 1080p60
  codec: 'auto',
  somDaTela: true,
  captura: 'dxgi',      // 'dxgi' (padrão do Chromium) | 'wgc' (Windows Graphics Capture) — vale ao reabrir
  prioridadeCaptura: false, // (CPU) processos do app um degrau acima do normal durante a call — medido: ruído
  prioridadeGpu: true,      // (GPU) fila da placa atende a captura antes do jogo (como o OBS faz) — vale a pena
  nitidezExtra: false,      // 1,5x de banda pra imagem (site v6.18) — pra quem tem upload sobrando
  ruidoForte: false,        // cancelamento de ruído forte (RNNoise) por cima do do Chromium — teclado mecânico, ventilador
  sobrepor: true,           // "quem está falando" por cima do jogo (janelinha transparente, só com o jogo na frente)
  cantoSobreposicao: 'esq-cima', // esq-cima | dir-cima | esq-baixo | dir-baixo
  mostrarJogo: true,        // os amigos veem "Jogando PUBG" quando um jogo conhecido está aberto
};
function lerConfig(){
  try { Object.assign(config, JSON.parse(fs.readFileSync(ARQ_CONFIG(), 'utf8'))); } catch {}
  // quem instalou antes ficou com 'auto' guardado (que, com jogo aberto, escolhe 720p): passa pra 1080p60 uma vez
  if (config.qualidade === 'auto' && !config.migrouQualidade) { config.qualidade = '1080-60-8'; config.migrouQualidade = true; guardarConfig(); }
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
    minWidth: 1100, // trilho 66 + amigos 290 + chat 340 = 696; sobra ≥ 400 pra call
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
  janelaPrincipal.on('focus', () => { janelaPrincipal.flashFrame(false); atualizarSobreposicao(); });
  janelaPrincipal.on('blur', atualizarSobreposicao);

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
  if (!Notification.isSupported() || INVISIVEL) return;
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
 * é liga/desliga. "Segurar pra falar" de verdade é o ajudante nativo
 * teclas.exe, mais abaixo (PTT GLOBAL).
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
  ligarVigiaGpu();
  ligarPtt();

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
  if (motivo !== 'trocou') desligarVigiaGpu();
  priorizarCaptura(false);
  prioridadeGpu(false);
  desligarPtt();
  desligarSomDoApp();
  somDoAppPedido = 0;
  genteNaCall = [];
  atualizarSobreposicao();
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
        md.getDisplayMedia = async function(c){
          c = Object.assign({}, c || {});
          var queriaAudio = !!c.audio;
          if (c.audio) c.audio = Object.assign({}, c.audio === true ? {} : c.audio, { restrictOwnAudio: true });
          var stream = await gdmOriginal(c);
          // SOM DE UM APP SÓ (escolhido na tela de Transmitir): o app captura
          // o processo do jogo por fora (WASAPI por processo) e manda o PCM
          // pra cá; a faixa que vai pros amigos é a nossa, não o loopback
          try {
            var pid = queriaAudio ? await window.bigasApp.somDoApp() : 0;
            if (pid && window.__bigasSomDoApp) {
              var faixa = await window.__bigasSomDoApp.ligar();
              stream.getAudioTracks().forEach(function(t){ stream.removeTrack(t); t.stop(); });
              stream.addTrack(faixa);
            }
          } catch(e){ console.warn('som do app', e); }
          return stream;
        };
      } catch(e){}
      ${SCRIPT_SOM_DO_APP}
      ${scriptRnnoise()}

      // os textos de estado do site falam em "link", "aba", "modo manual" —
      // aqui dentro nada disso existe. Traduz na saída, sem mexer no site.
      var outro = ${JSON.stringify(outroNick || '')} || 'seu amigo';
      var canal = outro.charAt(0) === '#'; // canal de voz de um grupo: sala fixa, ninguém está sendo chamado
      var dizerOriginal = window.dizerSala;
      if (typeof dizerOriginal === 'function') {
        window.dizerSala = function(t){
          t = String(t == null ? '' : t);
          if (canal) t = t
            .replace('ninguém aqui ainda — pode deixar esta aba aberta', 'só você no canal por enquanto — quem entrar aparece aqui')
            .replace('procurando quem já está na call…', 'entrando no canal ' + outro + '…')
            .replace('entrando na sala…', 'entrando no canal ' + outro + '…');
          else t = t
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

      // o amplificador do site (volume acima de 100%, "cada voz num lugar")
      // toca por um AudioContext — que ignora o setSinkId dos <audio>. Todo
      // AudioContext que o site criar nasce apontando pra saída escolhida.
      try {
        var AC = window.AudioContext;
        var ACnovo = function(o){ var c = new AC(o); try { if (window.__bigasSaida && c.setSinkId) c.setSinkId(window.__bigasSaida).catch(function(){}); } catch(e){} return c; };
        ACnovo.prototype = AC.prototype;
        window.AudioContext = ACnovo;
      } catch(e){}

      // QUEM ASSISTE PEDE A RESOLUÇÃO CHEIA. O site pede ao amigo uma imagem
      // do tamanho da janela onde o vídeo está — e no app o palco tem ~900 px,
      // então o amigo mandava 960x540 mesmo transmitindo em 1080p (medido:
      // "janela dele (1280px) 1.5x"). Aqui você pode dar tela cheia a qualquer
      // momento, então o app pede sempre o tamanho do MONITOR.
      try {
        var avisarOriginal = window.avisarTamanho;
        if (typeof avisarOriginal === 'function') {
          window.avisarTamanho = function(par){
            if (!par || typeof canalDe !== 'function' || !canalDe(par)) return;
            var l = Math.round((screen.width || 1920) * (window.devicePixelRatio || 1));
            var degrau = l <= 1400 ? 1280 : l <= 1700 ? 1600 : l <= 2000 ? 1920 : l <= 2800 ? 2560 : 3840;
            if (par.avisei === degrau) return;
            par.avisei = degrau;
            enviar(par, { t: 'quero', v: degrau });
          };
        }
      } catch(e){}

      // as preferências do app (voz, mic, saída, volume, qualidade…) valem aqui
      ${scriptPreferencias()}

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
        // canal de voz de grupo: estar na sala já é "estar no canal", mesmo sozinho
        if (canal) {
          var vs = setInterval(function(){
            if (avisado) { clearInterval(vs); return; }
            if (typeof sala !== 'undefined' && sala.ligada) {
              avisado = true; clearInterval(vs);
              // mostra a tela da call já (com o botão de transmitir): num canal
              // você pode transmitir sozinho, quem entrar depois entra vendo
              try { if (typeof entrarNaChamada === 'function') entrarNaChamada(); } catch(e){}
              window.bigasApp.avisar('conectada');
            }
          }, 500);
        }
      }
      // enquanto transmite, conta pro app quantos quadros a captura entrega
      // (mediana que o próprio site mede) — o app cruza com a placa de vídeo
      setInterval(function(){
        try {
          if (typeof est === 'undefined' || !est.streamTela) { window.bigasApp.avisar('fonte:-'); return; }
          var H = est.histFonte || [];
          if (H.length < 8) { window.bigasApp.avisar('fonte:?'); return; }
          var o = H.slice(-10).sort(function(a, b){ return a - b; });
          var alvo = (est.streamTela.getVideoTracks()[0] || {}).getSettings ? (est.streamTela.getVideoTracks()[0].getSettings().frameRate || 0) : 0;
          window.bigasApp.avisar('fonte:' + o[Math.floor(o.length / 2)] + '/' + Math.round(alvo));
        } catch(e){}
      }, 5000);

      // ping e "reconectando" pro painel da casa (a cada 2 s), e QUEM ESTÁ
      // FALANDO pra sobreposição por cima do jogo (só quando muda)
      var genteAntes = '';
      setInterval(function(){
        try {
          if (typeof pares === 'undefined' || typeof est === 'undefined') return;
          var ps = [...pares.values()].filter(function(p){ return p.conectado; });
          var pior = 0, religando = false;
          ps.forEach(function(p){ if (p.ping > pior) pior = p.ping; if (p.religando) religando = true; });
          window.bigasApp.avisar('rede:' + (religando ? 1 : 0) + ':' + Math.round(pior));
        } catch(e){}
      }, 2000);
      setInterval(function(){
        try {
          if (typeof pares === 'undefined' || typeof est === 'undefined') return;
          var ch = document.getElementById('chamada');
          var gente = (!ch || ch.hidden) ? [] : [{ nome: (typeof eu !== 'undefined' && eu.nome) || 'Você', eu: true, falando: !!(est.falandoAntes || est.segurando), mudo: !!est.mudo }]
            .concat([...pares.values()].filter(function(p){ return p.conectado; }).map(function(p){ return { nome: p.nome || '…', falando: !!p.falando, mudo: !!p.mudo, tela: !!p.temTela }; }));
          var txt = JSON.stringify(gente);
          if (txt !== genteAntes) { genteAntes = txt; window.bigasApp.avisar('gente:' + txt); }
        } catch(e){}
      }, 250);

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

/* as preferências do app (voz, mic, saída, volume, qualidade, compressão)
   empurradas pra dentro do site. Idempotente: roda na primeira carga e de
   novo quando a pessoa muda algo nos Ajustes durante a call. Mic e saída
   são achados pelo NOME (o id de dispositivo muda de site pra site). */
function scriptPreferencias(){
  const pref = JSON.stringify({
    fala: config.fala, tecla: config.teclaPtt, nomeTecla: config.nomeTeclaPtt,
    limpar: !!config.limpar, volume: config.volume, qualidade: config.qualidade,
    codec: config.codec, micRotulo: config.micRotulo, saidaRotulo: config.saidaRotulo,
    nitidezExtra: !!config.nitidezExtra, ruidoForte: !!config.ruidoForte,
  });
  return `
    (function(){
      try {
        var pref = ${pref};
        if (typeof cfg === 'object') {
          cfg.fala = pref.fala === 'ptt' ? 'ptt' : 'voz';
          if (pref.tecla) { cfg.tecla = pref.tecla; cfg.nomeTecla = pref.nomeTecla || pref.tecla; }
          cfg.limpar = pref.limpar;
          cfg.volume = Math.max(0, Math.min(200, Number(pref.volume) || 100));
          cfg.qualidade = pref.qualidade || 'auto';
          cfg.codec = pref.codec || 'auto';
          if (cfg.nitidezExtra !== pref.nitidezExtra) {
            cfg.nitidezExtra = pref.nitidezExtra;
            // já transmitindo: o site reaplica o perfil nos amigos
            if (typeof pares !== 'undefined' && typeof reequilibrarVideo === 'function') { pares.forEach(function(x){ x.perfilAplicado = null; }); reequilibrarVideo(); }
          }
          var sn = document.getElementById('in-nitidez'); if (sn) sn.checked = !!cfg.nitidezExtra;
          // ruído forte mudou no meio da call: pega o microfone de novo (pelo
          // nosso embrulho do getUserMedia) e troca a faixa em cada conexão
          if (window.__bigasRnnoise && window.__bigasRnnoise.querido !== pref.ruidoForte) {
            window.__bigasRnnoise.querido = pref.ruidoForte;
            if (typeof est !== 'undefined' && est.streamMic && typeof ligarMicrofone === 'function') {
              (async function(){
                try {
                  var nova = await ligarMicrofone(true);
                  if (typeof aplicarMudo === 'function') aplicarMudo();
                  for (var par of pares.values()) { if (par.senderMic) { try { await par.senderMic.replaceTrack(nova); } catch(e){} } }
                } catch(e){ console.warn('trocar mic (ruído)', e); }
              })();
            }
          }
          if (typeof guardarAjustes === 'function') guardarAjustes();
          if (typeof aplicarModoFala === 'function') try { aplicarModoFala(); } catch(e){}
          if (typeof aplicarVolume === 'function') try { aplicarVolume(); } catch(e){}
          var sq = document.getElementById('sel-qualidade'); if (sq) sq.value = cfg.qualidade;
          var sc = document.getElementById('sel-codec'); if (sc) sc.value = cfg.codec;
          var sf = document.getElementById('sel-fala'); if (sf) sf.value = cfg.fala;
          var sr = document.getElementById('in-ruido'); if (sr) sr.checked = cfg.limpar;
        }
        var aplicarSaida = function(el){
          if (!el || typeof el.setSinkId !== 'function') return;
          el.setSinkId(window.__bigasSaida || '').catch(function(){});
        };
        // todo <audio> que o site criar (a voz de cada pessoa) sai pelo aparelho escolhido
        if (!window.__bigasObsSaida) {
          window.__bigasObsSaida = new MutationObserver(function(ms){
            ms.forEach(function(m){ m.addedNodes.forEach(function(n){ if (n && n.tagName === 'AUDIO') aplicarSaida(n); }); });
          });
          window.__bigasObsSaida.observe(document.body, { childList: true, subtree: true });
        }
        navigator.mediaDevices.enumerateDevices().then(function(ds){
          var mic = pref.micRotulo && ds.find(function(d){ return d.kind === 'audioinput' && d.label === pref.micRotulo; });
          var micId = mic ? mic.deviceId : 'padrao';
          if (typeof cfg === 'object' && cfg.mic !== micId) {
            cfg.mic = micId; if (typeof guardarAjustes === 'function') guardarAjustes();
            // já na call com o mic aberto: troca na hora (o site já faz isso no onchange)
            var sm = document.getElementById('sel-mic');
            if (sm && typeof est !== 'undefined' && est.streamMic) {
              var op = document.createElement('option'); op.value = micId; sm.appendChild(op); sm.value = micId;
              sm.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          var sai = pref.saidaRotulo && ds.find(function(d){ return d.kind === 'audiooutput' && d.label === pref.saidaRotulo; });
          window.__bigasSaida = sai ? sai.deviceId : '';
          document.querySelectorAll('audio').forEach(aplicarSaida);
          try { if (typeof est !== 'undefined' && est.ctx && est.ctx.setSinkId) est.ctx.setSinkId(window.__bigasSaida || '').catch(function(){}); } catch(e){}
        }).catch(function(){});
      } catch(e){ console.warn('preferências do app', e); }
    })();
  `;
}

/* depois que a captura existe no site, aplica o perfil escolhido na tela de
   Transmitir (o site reaplica os limites na faixa e avisa os outros) e corta
   o som da tela se a pessoa desligou */
function aplicarNaTransmissao(qualidade, som){
  if (!viewCall) return;
  viewCall.webContents.executeJavaScript(`
    (async function(){
      for (var i = 0; i < 40; i++) {
        if (typeof est !== 'undefined' && est.streamTela) break;
        await new Promise(function(r){ setTimeout(r, 250); });
      }
      if (typeof est === 'undefined' || !est.streamTela) return 'sem captura';
      try {
        var q = ${JSON.stringify(String(qualidade || 'auto'))};
        var sel = document.getElementById('sel-qualidade');
        if (sel && typeof cfg === 'object' && cfg.qualidade !== q) {
          sel.value = q;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (${som ? 'false' : 'true'} && !est.somDaTelaCortado && typeof alternarSomDaTela === 'function') alternarSomDaTela();
      } catch(e){ return 'erro ' + e.message; }
      return 'ok';
    })()
  `).then((r) => { if (r !== 'ok') console.warn('aplicar na transmissão:', r); }).catch(() => {});
}

/* ---------------------------------------------------------------------
 * VIGIA DA PLACA DE VÍDEO (durante a call)
 * ---------------------------------------------------------------------
 * Medido no PC do André: com o jogo usando 97% da placa a captura entrega
 * ~22 de 60 quadros; com teto de FPS no jogo (placa a 37%) entrega ~43.
 * Nenhum método de captura muda isso — folga na placa muda. Então o app
 * mede a placa (um PowerShell só, contínuo, a cada 5 s) e avisa UMA vez
 * por call quando ela passa de 90% enquanto a pessoa transmite.
 * ------------------------------------------------------------------ */
let vigiaGpu = null;
let gpuAgora = null;          // último uso da placa medido (0–100)
let diag = { presos: 0, avisouExclusivo: false, avisouPlaca: false };

/* cruza "quantos quadros a captura entrega" com "quanto a placa está
   ocupada": placa folgada + captura presa em poucos quadros = jogo em tela
   cheia EXCLUSIVA (passa por fora do compositor). Avisa uma vez por call. */
function diagnosticarCaptura(txt){
  if (txt === '-') { diag.presos = 0; return; }   // não está transmitindo
  const [f, alvo] = txt.split('/').map(Number);
  if (!Number.isFinite(f) || !Number.isFinite(alvo) || alvo < 20) return;
  const presa = f < Math.min(15, alvo * 0.35);
  diag.presos = presa ? diag.presos + 1 : 0;
  if (diag.presos >= 3 && !diag.avisouExclusivo && gpuAgora !== null && gpuAgora < 70) {
    diag.avisouExclusivo = true;
    avisarHome('call:gpu', { gpu: gpuAgora, exclusivo: true, fonte: f });
  }
}
function ligarVigiaGpu(){
  if (vigiaGpu || process.platform !== 'win32') return;
  const script = "Get-Counter -Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -SampleInterval 5 -Continuous -ErrorAction SilentlyContinue | ForEach-Object { $t = 0; $_.CounterSamples | ForEach-Object { $t += $_.CookedValue }; [Console]::Out.WriteLine([int]$t); [Console]::Out.Flush() }";
  try{
    vigiaGpu = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  }catch(e){ vigiaGpu = null; return; }
  let seguidas = 0, avisou = false, resto = '';
  vigiaGpu.stdout.on('data', (buf) => {
    resto += String(buf);
    const linhas = resto.split(/\r?\n/); resto = linhas.pop();
    for (const l of linhas) {
      const v = parseInt(l, 10);
      if (!Number.isFinite(v)) continue;
      gpuAgora = Math.min(100, v);
      avisarHome('call:gpu', { gpu: gpuAgora });
      seguidas = v >= 90 ? seguidas + 1 : 0;
      if (seguidas >= 2 && !avisou) { avisou = true; avisarHome('call:gpu', { gpu: gpuAgora, aviso: true }); }
    }
  });
  vigiaGpu.on('exit', () => { vigiaGpu = null; });
}
function desligarVigiaGpu(){
  gpuAgora = null; diag = { presos: 0, avisouExclusivo: false, avisouPlaca: false };
  if (!vigiaGpu) return;
  try { vigiaGpu.kill(); } catch {}
  vigiaGpu = null;
}

/* ---------------------------------------------------------------------
 * PRIORIDADE DOS PROCESSOS DE CAPTURA (durante a call)
 * ---------------------------------------------------------------------
 * Quando o jogo também come processador, a captura perde a vez na fila.
 * Sobe pra "acima do normal" os processos do app que carregam a
 * transmissão (GPU, captura de vídeo, a página da call) enquanto a call
 * existe, e devolve pro normal ao sair. Sem admin; só nos nossos processos.
 * ------------------------------------------------------------------ */
let pidsPriorizados = [];
function priorizarCaptura(ligar){
  if (process.platform !== 'win32') return;
  if (!ligar) {
    for (const pid of pidsPriorizados) { try { os.setPriority(pid, os.constants.priority.PRIORITY_NORMAL); } catch {} }
    pidsPriorizados = [];
    return;
  }
  if (!config.prioridadeCaptura) return;
  try{
    for (const m of app.getAppMetrics()) {
      const alvo = m.type === 'GPU' || (m.type === 'Utility' && /Video Capture|Audio/i.test(m.name || '')) || m.type === 'Tab';
      if (!alvo) continue;
      try { os.setPriority(m.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); pidsPriorizados.push(m.pid); } catch {}
    }
  }catch(e){ console.warn('prioridade', e); }
}

/* ---------------------------------------------------------------------
 * PRIORIDADE DE GPU (durante a call) — o truque do OBS
 * ---------------------------------------------------------------------
 * Com o jogo usando 97% da placa, a captura pega as sobras (~22 de 60).
 * A prioridade de CPU não muda isso (medido). O que muda é a fila da
 * PLACA: `D3DKMTSetProcessSchedulingPriorityClass` sobe a classe de
 * agendamento de GPU dos NOSSOS processos (GPU, captura, a página da
 * call) — o mesmo que o OBS faz consigo. Chromium não expõe isso; um
 * ajudante nativo minúsculo (nativo/gpuprio.c) faz a chamada. Nunca toca
 * no jogo nem injeta nada.
 * ------------------------------------------------------------------ */
function caminhoGpuprio(){ return caminhoAjudante('gpuprio.exe'); }
let pidsGpu = [];
function prioridadeGpu(ligar){
  if (process.platform !== 'win32') return;
  const exe = caminhoGpuprio();
  if (!exe) return;
  const aplicar = (pid, classe) => new Promise((r) => execFile(exe, [String(pid), String(classe)], { windowsHide: true, timeout: 4000 }, (e, out) => r(e ? '' : String(out || '').trim())));
  if (!ligar) {
    const antigos = pidsGpu; pidsGpu = [];
    antigos.forEach((pid) => aplicar(pid, 2));
    return;
  }
  if (!config.prioridadeGpu) return;
  try{
    for (const m of app.getAppMetrics()) {
      const alvo = m.type === 'GPU' || m.type === 'Browser' || m.type === 'Tab' || (m.type === 'Utility' && /Video Capture|Audio/i.test(m.name || ''));
      if (!alvo || pidsGpu.includes(m.pid)) continue;
      pidsGpu.push(m.pid);
      aplicar(m.pid, 5).then((r) => { if (r) console.log('gpuprio', m.type, m.name || '', r); });
    }
  }catch(e){ console.warn('prioridade gpu', e); }
}

/* ---------------------------------------------------------------------
 * AJUDANTES NATIVOS (nativo/*.c, *.cpp — compilados em nativo/*.exe e
 * empacotados em resources/). Nenhum injeta nada em jogo nenhum.
 * ------------------------------------------------------------------ */
function caminhoAjudante(nome){
  const empacotado = path.join(process.resourcesPath || '', nome);
  if (app.isPackaged && fs.existsSync(empacotado)) return empacotado;
  const dev = path.join(__dirname, 'nativo', nome);
  return fs.existsSync(dev) ? dev : null;
}
const rodar = (exe, args, ms) => new Promise((r) => execFile(exe, args, { windowsHide: true, timeout: ms || 4000, maxBuffer: 1 << 20 }, (e, out) => r(e ? '' : String(out || ''))));

/* ---------------------------------------------------------------------
 * PTT GLOBAL — "segurar pra falar" com o jogo na frente
 * ---------------------------------------------------------------------
 * O site só vê a tecla com a janela em foco. O ajudante teclas.exe fica
 * perguntando ao Windows (GetAsyncKeyState, a cada 8 ms) se a tecla está
 * apertada e avisa "1"/"0"; o app chama segurarFala() no site. Sem gancho
 * de teclado, sem ler o que você digita — só aquela tecla. Serve também
 * pros botões laterais do mouse.
 * ------------------------------------------------------------------ */
const VK = {
  Space: 0x20, Tab: 0x09, CapsLock: 0x14, Enter: 0x0D, NumpadEnter: 0x0D, Backspace: 0x08, Escape: 0x1B,
  ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3, AltLeft: 0xA4, AltRight: 0xA5,
  Backquote: 0xC0, Minus: 0xBD, Equal: 0xBB, BracketLeft: 0xDB, BracketRight: 0xDD, Backslash: 0xDC,
  Semicolon: 0xBA, Quote: 0xDE, Comma: 0xBC, Period: 0xBE, Slash: 0xBF, IntlBackslash: 0xE2,
  Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadDecimal: 0x6E, NumpadDivide: 0x6F,
  ScrollLock: 0x91, Pause: 0x13, ContextMenu: 0x5D,
  Mouse1: 0x04, Mouse3: 0x05, Mouse4: 0x06, // botão do meio, lateral 1, lateral 2
};
function vkDe(code){
  code = String(code || '');
  if (VK[code]) return VK[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
  if ((m = /^Digit(\d)$/.exec(code))) return 0x30 + Number(m[1]);
  if ((m = /^Numpad(\d)$/.exec(code))) return 0x60 + Number(m[1]);
  if ((m = /^F(\d{1,2})$/.exec(code))) return 0x6F + Number(m[1]);
  return 0;
}
let ptt = null; // { proc, vk }
function ligarPtt(){
  const vk = config.fala === 'ptt' ? vkDe(config.teclaPtt) : 0;
  if (!viewCall || !vk || process.platform !== 'win32') { desligarPtt(); return; }
  if (ptt && ptt.proc.exitCode === null) {
    if (ptt.vk !== vk) { ptt.vk = vk; try { ptt.proc.stdin.write('vk ' + vk + '\n'); } catch {} }
    return;
  }
  const exe = caminhoAjudante('teclas.exe');
  if (!exe) return;
  let proc;
  try { proc = spawn(exe, [String(vk)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (e) { console.warn('ptt', e); return; }
  ptt = { proc, vk };
  let resto = '';
  proc.stdout.on('data', (b) => {
    resto += String(b);
    const ls = resto.split(/\r?\n/); resto = ls.pop();
    for (const l of ls) if (l === '1' || l === '0') segurarFalaNaCall(l === '1');
  });
  proc.on('exit', () => { if (ptt && ptt.proc === proc) ptt = null; });
}
function desligarPtt(){
  if (!ptt) return;
  const p = ptt; ptt = null;
  try { p.proc.stdin.write('sai\n'); } catch {}
  setTimeout(() => { try { p.proc.kill(); } catch {} }, 300);
}
function segurarFalaNaCall(ligado){
  if (!viewCall) return;
  viewCall.webContents.executeJavaScript('try{ segurarFala(' + (ligado ? 'true' : 'false') + '); }catch(e){} true').catch(() => {});
}

/* ---------------------------------------------------------------------
 * SOM DE UM APP SÓ — loopback por processo (somdoapp.exe)
 * ---------------------------------------------------------------------
 * A captura "som da tela" do Chromium pega a saída PADRÃO inteira. Se o
 * jogo toca no fone e o padrão é a caixa, o amigo não ouve nada; e o
 * Spotify/notificação vão junto. O ajudante pede ao Windows o áudio de
 * UM processo (e filhos), em qualquer saída, como float32 48 kHz; o
 * main repassa o PCM pra página, que vira uma faixa de áudio (worklet)
 * e a manda no lugar do loopback.
 * ------------------------------------------------------------------ */
let somDoApp = null;      // { proc, pid } enquanto captura
let somDoAppPedido = 0;   // pid escolhido na tela de Transmitir, pra PRÓXIMA captura
let somDoAppNome = '';    // o exe daquele pid (só pro diagnóstico)
let ultimaFonte = '-';    // último "fonte:" que a view mandou (pra ver a transmissão PARAR)
async function listarAppsComSom(){
  const exe = caminhoAjudante('somdoapp.exe');
  if (!exe) return [];
  const out = await rodar(exe, ['lista'], 3000);
  const meus = new Set(app.getAppMetrics().map((m) => m.pid));
  return out.split(/\r?\n/).map((l) => l.split('\t')).filter((c) => c.length >= 4 && /^\d+$/.test(c[0]))
    .map((c) => ({ pid: Number(c[0]), exe: c[1], titulo: c[2], tocando: c[3] === '1' }))
    .filter((a) => !meus.has(a.pid) && !/^(electron|Bigas Voice)\.exe$/i.test(a.exe))
    .sort((a, b) => (b.tocando - a.tocando) || a.exe.localeCompare(b.exe));
}
// id de fonte "window:<hwnd>:0" → pid dono da janela, todas numa chamada só
async function pidsDasJanelas(ids){
  const exe = caminhoAjudante('somdoapp.exe');
  const hwndDe = (id) => (/^window:(\d+):/.exec(String(id || '')) || [])[1];
  const hwnds = ids.map(hwndDe).filter(Boolean);
  const mapa = {};
  if (!exe || !hwnds.length) return mapa;
  const out = await rodar(exe, ['janelas', hwnds.join(',')], 3000);
  const porHwnd = {};
  out.split(/\r?\n/).forEach((l) => { const [h, pid] = l.split('\t'); if (h && Number(pid)) porHwnd[h] = Number(pid); });
  ids.forEach((id) => { const h = hwndDe(id); if (h && porHwnd[h]) mapa[id] = porHwnd[h]; });
  return mapa;
}
function ligarSomDoApp(pid){
  desligarSomDoApp();
  const exe = caminhoAjudante('somdoapp.exe');
  if (!exe || !viewCall || !pid) return false;
  let proc;
  try { proc = spawn(exe, [String(pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { console.warn('somdoapp', e); return false; }
  const v = viewCall;
  somDoApp = { proc, pid, desde: Date.now(), bytes: 0, nivel: 0, pico: 0 };
  let sobra = Buffer.alloc(0);
  proc.stdout.on('data', (b) => {
    if (viewCall !== v || !somDoApp || somDoApp.proc !== proc) return;
    // manda só amostras inteiras (8 bytes = um par esquerda/direita)
    let todo = sobra.length ? Buffer.concat([sobra, b]) : b;
    if (todo.length < 7680) { sobra = todo; return; }   // junta pelo menos 20 ms por mensagem
    const corte = todo.length - (todo.length % 8);
    sobra = todo.subarray(corte);
    if (!corte) return;
    // nível do que o Windows entrega (pro diagnóstico saber se o app escolhido está mudo)
    try {
      const f = new Float32Array(todo.buffer, todo.byteOffset, corte / 4);
      let soma = 0, pico = 0; for (let i = 0; i < f.length; i += 4) { const x = Math.abs(f[i]); soma += x * x; if (x > pico) pico = x; }
      const rms = Math.sqrt(soma / Math.max(1, f.length / 4));
      somDoApp.nivel = somDoApp.nivel * 0.9 + rms * 0.1; if (pico > somDoApp.pico) somDoApp.pico = pico; somDoApp.bytes += corte;
    } catch {}
    try { v.webContents.send('som:pcm', todo.subarray(0, corte)); } catch {}
  });
  proc.stderr.on('data', (b) => { const t = String(b).trim(); if (t && t !== 'pronto') console.warn('somdoapp', t); });
  proc.on('exit', () => { if (somDoApp && somDoApp.proc === proc) { somDoApp = null; avisarHome('call:somDoApp', { estado: 'parou' }); } });
  console.log('som do app: capturando pid', pid);
  return true;
}
function desligarSomDoApp(){
  if (!somDoApp) return;
  const p = somDoApp; somDoApp = null;
  try { p.proc.stdin.write('sai\n'); } catch {}
  setTimeout(() => { try { p.proc.kill(); } catch {} }, 300);
}
// dentro da página: o PCM vira uma faixa de áudio pelo AudioWorklet
const SCRIPT_SOM_DO_APP = `
      (function(){
        if (window.__bigasSomDoApp) return;
        var CODIGO_FILA = ${JSON.stringify(`
          class Fila extends AudioWorkletProcessor {
            // fila com folga: alvo de 150 ms, corta só acima de 600 ms. O PCM chega pela
            // página (que às vezes engasga 50–100 ms); com 40 ms de fila o som picotava.
            constructor(){ super(); this.cap = 48000 * 2 * 2; this.ALVO = 48000 * 2 * 0.15; this.MAX = 48000 * 2 * 0.6; this.buf = new Float32Array(this.cap); this.ini = 0; this.n = 0; this.pronto = false;
              this.port.onmessage = (e) => this.encher(e.data); }
            encher(f){
              if (this.n + f.length > this.cap) { var sobra = this.n + f.length - this.cap; this.ini = (this.ini + sobra) % this.cap; this.n -= sobra; }
              var fim = (this.ini + this.n) % this.cap;
              var primeira = Math.min(f.length, this.cap - fim);
              this.buf.set(f.subarray(0, primeira), fim);
              if (primeira < f.length) this.buf.set(f.subarray(primeira), 0);
              this.n += f.length;
            }
            process(inputs, outputs){
              var o = outputs[0], L = o[0], R = o[1] || o[0], cap = this.cap;
              // atrasou demais: pula pro alvo — o som do jogo tem que andar perto da imagem
              if (this.n > this.MAX) { this.ini = (this.ini + (this.n - this.ALVO)) % cap; this.n = this.ALVO; }
              if (!this.pronto && this.n >= this.ALVO) this.pronto = true;
              for (var i = 0; i < L.length; i++) {
                if (this.pronto && this.n >= 2) { L[i] = this.buf[this.ini]; R[i] = this.buf[(this.ini + 1) % cap]; this.ini = (this.ini + 2) % cap; this.n -= 2; }
                else { L[i] = 0; R[i] = 0; if (this.n < 2) this.pronto = false; }
              }
              return true;
            }
          }
          registerProcessor('bigas-fila', Fila);
        `)};
        var s = { ctx: null, node: null, ativo: false };
        s.ligar = async function(){
          if (!s.ctx) {
            s.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
            await s.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CODIGO_FILA], { type: 'text/javascript' })));
          }
          if (s.ctx.state === 'suspended') await s.ctx.resume();
          if (s.node) { try { s.node.disconnect(); } catch(e){} }
          s.node = new AudioWorkletNode(s.ctx, 'bigas-fila', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          var dest = s.ctx.createMediaStreamDestination();
          s.node.connect(dest);
          s.ativo = true;
          return dest.stream.getAudioTracks()[0];
        };
        s.recebidos = 0; s.ultimoPico = 0;
        window.bigasApp.aoReceberSom(function(bytes){
          if (!s.node || !bytes) return;
          try {
            // o navegador põe AudioContext pra dormir de vez em quando — dormindo, a faixa vira silêncio
            if (s.ctx && s.ctx.state === 'suspended') s.ctx.resume().catch(function(){});
            var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            var f = new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength - (u8.byteLength % 4)));
            s.recebidos += f.length;
            var p = 0; for (var i = 0; i < f.length; i += 8) { var x = Math.abs(f[i]); if (x > p) p = x; } s.ultimoPico = p;
            s.node.port.postMessage(f, [f.buffer]);
          } catch(e){}
        });
        window.__bigasSomDoApp = s;
      })();
`;

/* ---------------------------------------------------------------------
 * RUÍDO FORTE — RNNoise no microfone (por cima do filtro do Chromium)
 * ---------------------------------------------------------------------
 * O filtro do Chromium é fraco contra teclado mecânico e ventilador. O
 * RNNoise (rede neural pequena, mesma família do que o Discord chama de
 * "Krisp") roda num AudioWorklet. Nada sai do PC. A página embrulha o
 * getUserMedia do site: o site pede o microfone, recebe a faixa limpa.
 * O binário (rnnoise.wasm, 110 KB, do jitsi/rnnoise-wasm, Apache-2.0)
 * vai empacotado e é injetado na página como base64 — o site continua
 * um arquivo só, sem depender de nada de fora.
 * ------------------------------------------------------------------ */
function scriptRnnoise(){
  const arq = caminhoAjudante('rnnoise.wasm');
  if (!arq) return '';
  let b64 = '';
  try { b64 = fs.readFileSync(arq).toString('base64'); } catch { return ''; }
  const worklet = `
    class Rnnoise extends AudioWorkletProcessor {
      constructor(){ super(); this.pronto = false; this.ent = new Float32Array(480); this.nEnt = 0; this.sai = []; this.port.onmessage = (e) => this.iniciar(e.data); }
      async iniciar(bytes){
        try {
          var memoria;
          var imports = { a: { a: function(){ return 0; }, b: function(d, s, n){ new Uint8Array(memoria.buffer).copyWithin(d, s, s + n); } } };
          var r = await WebAssembly.instantiate(bytes, imports);
          var ex = r.instance.exports;
          memoria = ex.c; this.ex = ex; if (ex.d) ex.d();
          this.estado = ex.f(); this.ptr = ex.g(480 * 4);
          this.pronto = true; this.port.postMessage('pronto');
        } catch(e){ this.port.postMessage('erro ' + (e && e.message)); }
      }
      process(inputs, outputs){
        var e = inputs[0] && inputs[0][0], o = outputs[0][0];
        if (!e) return true;
        if (!this.pronto) { o.set(e); return true; }
        var ex = this.ex, H = new Float32Array(ex.c.buffer, this.ptr, 480);
        for (var i = 0; i < e.length; i++) {
          this.ent[this.nEnt++] = e[i];
          if (this.nEnt === 480) {
            for (var j = 0; j < 480; j++) H[j] = this.ent[j] * 32768;
            ex.j(this.estado, this.ptr, this.ptr);
            H = new Float32Array(ex.c.buffer, this.ptr, 480);
            var q = new Float32Array(480);
            for (j = 0; j < 480; j++) q[j] = H[j] / 32768;
            this.sai.push(q); this.nEnt = 0;
          }
        }
        // saída com 480 amostras (10 ms) de atraso — o preço de o modelo trabalhar em blocos
        var s = this.sai[0], p = this.posSai || 0;
        for (i = 0; i < o.length; i++) {
          if (!s) { o[i] = 0; continue; }
          o[i] = s[p++];
          if (p === 480) { this.sai.shift(); s = this.sai[0]; p = 0; }
        }
        this.posSai = p;
        return true;
      }
    }
    registerProcessor('bigas-rnnoise', Rnnoise);
  `;
  return `
      (function(){
        if (window.__bigasRnnoise) return;
        var R = { querido: ${config.ruidoForte ? 'true' : 'false'}, bytes: null, ctx: null, url: null, ativo: false };
        R.bytesDe = function(){
          if (R.bytes) return R.bytes;
          var b = atob(${JSON.stringify(b64)}); var u = new Uint8Array(b.length);
          for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
          R.bytes = u.buffer; return R.bytes;
        };
        R.processar = async function(bruto){
          if (!R.ctx) {
            R.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
            R.url = URL.createObjectURL(new Blob([${JSON.stringify(worklet)}], { type: 'text/javascript' }));
            await R.ctx.audioWorklet.addModule(R.url);
          }
          if (R.ctx.state === 'suspended') await R.ctx.resume();
          var fonte = R.ctx.createMediaStreamSource(bruto);
          var node = new AudioWorkletNode(R.ctx, 'bigas-rnnoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          node.port.postMessage(R.bytesDe().slice(0));
          node.port.onmessage = function(e){ if (e.data === 'pronto') R.pronto = true; else console.warn('rnnoise', e.data); };
          var dest = R.ctx.createMediaStreamDestination();
          fonte.connect(node).connect(dest);
          var faixa = dest.stream.getAudioTracks()[0];
          var bruta = bruto.getAudioTracks()[0];
          // o microfone de verdade caiu (desplugado): a faixa limpa cai junto, e o site socorre
          bruta.addEventListener('ended', function(){ try { faixa.stop(); } catch(e){} });
          // o site parou a faixa limpa: solta o microfone de verdade também
          var vigia = setInterval(function(){
            if (faixa.readyState === 'ended') { clearInterval(vigia); try { bruta.stop(); fonte.disconnect(); node.disconnect(); } catch(e){} }
          }, 1000);
          R.ativo = true;
          return dest.stream;
        };
        var md = navigator.mediaDevices;
        var gumOriginal = md.getUserMedia.bind(md);
        md.getUserMedia = async function(c){
          if (!R.querido || !c || !c.audio || c.video) return gumOriginal(c);
          var c2 = Object.assign({}, c);
          // o filtro de ruído do Chromium sai da frente (dois filtros em série distorcem); eco e ganho ficam
          c2.audio = Object.assign({}, c.audio === true ? {} : c.audio, { noiseSuppression: false, channelCount: 1 });
          var bruto = await gumOriginal(c2);
          try { return await R.processar(bruto); }
          catch(e){ console.warn('rnnoise falhou, mic direto', e); return bruto; }
        };
        window.__bigasRnnoise = R;
      })();
  `;
}

/* ---------------------------------------------------------------------
 * SOBREPOSIÇÃO — quem está falando, por cima do jogo
 * ---------------------------------------------------------------------
 * Janelinha transparente, sempre no topo, que ignora o mouse. Só aparece
 * numa call E com outra coisa na frente (o jogo) — por cima do próprio
 * Bigas Voice não faz sentido. Funciona com o jogo em janela sem borda
 * (tela cheia exclusiva passa por fora do compositor — nada aparece).
 * ------------------------------------------------------------------ */
let sobreposicao = null;
let genteNaCall = [];
function criarSobreposicao(){
  if (sobreposicao && !sobreposicao.isDestroyed()) return sobreposicao;
  sobreposicao = new BrowserWindow({
    width: 280, height: 320, show: false, frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    hasShadow: false, title: 'Bigas Voice — sobreposição',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  sobreposicao.setIgnoreMouseEvents(true);
  try { sobreposicao.setAlwaysOnTop(true, 'screen-saver'); } catch {}
  try { sobreposicao.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  sobreposicao.setMenuBarVisibility(false);
  sobreposicao.loadFile('sobreposicao.html');
  sobreposicao.webContents.on('did-finish-load', () => mandarGente());
  sobreposicao.on('closed', () => { sobreposicao = null; });
  return sobreposicao;
}
function posicionarSobreposicao(){
  if (!sobreposicao || sobreposicao.isDestroyed()) return;
  const a = screen.getPrimaryDisplay().workArea;
  const [w, h] = sobreposicao.getSize();
  const canto = config.cantoSobreposicao || 'esq-cima';
  const x = /dir/.test(canto) ? a.x + a.width - w - 12 : a.x + 12;
  const y = /baixo/.test(canto) ? a.y + a.height - h - 12 : a.y + 12;
  sobreposicao.setPosition(Math.round(x), Math.round(y));
}
function mandarGente(){
  if (!sobreposicao || sobreposicao.isDestroyed()) return;
  try { sobreposicao.webContents.send('sobreposicao:gente', genteNaCall); } catch {}
}
function atualizarSobreposicao(){
  const deve = !!(config.sobrepor && viewCall && genteNaCall.length && janelaPrincipal && !janelaPrincipal.isDestroyed() && !janelaPrincipal.isFocused() && !INVISIVEL);
  if (!deve) { if (sobreposicao && !sobreposicao.isDestroyed() && sobreposicao.isVisible()) sobreposicao.hide(); return; }
  const j = criarSobreposicao();
  posicionarSobreposicao();
  mandarGente();
  if (!j.isVisible()) j.showInactive();
}

/* ---------------------------------------------------------------------
 * "JOGANDO X" — um jogo conhecido aberto vira estado pros amigos
 * ---------------------------------------------------------------------
 * Lista de processos do Windows (tasklist, barato) a cada 45 s, cruzada
 * com uma lista de executáveis de jogos. Nada é enviado além do nome.
 * ------------------------------------------------------------------ */
const JOGOS = {
  'TslGame.exe': 'PUBG', 'cs2.exe': 'Counter-Strike 2', 'csgo.exe': 'CS:GO', 'VALORANT-Win64-Shipping.exe': 'VALORANT',
  'FortniteClient-Win64-Shipping.exe': 'Fortnite', 'r5apex.exe': 'Apex Legends', 'r5apex_dx12.exe': 'Apex Legends',
  'GTA5.exe': 'GTA V', 'GTA5_Enhanced.exe': 'GTA V', 'RobloxPlayerBeta.exe': 'Roblox', 'League of Legends.exe': 'League of Legends',
  'Overwatch.exe': 'Overwatch 2', 'RainbowSix.exe': 'Rainbow Six Siege', 'RainbowSix_DX11.exe': 'Rainbow Six Siege', 'RocketLeague.exe': 'Rocket League',
  'dota2.exe': 'Dota 2', 'EscapeFromTarkov.exe': 'Escape from Tarkov', 'Warframe.x64.exe': 'Warframe', 'eldenring.exe': 'Elden Ring',
  'Cyberpunk2077.exe': 'Cyberpunk 2077', 'HuntGame.exe': 'Hunt: Showdown', 'DeadByDaylight-Win64-Shipping.exe': 'Dead by Daylight',
  'Discovery.exe': 'The Finals', 'TheFinals.exe': 'The Finals', 'Marvel-Win64-Shipping.exe': 'Marvel Rivals', 'project8.exe': 'Deadlock',
  'Palworld-Win64-Shipping.exe': 'Palworld', 'HD2.exe': 'Helldivers 2', 'helldivers2.exe': 'Helldivers 2', 'Minecraft.Windows.exe': 'Minecraft',
  'javaw.exe': null, 'FiveM.exe': 'FiveM', 'FiveM_GTAProcess.exe': 'FiveM', 'RDR2.exe': 'Red Dead Redemption 2', 'DeadlockGame.exe': 'Deadlock',
  'BF2042.exe': 'Battlefield 2042', 'bf6.exe': 'Battlefield 6', 'Battlefield 6.exe': 'Battlefield 6', 'ModernWarfare.exe': 'Call of Duty', 'cod.exe': 'Call of Duty',
  'Among Us.exe': 'Among Us', 'Terraria.exe': 'Terraria', 'Stardew Valley.exe': 'Stardew Valley', 'Phasmophobia.exe': 'Phasmophobia',
  'REPO.exe': 'R.E.P.O.', 'Lethal Company.exe': 'Lethal Company', 'Content Warning.exe': 'Content Warning', 'GenshinImpact.exe': 'Genshin Impact',
  'FC25.exe': 'EA FC 25', 'FC26.exe': 'EA FC 26', 'NBA2K25.exe': 'NBA 2K25', 'eFootball.exe': 'eFootball', 'Overwatch2.exe': 'Overwatch 2',
  'Splitgate2.exe': 'Splitgate 2', 'XDefiant.exe': 'XDefiant', 'Squad.exe': 'Squad', 'DayZ_x64.exe': 'DayZ', 'RustClient.exe': 'Rust',
  'arma3_x64.exe': 'Arma 3', 'ArmaReforgerSteam.exe': 'Arma Reforger', 'HaloInfinite.exe': 'Halo Infinite', 'Titanfall2.exe': 'Titanfall 2',
  'SoTGame.exe': 'Sea of Thieves', 'Gunfire Reborn.exe': 'Gunfire Reborn', 'Brawlhalla.exe': 'Brawlhalla', 'SMITE.exe': 'SMITE',
  'FactoryGame-Win64-Shipping.exe': 'Satisfactory', 'Valheim.exe': 'Valheim', 'Enshrouded.exe': 'Enshrouded', 'Wow.exe': 'World of Warcraft',
  'Diablo IV.exe': 'Diablo IV', 'PathOfExileSteam.exe': 'Path of Exile', 'PathOfExile.exe': 'Path of Exile', 'PathOfExile2.exe': 'Path of Exile 2',
  'FF14.exe': 'Final Fantasy XIV', 'ffxiv_dx11.exe': 'Final Fantasy XIV', 'Naraka.exe': 'Naraka', 'DeltaForce.exe': 'Delta Force', 'DeltaForceClient-Win64-Shipping.exe': 'Delta Force',
  'ARK.exe': 'ARK', 'ShooterGame.exe': 'ARK', 'SCUM.exe': 'SCUM', 'MonsterHunterWilds.exe': 'Monster Hunter Wilds', 'SpaceMarine2.exe': 'Space Marine 2',
};
let jogoAgora = '';
let vigiaJogo = null;
async function olharJogo(){
  if (process.platform !== 'win32') return;
  let nome = '';
  if (config.mostrarJogo !== false) {
    const out = await rodar('tasklist.exe', ['/fo', 'csv', '/nh'], 8000);
    const abertos = new Set(out.split(/\r?\n/).map((l) => (l.split('","')[0] || '').replace(/^"/, '')).filter(Boolean));
    for (const exe of Object.keys(JOGOS)) if (JOGOS[exe] && abertos.has(exe)) { nome = JOGOS[exe]; break; }
  }
  if (nome !== jogoAgora) { jogoAgora = nome; avisarHome('jogo', { nome }); }
}
function ligarVigiaJogo(){
  if (vigiaJogo) return;
  olharJogo().catch(() => {});
  vigiaJogo = setInterval(() => olharJogo().catch(() => {}), 45 * 1000);
}

/* ---------------------------------------------------------------------
 * DIAGNÓSTICO — um arquivo com tudo que eu precisaria pra entender um
 * "não funciona" de um amigo, sem quarenta mensagens
 * ------------------------------------------------------------------ */
async function gerarDiagnostico(daCasa){
  const L = [];
  const dz = (t) => L.push(t);
  const agora = new Date();
  dz('===== DIAGNÓSTICO DO BIGAS VOICE (app) =====');
  dz('quando: ' + agora.toLocaleString('pt-BR'));
  dz('app: v' + app.getVersion() + ' · Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome);
  dz('windows: ' + os.release() + ' · ' + os.arch() + ' · ' + os.cpus().length + ' núcleos (' + (os.cpus()[0] || {}).model + ') · RAM ' + Math.round(os.totalmem() / 1073741824) + ' GB');
  try{
    const g = await Promise.race([app.getGPUInfo('complete'), new Promise((r) => setTimeout(() => r(null), 4000))]);
    const d = g && g.gpuDevice && g.gpuDevice[0];
    if (d) dz('placa: ' + (d.deviceString || (d.vendorId + ':' + d.deviceId)) + ' · driver ' + (d.driverVersion || '?') + (g.auxAttributes && g.auxAttributes.glRenderer ? ' · ' + g.auxAttributes.glRenderer : ''));
  }catch{}
  try{ dz('monitores: ' + screen.getAllDisplays().map((m) => (m.label || 'monitor') + ' ' + m.size.width + 'x' + m.size.height + '@' + Math.round(m.displayFrequency || 0) + 'Hz ×' + m.scaleFactor + (m.id === screen.getPrimaryDisplay().id ? ' (principal)' : '')).join(' | ')); }catch{}
  try{
    const hags = await rodar('reg.exe', ['query', ['HKLM', 'SYSTEM', 'CurrentControlSet', 'Control', 'GraphicsDrivers'].join('\\'), '/v', 'HwSchMode']);
    const m = /HwSchMode\s+REG_DWORD\s+0x(\d+)/.exec(hags);
    dz('agendamento de GPU acelerado (HAGS): ' + (m ? (m[1] === '2' ? 'ligado' : 'desligado') : 'desconhecido'));
    const jj = await rodar('reg.exe', ['query', ['HKCU', 'Software', 'Microsoft', 'DirectX', 'UserGpuPreferences'].join('\\'), '/v', 'DirectXUserGlobalSettings']);
    dz('otimização pra jogos em janela: ' + (/SwapEffectUpgradeEnable=1/i.test(jj) ? 'ligada' : 'desligada/desconhecida'));
  }catch{}
  dz('jogo aberto: ' + (jogoAgora || 'nenhum conhecido'));
  dz('ajudantes: ' + ['gpuprio.exe', 'teclas.exe', 'somdoapp.exe', 'rnnoise.wasm'].map((n) => n + (caminhoAjudante(n) ? ' ok' : ' FALTA')).join(' · '));
  dz('');
  dz('--- configuração ---');
  dz(JSON.stringify(config));
  dz('');
  dz('--- casa ---');
  dz(JSON.stringify(daCasa || {}));
  dz('');
  dz('--- processos do app ---');
  try{ for (const m of app.getAppMetrics()) dz('  ' + m.type + ' ' + (m.name || '') + ' pid ' + m.pid + ' cpu ' + (m.cpu ? m.cpu.percentCPUUsage.toFixed(1) : '?') + '% mem ' + (m.memory ? Math.round(m.memory.workingSetSize / 1024) + ' MB' : '?')); }catch{}
  dz('placa agora: ' + (gpuAgora === null ? 'sem medição (fora de call)' : gpuAgora + '%') + ' · diag ' + JSON.stringify(diag));
  dz('ptt global: ' + (ptt ? 'rodando (vk ' + ptt.vk + ')' : 'parado') + ' · som do app: ' + (somDoApp ? somDoAppNome + ' pid ' + somDoApp.pid + ' há ' + Math.round((Date.now() - somDoApp.desde) / 1000) + ' s · ' + Math.round(somDoApp.bytes / 1024) + ' KB recebidos do Windows · nível agora ' + (somDoApp.nivel > 0 ? Math.round(20 * Math.log10(somDoApp.nivel)) + ' dB' : 'silêncio') + ' · pico ' + (somDoApp.pico > 0 ? Math.round(20 * Math.log10(somDoApp.pico)) + ' dB' : 'silêncio') : 'não'));
  dz('');
  dz('--- call ---');
  if (viewCall) {
    try{
      const v = await Promise.race([viewCall.webContents.executeJavaScript(`(async function(){
        var sa = window.__bigasSomDoApp; var r = { versao: typeof VERSAO !== 'undefined' ? VERSAO : '?', vestido: !!window.__bigasVestido, rnnoise: !!(window.__bigasRnnoise && window.__bigasRnnoise.ativo), somDoApp: !!(sa && sa.ativo), somDoAppDetalhe: sa && sa.ativo ? { ctx: sa.ctx && sa.ctx.state, amostras: sa.recebidos, ultimoPico: sa.ultimoPico } : null };
        try {
          r.mudo = est.mudo; r.surdo = est.surdo; r.fala = cfg.fala; r.qualidade = cfg.qualidade; r.codec = cfg.codec; r.auto = cfg.auto; r.nitidez = cfg.nitidezExtra;
          r.mic = est.streamMic ? (est.streamMic.getAudioTracks()[0] || {}).label : null;
          var t = est.streamTela && est.streamTela.getVideoTracks()[0];
          r.tela = t ? t.getSettings() : null; r.fonte = (est.histFonte || []).slice(-12);
          r.pares = [...pares.values()].map(function(p){ return { nome: p.nome, conectado: p.conectado, ping: p.ping, perda: p.perda, religando: !!p.religando, estado: p.pc && p.pc.connectionState, ice: p.pc && p.pc.iceConnectionState, tamanho: p.porqueTamanho }; });
        } catch(e){ r.erro = String(e); }
        try { r.relatorio = await Promise.race([montarDiagnostico(), new Promise(function(r){ setTimeout(function(){ r('(demorou)'); }, 3000); })]); } catch(e){ r.relatorio = 'erro ' + e; }
        return JSON.stringify(r);
      })()`), new Promise((r) => setTimeout(() => r(null), 6000))]);
      const o = v ? JSON.parse(v) : null;
      if (o) { const rel = o.relatorio; delete o.relatorio; dz(JSON.stringify(o)); dz(''); dz('--- relatório do site ---'); dz(String(rel || '')); }
      else dz('(a call não respondeu)');
    }catch(e){ dz('erro lendo a call: ' + e.message); }
  } else dz('fora de call');
  dz('');
  dz('--- últimas linhas de log ---');
  registro.forEach((l) => dz(l));
  const texto = L.join('\n');
  const nome = 'bigas-voice-diagnostico-' + agora.toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.txt';
  let caminho = '';
  try{
    caminho = path.join(app.getPath('desktop'), nome);
    fs.writeFileSync(caminho, texto, 'utf8');
  }catch(e){
    try { caminho = path.join(app.getPath('userData'), nome); fs.writeFileSync(caminho, texto, 'utf8'); } catch { caminho = ''; }
  }
  if (!INVISIVEL) { try { clipboard.writeText(texto); } catch {} }
  return { caminho, texto };
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

function reaplicarNaCall(){
  if (!viewCall) return;
  viewCall.webContents.executeJavaScript(scriptPreferencias()).catch(() => {});
  if (config.prioridadeGpu) prioridadeGpu(true); else prioridadeGpu(false);
}

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
  // Ajustes em tela cheia por cima da call: a view some da tela mas a call
  // continua (áudio, vídeo, tudo) — e volta quando os Ajustes fecham
  ipcMain.on('view:visivel', (ev, visivel) => { if (viewCall) { try { viewCall.setVisible(!!visivel); } catch {} } });
  // mudou mic/saída/voz/volume nos Ajustes durante uma call: aplica agora
  ipcMain.on('call:reaplicar', reaplicarNaCall);
  ipcMain.on('call:mic', () => acionarNaCall('mic'));
  ipcMain.on('call:surdo', () => acionarNaCall('surdo'));
  // a página pergunta, logo depois de a captura de tela nascer, se o som
  // vai ser de UM app (escolhido na tela de Transmitir): se sim, liga o
  // ajudante e devolve o pid; a página troca a faixa de áudio pela nossa
  ipcMain.handle('call:somDoApp', (ev) => {
    if (!viewCall || ev.sender !== viewCall.webContents) return 0;
    const pid = somDoAppPedido; somDoAppPedido = 0;
    if (!pid) return 0;
    return ligarSomDoApp(pid) ? pid : 0;
  });
  ipcMain.handle('diagnostico:gerar', async (ev, daCasa) => {
    try { const r = await gerarDiagnostico(daCasa); if (r.caminho && !INVISIVEL) shell.showItemInFolder(r.caminho); return r; }
    catch (e) { console.error('diagnóstico', e); return { caminho: '', texto: '' }; }
  });
  ipcMain.handle('apps:comSom', () => listarAppsComSom());

  // recados de dentro da call (ex.: "conectou de verdade", mic/fone)
  ipcMain.on('call:aviso', (ev, o) => {
    if (!viewCall || ev.sender !== viewCall.webContents) return;
    o = String(o || '');
    if (o === 'conectada') { avisarHome('call:estado', { estado: 'conectada' }); setTimeout(() => { priorizarCaptura(true); prioridadeGpu(true); ligarPtt(); }, 1500); }
    // a captura de tela nasce num processo novo (Video Capture): reaplica quando ela começa
    else if (o.startsWith('fonte:') && o !== 'fonte:-') prioridadeGpu(true);
    else if (o.startsWith('fonte:')) { diagnosticarCaptura(o.slice(6)); if (somDoApp && ultimaFonte !== '-') desligarSomDoApp(); } // PAROU de transmitir: solta o som do app
    if (o.startsWith('fonte:')) ultimaFonte = o.slice(6);
    else if (o.startsWith('controles:')) avisarHome('call:controles', { mudo: o[10] === '1', surdo: o[11] === '1' });
    else if (o.startsWith('rede:')) { const [, r, ms] = o.split(':'); avisarHome('call:rede', { religando: r === '1', ping: Number(ms) || 0 }); }
    else if (o.startsWith('gente:')) { try { genteNaCall = JSON.parse(o.slice(6)); } catch { genteNaCall = []; } avisarHome('call:gente', genteNaCall); mandarGente(); atualizarSobreposicao(); }
  });

  // a casa avisa onde fica o palco (a view da call se encaixa ali)
  ipcMain.on('palco:rect', (ev, r) => {
    if (!janelaPrincipal || janelaPrincipal.isDestroyed() || ev.sender !== janelaPrincipal.webContents) return;
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
    if (!INVISIVEL) janelaPrincipal.flashFrame(!!ligado);
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
    const permitidas = ['bandeja', 'iniciarComWindows', 'atalhoMic', 'atalhoSurdo',
      'micRotulo', 'saidaRotulo', 'fala', 'teclaPtt', 'nomeTeclaPtt', 'limpar', 'volume', 'qualidade', 'codec', 'somDaTela', 'captura', 'prioridadeCaptura', 'prioridadeGpu', 'nitidezExtra',
      'ruidoForte', 'sobrepor', 'cantoSobreposicao', 'mostrarJogo'];
    for (const k of permitidas) if (mudancas && k in mudancas) config[k] = mudancas[k];
    guardarConfig();
    aplicarConfig();
    if (mudancas && ('fala' in mudancas || 'teclaPtt' in mudancas)) ligarPtt();
    // mudou algo que vale dentro da call: aplica agora (a casa também pede, mas o script é idempotente)
    if (viewCall && mudancas && ['micRotulo', 'saidaRotulo', 'fala', 'teclaPtt', 'limpar', 'volume', 'qualidade', 'codec', 'nitidezExtra', 'ruidoForte', 'prioridadeGpu'].some((k) => k in mudancas)) reaplicarNaCall();
    if (mudancas && ('sobrepor' in mudancas || 'cantoSobreposicao' in mudancas)) { posicionarSobreposicao(); atualizarSobreposicao(); }
    if (mudancas && 'mostrarJogo' in mudancas) olharJogo().catch(() => {});
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
  // o site (na call) e as páginas do próprio app (Ajustes testa o mic e a saída)
  const confiavel = (url) => url.startsWith(SITE) || url.startsWith('file://');
  session.defaultSession.setPermissionRequestHandler((webContents, permissao, callback) => {
    callback(permitido.has(permissao) && confiavel(webContents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permissao) => {
    return permitido.has(permissao) && confiavel(webContents ? webContents.getURL() : '');
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
    console.log('seletor: pedido de captura');
    const [fontes, apps] = await Promise.all([
      desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true }),
      listarAppsComSom().catch(() => []),
    ]);
    // nome de verdade de cada monitor ("LG ULTRAGEAR · 1920×1080 · principal")
    const monitores = screen.getAllDisplays();
    const principal = screen.getPrimaryDisplay();
    const nomeDaTela = (f, i) => {
      const m = monitores.find((d) => String(d.id) === String(f.display_id));
      if (!m) return 'Tela ' + (i + 1);
      return (m.label || ('Tela ' + (i + 1))) + ' · ' + m.size.width + '×' + m.size.height + (m.id === principal.id ? ' · principal' : '');
    };

    let nTela = 0;
    const lista = fontes.filter(f => f.id.startsWith('screen:') || !/^(Bigas Voice|Escolha o que compartilhar|Transmitir — Bigas Voice)/.test(f.name || '')).map(f => ({
      id: f.id,
      nome: f.id.startsWith('screen:') ? nomeDaTela(f, nTela++) : f.name,
      miniatura: f.thumbnail.toDataURL(),
      icone: f.appIcon && !f.appIcon.isEmpty() ? f.appIcon.toDataURL() : '',
      ehTela: f.id.startsWith('screen:'),
    }));
    // janela → pid (pra pré-escolher "som só desse app" quando a janela escolhida tem som)
    const pidsJanela = apps.length ? await pidsDasJanelas(lista.filter((f) => !f.ehTela).map((f) => f.id)) : {};

    console.log('seletor: fontes', fontes.length, 'apps', apps.length, 'janelas', Object.keys(pidsJanela).length);
    const janelaSeletor = new BrowserWindow({
      width: 1040,
      height: 740,
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

    // (as janelas do próprio app não entram na lista: compartilhar o Bigas
    // Voice dentro do Bigas Voice só faria espelho de espelho)

    let respondido = false;
    const aoEscolher = (ev, escolha) => responder(escolha);
    const responder = (escolha) => {
      if(respondido) return;
      respondido = true;
      const escolhaId = escolha && typeof escolha === 'object' ? escolha.id : escolha;
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
          // som de UM app: a página pergunta (call:somDoApp) assim que a captura nascer
          somDoAppPedido = (escolha && typeof escolha === 'object' && escolha.som !== false && Number(escolha.somDe) > 0) ? Number(escolha.somDe) : 0;
          somDoAppNome = somDoAppPedido ? ((apps.find((a) => a.pid === somDoAppPedido) || {}).exe || '?') : '';
          callback({ video: escolhida, audio: 'loopback' });
          // qualidade/fps e som escolhidos NA TELA DE TRANSMITIR: viram o
          // padrão e são aplicados no site assim que a captura existir
          if (escolha && typeof escolha === 'object') {
            if (escolha.qualidade) config.qualidade = String(escolha.qualidade);
            config.somDaTela = escolha.som !== false;
            guardarConfig();
            aplicarNaTransmissao(config.qualidade, config.somDaTela);
          }
        }catch(e){ console.error('seletor de tela', e); try{ callback(); }catch{} }
      }, 0);
    };

    ipcMain.on('seletor-de-tela:escolheu', aoEscolher);
    janelaSeletor.once('closed', () => responder(null));

    janelaSeletor.loadFile('seletor-de-tela.html');
    janelaSeletor.webContents.once('did-finish-load', () => {
      janelaSeletor.webContents.send('seletor-de-tela:fontes', { lista, qualidade: config.qualidade, som: config.somDaTela !== false, apps, pidsJanela });
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
// notebook com duas placas (integrada + dedicada): o Chromium às vezes
// escolhe a integrada e transmite mal. Força a dedicada pra capturar,
// codificar e decodificar. Num PC de uma placa só, não muda nada.
app.commandLine.appendSwitch('force_high_performance_gpu');

// método de captura de tela do Chromium: DXGI (padrão) ou WGC. É uma chave
// de linha de comando — só vale na próxima abertura do app.
lerConfig();
if (config.captura === 'wgc') app.commandLine.appendSwitch('enable-features', 'WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer');

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
    ligarVigiaJogo();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) criarJanelaPrincipal();
    });
  });

  app.on('before-quit', () => { saindoDeVerdade = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { desligarVigiaGpu(); desligarPtt(); desligarSomDoApp(); clearInterval(vigiaJogo); });
}

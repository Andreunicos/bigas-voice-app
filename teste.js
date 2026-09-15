/* =====================================================================
 * TESTE MECÂNICO DO APLICATIVO — `npm test`
 * ---------------------------------------------------------------------
 * Roda o app de verdade com TODAS as janelas invisíveis (nada aparece na
 * tela) e dirige a casa por dentro: abre uma call, confere que o site foi
 * "vestido", faz um segundo participante invisível entrar pelo link e
 * conectar P2P, testa botão direito → menu de volume, mic/fone espelhados,
 * sair, entrar por convite, atalhos, e que fechar a janela encerra o app.
 *
 * Firebase (conta, amigos, chat, convite, perdida, bloqueio) roda de
 * ponta a ponta com duas contas de teste SE a senha delas estiver em
 * BIGAS_TESTE_SENHA (senão essa parte é pulada e avisada).
 *
 * Como funciona: rodado pelo Node, copia o app pra uma pasta temporária
 * (com este arquivo como "main") e abre o Electron nela. Dentro do
 * Electron, este mesmo arquivo vira o harness e depois carrega main.js.
 * ================================================================== */
const path = require('path');
const fs = require('fs');

const ARQUIVOS = ['main.js', 'preload.js', 'home.html', 'home.js', 'seletor-de-tela.html', 'seletor-de-tela.js', 'sobreposicao.html', 'sobreposicao.js', 'icone.png'];
const AJUDANTES = ['gpuprio.exe', 'teclas.exe', 'somdoapp.exe', 'rnnoise.wasm'];

if (!process.versions.electron) {
  /* ---------------- modo Node: prepara e dispara o Electron ---------------- */
  const os = require('os');
  const { spawnSync } = require('child_process');
  const raiz = __dirname;
  const pasta = path.join(os.tmpdir(), 'bigas-voice-teste');
  fs.rmSync(pasta, { recursive: true, force: true });
  fs.mkdirSync(pasta, { recursive: true });
  for (const a of ARQUIVOS) fs.copyFileSync(path.join(raiz, a), path.join(pasta, a));
  fs.mkdirSync(path.join(pasta, 'nativo'), { recursive: true });
  for (const a of AJUDANTES) if (fs.existsSync(path.join(raiz, 'nativo', a))) fs.copyFileSync(path.join(raiz, 'nativo', a), path.join(pasta, 'nativo', a));
  fs.copyFileSync(__filename, path.join(pasta, 'teste.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'teste.js' }));

  const exe = path.join(raiz, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  // BIGAS_INVISIVEL: o app não mostra sobreposição, notificação, Explorer, nem mexe na área de transferência
  const env = Object.assign({}, process.env, { BIGAS_APP_DIR: raiz, BIGAS_INVISIVEL: '1' });
  delete env.ELECTRON_RUN_AS_NODE; // se vier ligado do terminal, o Electron vira Node puro e nada funciona
  const r = spawnSync(exe, [pasta], { env, stdio: 'inherit', timeout: 600000 });
  process.exit(r.status == null ? 1 : r.status);
}

/* ---------------- modo Electron: o harness ---------------- */
const electron = require('electron');
const RealBW = electron.BrowserWindow;
const Module = require('module');
const APP_DIR = process.env.BIGAS_APP_DIR || __dirname;

class BWInvisivel extends RealBW {
  constructor(opts) { super(Object.assign({}, opts || {}, { show: false })); }
  show() {}            // nada aparece na tela durante o teste — nunca
  showInactive() {}
}
process.env.BIGAS_INVISIVEL = '1';
// main.js faz require('electron') → recebe um espelho com a BrowserWindow
// invisível; e os pacotes (electron-updater) vêm do node_modules do app
const electronEspelho = new Proxy(electron, { get(t, k) { return k === 'BrowserWindow' ? BWInvisivel : t[k]; } });
const loadOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronEspelho;
  try { return loadOriginal.apply(this, arguments); }
  catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && !request.startsWith('.')) {
      return loadOriginal.call(this, require.resolve(request, { paths: [APP_DIR] }), parent, isMain);
    }
    throw e;
  }
};

const { app, ipcMain, globalShortcut } = electron;
app.setPath('userData', path.join(__dirname, 'dados-teste')); // nunca a sessão de verdade
app.setPath('desktop', path.join(__dirname, 'dados-teste'));  // o diagnóstico "salva na Área de Trabalho" — aqui, não na de verdade
process.on('unhandledRejection', (e) => console.log('REJEICAO', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.log('EXCECAO', (e && e.stack) || e));

const resultados = [];
function ok(nome, cond, extra) { const l = (cond ? 'OK   ' : 'FALHA') + ' ' + nome + (extra ? '  → ' + extra : ''); resultados.push(l); console.log('  ' + l); }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarAte(fn, ms, passo) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { try { const v = await fn(); if (v) return v; } catch {} await espera(passo || 200); }
  return null;
}
function imprimir() {
  console.log('\n===== RESULTADO =====');
  resultados.forEach((l) => console.log(l));
  const falhas = resultados.filter((l) => l.startsWith('FALHA')).length;
  console.log('=====', resultados.length - falhas, '/', resultados.length, 'OK =====');
  return falhas;
}

app.whenReady().then(async () => {
  await espera(1500);
  const janela = electron.BaseWindow.getAllWindows()[0];
  ok('janela principal criada', !!janela);
  if (!janela) { imprimir(); return app.exit(1); }
  ok('janela invisivel', !janela.isVisible());

  janela.webContents.setAudioMuted(true); // toque de chamada da casa: nunca nas caixas do André durante o teste
  const errosHome = [];
  janela.webContents.on('console-message', (ev, nivel, msg) => { if (nivel >= 2) errosHome.push(msg); });
  const js = (codigo) => janela.webContents.executeJavaScript(codigo);

  await esperarAte(() => js('!!document.getElementById("tela-login")'), 8000);
  ok('home carregou com login visivel', (await js('getComputedStyle(document.getElementById("tela-login")).display')) === 'flex');
  await espera(2500); // firebase inicializa
  ok('home sem erro de JS', errosHome.length === 0, errosHome.join(' | ').slice(0, 300));
  ok('aviso de "sem internet" NAO apareceu (tem internet)', !(await js('document.getElementById("offline").classList.contains("mostra")')));

  // versão e botão de atualizar nos DOIS lugares (login e casa), um estado só
  const vers = await js('[...document.querySelectorAll(".versao")].map(e=>e.textContent).join("|")');
  ok('versao mostrada no login, na casa E nos ajustes', /^v[\d.]+(\|v[\d.]+){2,}$/.test(vers), vers);
  janela.webContents.send('atualizar:estado', { estado: 'baixando', percentual: 42 });
  await espera(300);
  const bts = await js('[...document.querySelectorAll(".btn-atualizar")].map(b=>b.className+"/"+b.querySelector("span:last-child").textContent).join(" || ")');
  ok('os dois botoes mostram o download (42%)', (bts.match(/Baixando… 42%/g) || []).length === 2, bts);
  janela.webContents.send('atualizar:estado', { estado: 'ocioso' });

  // config: muda atalho e confere que o Electron registrou de verdade
  const cfg = await js('window.bigasHome.configMudar({ atalhoMic: "Control+Shift+F9" })');
  ok('config salva e devolvida', cfg && cfg.atalhoMic === 'Control+Shift+F9');
  ok('atalho global registrado no sistema', globalShortcut.isRegistered('Control+Shift+F9'));
  await js('window.bigasHome.configMudar({ atalhoMic: "Control+Shift+M" })');
  const jj = await js('window.bigasHome.jogosJanela()'); // só LÊ (nunca muda o Windows no teste)
  ok('leitura da otimização de jogos em janela do Windows', jj === true || jj === false, String(jj));

  // simula "logado" só na tela (sem Firebase): mostra a casa pra medir o palco
  await js(`document.getElementById('tela-login').style.display='none'; document.getElementById('tela-casa').style.display='flex'; true`);
  await espera(300);
  // (o app mede o palco ao logar e ao chamar; aqui, sem login, avisa por "resize")
  await js('window.dispatchEvent(new Event("resize")); true');
  await espera(300);
  const r = JSON.parse(await js('JSON.stringify(document.getElementById("palco").getBoundingClientRect())'));
  ok('palco medido', r.width > 300 && r.height > 300, JSON.stringify(r));

  await js('window.bigasHome.configMudar({ ruidoForte: true })');

  // 1) CHAMAR: a casa pede pro app abrir a call e criar a sala
  const errosView = [];
  const t0 = Date.now();
  const link = await js('window.bigasHome.iniciarCall("Teste","Fulano")');
  ok('iniciarCall devolveu link do site', typeof link === 'string' && /^https:\/\/andreunicos\.github\.io\/#e=[a-z0-9]+~[A-Za-z0-9_-]+$/.test(link), String(link).slice(0, 60) + ' em ' + (Date.now() - t0) + 'ms');

  const view = janela.contentView.children[0];
  ok('view da call encaixada', janela.contentView.children.length === 1);
  if (view) {
    const vb = view.getBounds();
    ok('view no lugar do palco', Math.abs(vb.x - Math.round(r.x)) <= 1 && Math.abs(vb.width - Math.round(r.width)) <= 1 && Math.abs(vb.height - Math.round(r.height)) <= 1, JSON.stringify(vb));
    view.webContents.on('console-message', (ev, nivel, msg) => { if (nivel >= 2) errosView.push(msg); });
    const v = JSON.parse(await view.webContents.executeJavaScript(`JSON.stringify({
      vestido: !!window.__bigasVestido,
      nome: document.getElementById('meu-nome').value,
      btnSala: getComputedStyle(document.getElementById('btn-sala')).display,
      linkCampo: getComputedStyle(document.getElementById('sala-link')).display,
      whats: getComputedStyle(document.getElementById('sala-envio')).display,
      manual: getComputedStyle(document.getElementById('manual-bloco')).display,
      fone: getComputedStyle(document.querySelector('#entrada .fone')).display,
      topo: getComputedStyle(document.querySelector('#entrada .cartao-topo')).display,
      estado: document.getElementById('sala-txt').textContent,
      dono: sala.dono, ligada: sala.ligada,
      menuPessoa: typeof abrirMenuDaPessoa, pares: typeof pares, caiu: String(window.caiuPraManual).indexOf('modo manual')===-1,
    })`));
    ok('site vestido (script rodou)', v.vestido);
    ok('nick da conta aplicado no site', v.nome === 'Teste', v.nome);
    ok('botao criar sala / link / whatsapp / manual / "use fone" / cabecalho escondidos',
      [v.btnSala, v.linkCampo, v.whats, v.manual, v.fone, v.topo].every((x) => x === 'none'));
    ok('sou o DONO da sala', v.dono === true && v.ligada === true);
    ok('estado da sala traduzido (sem "link")', /chamando Fulano/i.test(v.estado) && !/link/i.test(v.estado), v.estado);
    ok('menu da pessoa acessivel pro botao direito', v.menuPessoa === 'function' && v.pares === 'object');
    ok('falha de sala nao manda pro "modo manual"', v.caiu === true);

    // ECO NA TRANSMISSÃO: toda captura de tela pedida pelo site, dentro do
    // app, tem que sair com restrictOwnAudio (som do próprio app excluído).
    // O seletor de tela do app abre (invisível) — o teste escolhe a 1ª tela.
    const fontes = await electron.desktopCapturer.getSources({ types: ['screen'] });
    const acharSeletor = () => electron.BaseWindow.getAllWindows().find((w) => w !== janela && /Escolha o que compartilhar|Transmitir — Bigas Voice/.test(w.getTitle())) || null;
    // enquanto o seletor de verdade está aberto (invisível), lê o que ele mostra:
    // nome dos monitores (modelo · resolução · principal) e a lista "som de onde"
    (async () => {
      const sel = await esperarAte(acharSeletor, 15000, 100);
      const dom = sel ? await esperarAte(() => sel.webContents.executeJavaScript(`(function(){ var n=[...document.querySelectorAll('.fonte .nome span')].map(e=>e.textContent); if(!n.length) return null; return JSON.stringify({ nomes:n.slice(0,4), som:[...document.getElementById('sel-som').options].map(o=>o.textContent), somVisivel: !document.getElementById('linha-som-de').hidden }); })()`).catch(() => null), 5000, 200) : null;
      let d = null; try { d = JSON.parse(dom); } catch {}
      ok('tela de transmitir (de verdade): monitores com nome e resolução', !!(d && d.nomes.some((n) => /×\d+/.test(n))), d ? d.nomes.join(' | ') : 'sem DOM');
      ok('tela de transmitir (de verdade): "som de onde" com a saída padrão + apps com som', !!(d && d.somVisivel && d.som.length >= 1 && /padrão/i.test(d.som[0])), d ? d.som.join(' | ').slice(0, 200) : 'sem DOM');
      ipcMain.emit('seletor-de-tela:escolheu', {}, fontes[0] && fontes[0].id);
    })();
    const cap = await view.webContents.executeJavaScript(`
      (async function(){
        try{
          const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false }, systemAudio: 'include' });
          const t = s.getAudioTracks()[0]; const st = t ? t.getSettings() : {};
          s.getTracks().forEach(x => x.stop());
          return JSON.stringify({ temAudio: !!t, restrict: st.restrictOwnAudio });
        }catch(e){ return JSON.stringify({ erro: e.name + ': ' + e.message }); }
      })()`, true);
    let cj = null; try { cj = JSON.parse(cap); } catch {}
    ok('captura de tela no app sai com o som próprio EXCLUÍDO (restrictOwnAudio)', !!(cj && cj.temAudio && cj.restrict === true), cap);

    // SELETOR CANCELADO e depois usado de novo: o ouvinte do pedido antigo
    // não pode engolir a escolha do pedido novo (era um bug real)
    // o seletor anterior ainda pode estar fechando: espera sumir, senão o teste fecha o velho e o novo fica aberto pra sempre
    await esperarAte(() => acharSeletor() ? null : 'sumiu', 8000, 100);
    const cancelado = view.webContents.executeJavaScript(`
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ABRIU'; }, e => e.name)`, true);
    const seletor = await esperarAte(() => electron.BaseWindow.getAllWindows().find((w) => w !== janela && /Escolha o que compartilhar|Transmitir — Bigas Voice/.test(w.getTitle())) || null, 15000, 150);
    ok('seletor de tela abriu (invisível)', !!seletor);
    if (seletor) seletor.close();
    ok('cancelar o seletor recusa a captura (erro, não trava)', /NotAllowedError|AbortError/.test(String(await cancelado)), String(await cancelado));
    setTimeout(() => ipcMain.emit('seletor-de-tela:escolheu', {}, fontes[0] && fontes[0].id), 1500);
    const denovo = await Promise.race([
      view.webContents.executeJavaScript(`navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ABRIU'; }, e => e.name)`, true),
      espera(9000).then(() => 'TRAVOU'),
    ]);
    ok('transmitir de novo depois de cancelar FUNCIONA (sem ouvinte vazado)', denovo === 'ABRIU', denovo);

    // AJUSTES em tela cheia: a call some da tela (mas continua) e volta ao fechar
    await js('document.getElementById("btn-ajustes").click(); true');
    await espera(900);
    ok('ajustes abrem em tela cheia', await js('document.getElementById("tela-ajustes").classList.contains("mostra")'));
    ok('a call fica escondida enquanto os ajustes estão abertos', view.getVisible() === false);
    await js('document.querySelector(".aj-nav button[data-sec=voz]").click(); true');
    await espera(1500);
    const disp = JSON.parse(await js('JSON.stringify({ mics: document.getElementById("sel-mic-app").options.length, saidas: document.getElementById("sel-saida-app").options.length, nivel: document.getElementById("nivel-mic").style.width, aviso: document.getElementById("aviso-mic").hidden })'));
    ok('ajustes listam microfones e saídas COM nome', disp.mics > 1 && disp.saidas > 1, JSON.stringify(disp));
    await js('document.getElementById("btn-fechar-ajustes").click(); true');
    await espera(300);
    ok('fechar os ajustes traz a call de volta', view.getVisible() === true && !(await js('document.getElementById("tela-ajustes").classList.contains("mostra")')));

    // a lateral (chat) abre → o palco encolhe → a view acompanha
    await js('document.getElementById("lateral").classList.add("mostra"); document.getElementById("sec-chat").classList.add("mostra"); window.dispatchEvent(new Event("resize")); true');
    await espera(500);
    const r2 = JSON.parse(await js('JSON.stringify(document.getElementById("palco").getBoundingClientRect())'));
    const vb2 = view.getBounds();
    ok('chat aberto ao lado: view encolheu junto com o palco', r2.width < r.width - 200 && Math.abs(vb2.width - Math.round(r2.width)) <= 1, vb2.width + ' vs ' + Math.round(r2.width));
    await js('document.getElementById("btn-fechar-chat").click(); true');
    await espera(300);

    // a TELA DE TRANSMITIR: cartões, tela inteira pré-escolhida, qualidade+fps, devolve {id, qualidade, som}
    const fontesT = await electron.desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } });
    const jt = new RealBW({ show: false, width: 1040, height: 700, webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(APP_DIR, 'preload.js') } });
    await jt.loadFile('seletor-de-tela.html');
    jt.webContents.send('seletor-de-tela:fontes', { lista: fontesT.map((f) => ({ id: f.id, nome: f.name, miniatura: f.thumbnail.toDataURL(), ehTela: f.id.startsWith('screen:') })), qualidade: '1080-60-8', som: true });
    await espera(600);
    const est = JSON.parse(await jt.webContents.executeJavaScript('JSON.stringify({ cartoes: document.querySelectorAll(".fonte").length, escolhida: document.querySelectorAll(".fonte.escolhida").length, quals: document.querySelectorAll("#qualidades .opcao").length, qualEscolhida: (document.querySelector("#qualidades .opcao.escolhida b")||{}).textContent, ir: !document.getElementById("btn-ir").disabled })'));
    ok('tela de transmitir: telas em cartões, tela inteira já escolhida, 6 qualidades, botão pronto', est.cartoes >= 1 && est.escolhida === 1 && est.quals === 6 && est.ir === true, JSON.stringify(est));
    ok('tela de transmitir: veio com a qualidade padrão (1080p 60)', /1080p · 60/.test(est.qualEscolhida || ''), est.qualEscolhida);
    const escolhaP = new Promise((r) => ipcMain.once('seletor-de-tela:escolheu', (ev, e) => r(e)));
    await jt.webContents.executeJavaScript('document.querySelectorAll("#qualidades .opcao")[2].click(); document.getElementById("chave-som").click(); document.getElementById("btn-ir").click(); true');
    const escolha = await Promise.race([escolhaP, espera(3000).then(() => null)]);
    ok('tela de transmitir devolve {id, qualidade, som}', !!(escolha && escolha.id && escolha.qualidade === '1080-30-5' && escolha.som === false), JSON.stringify(escolha));
    jt.destroy();

    // SOM DE UM APP SÓ: uma janela invisível toca 440 Hz a -80 dB (inaudível) —
    // o app captura o processo por fora (somdoapp.exe) e a página vira faixa.
    // O 440 Hz tem que aparecer na faixa que iria pros amigos.
    {
      const tom = new RealBW({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
      await tom.loadURL('data:text/html,<script>const c=new AudioContext();const o=c.createOscillator();o.frequency.value=440;const g=c.createGain();g.gain.value=0.0001;o.connect(g).connect(c.destination);o.start();</script>');
      await espera(800);
      setTimeout(() => ipcMain.emit('seletor-de-tela:escolheu', {}, { id: fontes[0] && fontes[0].id, qualidade: 'auto', som: true, somDe: process.pid }), 1500);
      const r = await Promise.race([view.webContents.executeJavaScript(`
        (async function(){
          try{
            const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false }, systemAudio: 'include' });
            const t = s.getAudioTracks()[0]; if (!t) return JSON.stringify({ erro: 'sem faixa de áudio' });
            const ctx = new AudioContext({ sampleRate: 48000 });
            const src = ctx.createMediaStreamSource(new MediaStream([t])); const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0; src.connect(an);
            await new Promise(r => setTimeout(r, 3000));
            const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f);
            const bin = Math.round(440 / (48000 / 8192));
            const pico = Math.max(f[bin - 1], f[bin], f[bin + 1]);
            const resto = [...f.slice(200, 600)].sort((a, b) => a - b); const mediana = resto[Math.floor(resto.length / 2)];
            s.getTracks().forEach(x => x.stop()); ctx.close();
            return JSON.stringify({ ativo: !!(window.__bigasSomDoApp && window.__bigasSomDoApp.ativo), label: t.label, pico: Math.round(pico), mediana: Math.round(mediana) });
          }catch(e){ return JSON.stringify({ erro: e.name + ': ' + e.message }); }
        })()`, true), espera(15000).then(() => '{"erro":"demorou"}')]);
      let sj = null; try { sj = JSON.parse(r); } catch {}
      ok('SOM DE UM APP: a faixa de áudio da captura passou a ser a nossa (worklet)', !!(sj && sj.ativo && /Destination/i.test(sj.label || '')), r);
      ok('SOM DE UM APP: o 440 Hz do processo escolhido chegou na faixa (loopback por processo)', !!(sj && Number.isFinite(sj.pico) && sj.pico > sj.mediana + 20), r);
      tom.destroy();
    }

    // PTT GLOBAL: escolher "segurar pra falar" liga o ajudante teclas.exe; voltar pra voz desliga
    {
      const lista = () => new Promise((r) => require('child_process').execFile('tasklist.exe', ['/fi', 'IMAGENAME eq teclas.exe', '/fo', 'csv', '/nh'], { windowsHide: true }, (e, out) => r(e ? '' : String(out))));
      await js('window.bigasHome.configMudar({ fala: "ptt", teclaPtt: "KeyV", nomeTeclaPtt: "V" })');
      const ligou = await esperarAte(async () => /teclas\.exe/i.test(await lista()) ? 'sim' : null, 5000, 300);
      ok('PTT GLOBAL: "segurar pra falar" liga o ajudante teclas.exe durante a call', ligou === 'sim');
      await js('window.bigasHome.configMudar({ fala: "voz" })');
      const desligou = await esperarAte(async () => /teclas\.exe/i.test(await lista()) ? null : 'sim', 5000, 300);
      ok('PTT GLOBAL: voltar pra "voz aberta" desliga o ajudante', desligou === 'sim');
    }

    // ===== DUAS PONTAS: um "amigo" entra pelo link numa janela invisível =====
    // (as duas pontas nascem MUDAS: no mesmo PC, mic + caixa = eco/loop de verdade)
    view.webContents.setAudioMuted(true);
    let avisoConectada = false;
    ipcMain.on('call:aviso', (ev, o) => { if (o === 'conectada') avisoConectada = true; });
    const amigo = new RealBW({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    amigo.webContents.setAudioMuted(true);
    await amigo.loadURL(link);
    await amigo.webContents.executeJavaScript(`var n=document.getElementById('meu-nome'); n.value='Amigo2'; n.dispatchEvent(new Event('input',{bubbles:true})); true`).catch(() => {});
    const conectou = await esperarAte(() => view.webContents.executeJavaScript(
      `(function(){ var p=[...pares.values()][0]; return (p && p.conectado && !document.getElementById('chamada').hidden) ? JSON.stringify({nome:p.nome, n:pares.size}) : null; })()`), 40000, 400);
    ok('AMIGO CONECTOU na call do app (P2P de verdade)', !!conectou, conectou);
    await espera(600);
    ok('casa avisada que a call conectou', avisoConectada);
    ok('casa mostra "Em chamada"', /Em chamada/.test(await js('document.getElementById("call-titulo").textContent')));
    // vigia da placa: durante a call o app mede a GPU e a casa mostra "placa N%"
    const gpuTxt = await esperarAte(() => js('(/placa \\d+%/.test(document.getElementById("call-sub").textContent) ? document.getElementById("call-sub").textContent : null)'), 15000, 500);
    ok('vigia da placa: casa mostra o uso da GPU durante a call', !!gpuTxt, gpuTxt);
    // prioridade de GPU (o truque do OBS): o processo de GPU do app tem que estar em classe 5 durante a call
    {
      const exe = path.join(__dirname, 'nativo', 'gpuprio.exe');
      if (fs.existsSync(exe)) {
        await espera(2500);
        const { execFileSync } = require('child_process');
        const gpu = app.getAppMetrics().find((m) => m.type === 'GPU');
        const saida = gpu ? String(execFileSync(exe, [String(gpu.pid)], { windowsHide: true })).trim() : 'sem processo de GPU';
        ok('prioridade de GPU alta no processo de GPU durante a call', /classe=(4|5)/.test(saida), saida);
      } else ok('ajudante gpuprio.exe presente (compilar em nativo/)', false, 'faltando');
    }

    // RESOLUÇÃO CHEIA: quem assiste no app pede o tamanho do MONITOR, não do palco (senão o amigo mandava 960x540)
    {
      await view.webContents.executeJavaScript(`avisarTamanhos(); true`).catch(() => {});
      const pediu = await esperarAte(() => amigo.webContents.executeJavaScript(`(function(){ var p = [...pares.values()][0]; return p && p.larguraQueQuer >= 1280 ? p.larguraQueQuer : null; })()`), 8000, 300);
      ok('quem assiste no app pede a resolução do monitor inteiro (não do palco)', pediu >= 1280, String(pediu));
    }
    // SOBREPOSIÇÃO: a view conta quem está na call (eu + amigo) — a casa e a janelinha recebem
    {
      const gente = await esperarAte(() => js('(function(){ var g = window.__bigasEstado.call.gente; return g && g.length === 2 ? JSON.stringify(g) : null; })()'), 6000, 300);
      ok('sobreposição: lista "quem está na call" chega com as duas pessoas', !!gente, gente);
      ok('sobreposição: nada apareceu na tela (modo invisível)', !electron.BaseWindow.getAllWindows().some((w) => /sobreposição/.test(w.getTitle()) && w.isVisible()));
    }
    // PING / RECONECTANDO: a view manda rede:<religando>:<ping> e o painel mostra
    {
      const rede = await esperarAte(() => js('(function(){ var c = window.__bigasEstado.call; return typeof c.ping === "number" && c.religando === false ? "ok" : null; })()'), 6000, 300);
      ok('painel da call recebe ping/estado da rede', rede === 'ok');
    }
    // SENSIBILIDADE: o ponto de corte do app vale no site, e abaixo dele o microfone FECHA de verdade
    {
      await js('window.bigasHome.configMudar({ portao: 23, portaoCorta: true })');
      const cfgSite = await esperarAte(() => view.webContents.executeJavaScript(`(cfg.portao === 23 && cfg.portaoCorta === true) ? 'ok' : null`), 6000, 300);
      ok('sensibilidade: o ponto de corte (23) e a chave "cortar" chegam no site', cfgSite === 'ok');
      const portao = await view.webContents.executeJavaScript(`(function(){ var t = est.streamMic.getAudioTracks()[0]; cfg.fala = 'voz'; est.mudo = false; est.portaoAberto = false; aplicarMudo(); var fechado = t.enabled; est.portaoAberto = true; aplicarMudo(); var aberto = t.enabled; est.portaoAberto = undefined; return JSON.stringify({ fechado: fechado, aberto: aberto }); })()`);
      ok('sensibilidade: abaixo do ponto a faixa do mic desliga; acima liga', portao === '{"fechado":false,"aberto":true}', portao);
      await js('window.bigasHome.configMudar({ portao: 12 })');
    }

    // RUÍDO FORTE (RNNoise): o microfone do site passa pelo worklet; desligar volta pro mic direto
    {
      const antes = await view.webContents.executeJavaScript(`JSON.stringify({ rn: !!(window.__bigasRnnoise && window.__bigasRnnoise.ativo), pronto: !!(window.__bigasRnnoise && window.__bigasRnnoise.pronto), label: est.streamMic ? est.streamMic.getAudioTracks()[0].label : null })`);
      let aj = null; try { aj = JSON.parse(antes); } catch {}
      ok('RUÍDO FORTE: com a chave ligada o site recebe o microfone já filtrado (RNNoise carregou)', !!(aj && aj.rn && aj.pronto && /Destination/i.test(aj.label || '')), antes);
      await js('window.bigasHome.configMudar({ ruidoForte: false })');
      const depois = await esperarAte(() => view.webContents.executeJavaScript(`(function(){ var l = est.streamMic ? est.streamMic.getAudioTracks()[0].label : ''; return l && !/Destination/i.test(l) ? l : null; })()`), 8000, 400);
      const porque = depois ? '' : await view.webContents.executeJavaScript(`JSON.stringify({ querido: window.__bigasRnnoise.querido, label: est.streamMic && est.streamMic.getAudioTracks()[0].label, estado: est.streamMic && est.streamMic.getAudioTracks()[0].readyState, casa: null })`) + ' casa=' + (await js('window.__bigasEstado.call.estado'));
      ok('RUÍDO FORTE: desligar no meio da call troca pro microfone direto, sem derrubar nada', !!depois, depois || porque);
    }
    // DIAGNÓSTICO: um arquivo com app + placa + call + relatório do site
    {
      const r = await js('window.bigasHome.diagnostico({ teste: true })');
      const t = (r && r.texto) || '';
      ok('diagnóstico gerado com app, placa, call e relatório do site', /DIAGNÓSTICO DO BIGAS VOICE/.test(t) && /--- call ---/.test(t) && /relatório do site/.test(t) && /DIAGNÓSTICO DO FRAG|VERSÃO/.test(t), (r && r.caminho) + ' ' + t.length + ' chars');
      ok('diagnóstico salvo na pasta de teste (não na Área de Trabalho de verdade)', !!(r && r.caminho && r.caminho.includes('dados-teste') && fs.existsSync(r.caminho)), r && r.caminho);
    }

    if (conectou) {
      // mic/fone: a casa aperta → o site muda → a casa espelha
      await js('window.bigasHome.mic(); true');
      await espera(500);
      const mudoSite = await view.webContents.executeJavaScript(`document.getElementById('btn-mic').classList.contains('on')`);
      const mudoCasa = await js(`document.getElementById('btn-mic').classList.contains('on') && document.getElementById('btn-mic').textContent`);
      ok('mutar pelo rodapé da casa muta no site', mudoSite === true);
      ok('rodapé espelha o mudo (🔇)', mudoCasa === '🔇', String(mudoCasa));
      await js('window.bigasHome.mic(); true'); // desmuta
      await espera(300);

      // atalho global aciona o site (simulado chamando o mesmo caminho)
      await js('window.bigasHome.surdo(); true');
      await espera(400);
      ok('silenciar tudo pelo rodapé silencia no site', await view.webContents.executeJavaScript(`document.getElementById('btn-surdo').classList.contains('on')`));
      await js('window.bigasHome.surdo(); true');

      const menu = await view.webContents.executeJavaScript(`(function(){
        var f = document.querySelector('.ficha:not(.eu)'); if (!f) return 'sem ficha';
        f.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 120 }));
        var m = document.getElementById('menu-pessoa'); if (!m) return 'sem menu';
        var r = m.querySelector('input[type=range]');
        return JSON.stringify({ range: !!r, max: r && r.max, left: m.style.left, top: m.style.top });
      })()`);
      let mj = null; try { mj = JSON.parse(menu); } catch {}
      ok('BOTAO DIREITO na pessoa abre o menu com VOLUME no mouse', !!(mj && mj.range && mj.max === '200' && mj.left === '200px'), menu);
      ok('nick do amigo chegou pelo canal', (await view.webContents.executeJavaScript(`[...pares.values()][0].nome`)) === 'Amigo2');
    }
    // ===== TRÊS NA CALL: um terceiro entra pelo mesmo link (malha do site) =====
    {
      const amigo3 = new RealBW({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
      amigo3.webContents.setAudioMuted(true);
      await amigo3.loadURL(link);
      await amigo3.webContents.executeJavaScript(`var n=document.getElementById('meu-nome'); n.value='Amigo3'; n.dispatchEvent(new Event('input',{bubbles:true})); true`).catch(() => {});
      const tres = await esperarAte(() => view.webContents.executeJavaScript(`(function(){ var ps=[...pares.values()]; return (ps.length===2 && ps.every(p=>p.conectado)) ? ps.map(p=>p.nome).sort().join(',') : null; })()`), 40000, 400);
      ok('TRÊS NA CALL: os dois amigos conectados comigo (malha)', tres === 'Amigo2,Amigo3', tres);
      const gente3 = await esperarAte(() => js('(function(){ var g = window.__bigasEstado.call.gente; return g && g.length === 3 ? g.map(x=>x.nome).join(";") : null; })()'), 8000, 300);
      ok('TRÊS NA CALL: a casa lista os três (eu + 2)', /Teste/.test(gente3 || '') && /Amigo2/.test(gente3 || '') && /Amigo3/.test(gente3 || ''), gente3);
      const sub3 = await esperarAte(() => js('(function(){ var t = document.getElementById("call-sub").textContent; return /Amigo2/.test(t) && /Amigo3/.test(t) ? t : null; })()'), 6000, 300);
      ok('TRÊS NA CALL: o painel diz "com Amigo2, Amigo3" (quem está de fato, não só quem eu chamei)', !!sub3, sub3);
      // os dois amigos se enxergam entre si (malha de verdade, não estrela)
      const entreEles = await esperarAte(() => amigo3.webContents.executeJavaScript(`(function(){ var ps=[...pares.values()].filter(p=>p.conectado); return ps.length===2 ? ps.map(p=>p.nome).sort().join(',') : null; })()`), 30000, 500);
      ok('TRÊS NA CALL: o terceiro enxerga os outros dois', entreEles === 'Amigo2,Teste', entreEles);
      await amigo3.webContents.executeJavaScript('try{ darAdeus(); }catch(e){} true').catch(() => {});
      amigo3.destroy();
      ok('TRÊS NA CALL: um sai, a call continua com o outro', (await esperarAte(() => view.webContents.executeJavaScript(`(function(){ var ps=[...pares.values()]; return ps.length===1 && ps[0].nome==='Amigo2' ? 'sim' : null; })()`), 15000, 400)) === 'sim');
      const sub2 = await esperarAte(() => js('(function(){ var t = document.getElementById("call-sub").textContent; return !/Amigo3/.test(t) ? t : null; })()'), 8000, 300);
      ok('TRÊS NA CALL: o painel tira quem saiu', !!sub2, sub2);
    }

    await amigo.webContents.executeJavaScript('try{ darAdeus(); }catch(e){} true').catch(() => {});
    amigo.destroy();
    ok('app percebeu que o amigo saiu', (await esperarAte(() => view.webContents.executeJavaScript(`pares.size === 0 ? 'sim' : null`), 15000, 400)) === 'sim');

    // o botao de encerrar do site → volta pra casa (sem confirm, sem reload)
    let confirmChamado = false;
    view.webContents.on('console-message', (ev, nivel, msg) => { if (/confirm chamado/.test(msg)) confirmChamado = true; });
    await view.webContents.executeJavaScript(`window.confirm = function(){ console.log('confirm chamado'); return false; }; document.getElementById('btn-sair').click(); true`);
    await espera(900);
    ok('encerrar do site fecha a call (view some)', janela.contentView.children.length === 0);
    ok('encerrar nao passou pelo confirm do site', !confirmChamado);
    ok('casa voltou pro descanso (sem "Em chamada")', !(await js('document.getElementById("painel-call").classList.contains("tem")')));
    {
      const exe = path.join(__dirname, 'nativo', 'gpuprio.exe');
      const gpu = app.getAppMetrics().find((m) => m.type === 'GPU');
      if (fs.existsSync(exe) && gpu) {
        await espera(1500);
        const saida = String(require('child_process').execFileSync(exe, [String(gpu.pid)], { windowsHide: true })).trim();
        ok('ao sair da call a prioridade de GPU volta ao normal', /classe=2/.test(saida), saida);
      }
    }
  }

  // 2) ENTRAR POR CONVITE: abre direto no link
  ok('entrarComLink aceitou o link', (await js(`window.bigasHome.entrarComLink(${JSON.stringify(link)}, "Amigo", "Teste")`)) === true);
  const view2 = janela.contentView.children[0];
  ok('view da call (convidado) encaixada', !!view2);
  if (view2) {
    const est = await esperarAte(() => view2.webContents.executeJavaScript(`(function(){ return (sala.ligada && !sala.dono) ? document.getElementById('meu-nome').value : null; })()`), 12000);
    ok('convidado entrou na sala (nao-dono) com o nick certo', est === 'Amigo', est);
    ok('link de outro site é recusado', (await js(`window.bigasHome.entrarComLink("https://exemplo.com/#e=abc~def", "X", "Y")`)) === false);
    ok('a call boa continua no lugar', janela.contentView.children.length === 1);
    await js('window.bigasHome.sairDaCall(); true');
    await espera(900);
    ok('sair pela casa fecha a call', janela.contentView.children.length === 0);
  }
  await testarFirebase(janela, js, ok, esperarAte, espera);

  const avisosNormais = /favicon|ntfy|429|Failed to load resource|net::|perfil video|servidor entupido|permission-denied|Missing or insufficient/i;
  ok('view sem erro de JS grave', errosView.filter((m) => !avisosNormais.test(m)).length === 0, errosView.join(' | ').slice(0, 400));
  ok('home sem erro de JS ate o fim', errosHome.filter((m) => !/favicon|permission-denied/i.test(m)).length === 0, errosHome.join(' | ').slice(0, 400));

  // fechar a janela tem que ENCERRAR o app (nada em segundo plano)
  let encerrou = false;
  app.on('will-quit', () => { if (!encerrou) { encerrou = true; ok('fechar a janela encerra o app (sem segundo plano)', true); const f = imprimir(); app.exit(f ? 1 : 0); } });
  janela.close();
  setTimeout(() => { if (!encerrou) { encerrou = true; ok('fechar a janela encerra o app (sem segundo plano)', false, 'processo continuou vivo'); imprimir(); app.exit(1); } }, 3000);
});

/* =====================================================================
 * FIREBASE DE PONTA A PONTA — duas contas de teste, de verdade, no
 * projeto de verdade (as REGRAS publicadas é que valem). Só roda com a
 * senha das contas em BIGAS_TESTE_SENHA (as contas são criadas na
 * primeira vez). Sem a senha, pula e avisa.
 * ================================================================== */
async function testarFirebase(janelaA, jsA, ok, esperarAte, espera) {
  const senha = process.env.BIGAS_TESTE_SENHA;
  if (!senha) { console.log('  PULADO Firebase de ponta a ponta (defina BIGAS_TESTE_SENHA pra rodar)'); return; }
  const NICK_A = 'teste_bigas_a', NICK_B = 'teste_bigas_b';
  const janelaB = new RealBW({ show: false, width: 1280, height: 820, webPreferences: { contextIsolation: true, sandbox: true, partition: 'teste-b', preload: path.join(APP_DIR, 'preload.js') } });
  janelaB.webContents.setAudioMuted(true);
  const errosB = [];
  janelaB.webContents.on('console-message', (ev, nivel, msg) => { if (nivel >= 2) errosB.push(msg); });
  await janelaB.loadFile(path.join(APP_DIR, 'home.html'));
  const jsB = (c) => janelaB.webContents.executeJavaScript(c);
  await esperarAte(() => jsB('!!window.__bigasEstado'), 8000);
  await espera(1500);

  async function logar(js, nick) {
    await js(`window.confirm = () => true; document.getElementById('nick').value = ${JSON.stringify(nick)}; document.getElementById('senha').value = ${JSON.stringify(senha)}; document.getElementById('btn-entrar').click(); true`);
    let r = await esperarAte(() => js(`getComputedStyle(document.getElementById('tela-casa')).display === 'flex' && window.__bigasEstado.eu.nick ? 'ok' : (document.getElementById('erro-login').textContent || null)`), 15000, 300);
    if (r !== 'ok' && /errados/.test(String(r))) {
      // primeira vez: cria a conta
      await js(`document.getElementById('btn-criar').click(); document.getElementById('nick').value = ${JSON.stringify(nick)}; document.getElementById('senha').value = ${JSON.stringify(senha)}; document.getElementById('btn-criar').click(); true`);
      r = await esperarAte(() => js(`getComputedStyle(document.getElementById('tela-casa')).display === 'flex' && window.__bigasEstado.eu.nick ? 'ok' : (document.getElementById('erro-login').textContent || null)`), 20000, 300);
    }
    return r;
  }
  ok('FIREBASE: conta A entrou (' + NICK_A + ')', (await logar(jsA, NICK_A)) === 'ok');
  ok('FIREBASE: conta B entrou (' + NICK_B + ')', (await logar(jsB, NICK_B)) === 'ok');
  const uidA = await jsA('window.__bigasEstado.eu.uid'), uidB = await jsB('window.__bigasEstado.eu.uid');
  if (!uidA || !uidB) { janelaB.destroy(); return; }
  const temAmigo = (js, uid) => js(`window.__bigasEstado.amigos.has(${JSON.stringify(uid)})`);

  // limpeza de uma rodada anterior que tenha morrido no meio
  if (await temAmigo(jsA, uidB)) { await jsA(`window.__bigasEstado.tirarAmigo(${JSON.stringify(uidB)}, ${JSON.stringify(NICK_B)})`); }
  await esperarAte(async () => (!(await temAmigo(jsA, uidB)) && !(await temAmigo(jsB, uidA))) ? 'ok' : null, 15000, 500);
  if (await temAmigo(jsB, uidA)) { await jsB(`window.__bigasEstado.tirarAmigo(${JSON.stringify(uidA)}, ${JSON.stringify(NICK_A)})`); await esperarAte(async () => !(await temAmigo(jsB, uidA)) ? 'ok' : null, 10000, 500); }

  // pedidos pendentes de uma rodada anterior: B recusa todos antes de começar
  await jsB(`document.querySelectorAll('#pedidos .cartinha .nao').forEach(b => b.click()); true`);
  await esperarAte(() => jsB(`document.getElementById('bloco-pedidos').hidden ? 'ok' : null`), 8000, 300);

  // pedido de amizade A → B, B aceita, os dois lados ficam amigos
  await jsA(`document.getElementById('add-nick').value = ${JSON.stringify(NICK_B)}; document.getElementById('btn-add').click(); true`);
  const aviso = await esperarAte(() => jsA(`document.getElementById('erro-add').textContent || null`), 10000, 300);
  ok('FIREBASE: pedido de amizade enviado', /enviado|já tinha/i.test(String(aviso)), aviso);
  const pedidoB = await esperarAte(() => jsB(`(function(){ var b = document.querySelector('#pedidos .cartinha b'); return b && b.textContent === ${JSON.stringify(NICK_A)} ? 'ok' : null; })()`), 15000, 300);
  ok('FIREBASE: B recebeu o pedido em tempo real', pedidoB === 'ok', pedidoB === 'ok' ? '' : 'erros de B: ' + errosB.join(' | ').slice(0, 300) + ' | pedidos no DOM: ' + (await jsB(`document.getElementById('pedidos').innerHTML.slice(0, 200)`)) + ' | bloco: ' + (await jsB(`document.getElementById('bloco-pedidos').hidden`)));
  await jsB(`var s = document.querySelector('#pedidos .cartinha .sim'); if (s) s.click(); true`);
  const amigosOk = await esperarAte(async () => ((await temAmigo(jsA, uidB)) && (await temAmigo(jsB, uidA))) ? 'ok' : null, 20000, 500);
  ok('FIREBASE: amizade mútua (A tem B, B tem A) depois do aceite', amigosOk === 'ok');
  const presenca = await esperarAte(() => jsB(`(function(){ var a = window.__bigasEstado.amigos.get(${JSON.stringify(uidA)}); return a && a.presenca && a.presenca.ultimoVisto ? 'ok' : null; })()`), 15000, 500);
  ok('FIREBASE: B vê a presença de A (batida de "online")', presenca === 'ok');

  // chat A → B
  const texto = 'oi ' + Date.now();
  await jsA(`(function(){ var l = [...document.querySelectorAll('.amigo')].find(x => x.querySelector('.nome').textContent.trim().startsWith(${JSON.stringify(NICK_B)})); if (l) l.click(); })(); true`);
  await esperarAte(() => jsA(`document.getElementById('sec-chat').classList.contains('mostra') ? 'ok' : null`), 5000, 200);
  await jsA(`document.getElementById('chat-texto').value = ${JSON.stringify(texto)}; document.getElementById('btn-enviar').click(); true`);
  const chegou = await esperarAte(() => jsB(`(function(){ var a = window.__bigasEstado.amigos.get(${JSON.stringify(uidA)}); return a && a.ultima && a.ultima.texto === ${JSON.stringify(texto)} ? (a.naoLidas ? 'nao-lida' : 'lida') : null; })()`), 15000, 300);
  ok('FIREBASE: mensagem chegou em B como NÃO LIDA (bolinha)', chegou === 'nao-lida', chegou);
  await jsB(`(function(){ var l = [...document.querySelectorAll('.amigo')].find(x => x.querySelector('.nome').textContent.trim().startsWith(${JSON.stringify(NICK_A)})); if (l) l.click(); })(); true`);
  const noChat = await esperarAte(() => jsB(`[...document.querySelectorAll('#mensagens .texto')].some(e => e.textContent === ${JSON.stringify(texto)}) ? 'ok' : null`), 10000, 300);
  ok('FIREBASE: B abre a conversa e vê a mensagem', noChat === 'ok');
  await jsA(`document.getElementById('btn-fechar-chat').click(); true`);
  await jsB(`document.getElementById('btn-fechar-chat').click(); true`);

  // chamada A → B: o convite toca em B; B recusa; A vê "recusou" e a call fecha
  await jsA(`(function(){ var l = [...document.querySelectorAll('.amigo')].find(x => x.querySelector('.nome').textContent.trim().startsWith(${JSON.stringify(NICK_B)})); if (l) l.querySelector('.chamar').click(); })(); true`);
  const tocou = await esperarAte(() => jsB(`document.getElementById('convite').classList.contains('tem') && document.getElementById('convite-nick').textContent === ${JSON.stringify(NICK_A)} ? 'ok' : null`), 30000, 300);
  ok('FIREBASE: chamada de A TOCA em B (convite em tempo real, regras deixaram)', tocou === 'ok');
  await jsB(`document.getElementById('btn-recusar').click(); true`);
  const recusou = await esperarAte(() => jsA(`(!document.getElementById('painel-call').classList.contains('tem') && /recusou/.test(document.getElementById('recado').textContent)) ? 'ok' : null`), 20000, 300);
  ok('FIREBASE: B recusou → A vê "recusou" e a call fecha', recusou === 'ok');
  await esperarAte(() => jsB(`!document.getElementById('convite').classList.contains('tem') ? 'ok' : null`), 8000, 300);

  // chamada perdida: A chama, desiste; B fica com "te ligou" e histórico
  await jsA(`(function(){ var l = [...document.querySelectorAll('.amigo')].find(x => x.querySelector('.nome').textContent.trim().startsWith(${JSON.stringify(NICK_B)})); if (l) l.querySelector('.chamar').click(); })(); true`);
  await esperarAte(() => jsB(`document.getElementById('convite').classList.contains('tem') ? 'ok' : null`), 30000, 300);
  await jsA(`document.getElementById('btn-sair-call').click(); true`);
  const perdida = await esperarAte(() => jsB(`(function(){ var b = document.querySelector('#perdidas .cartinha b'); return b && b.textContent.startsWith(${JSON.stringify(NICK_A)}) ? 'ok' : null; })()`), 20000, 300);
  ok('FIREBASE: A desistiu → B fica com "chamada perdida"', perdida === 'ok');
  const histB = await esperarAte(() => jsB(`(function(){ var h = window.__bigasEstado.historicoLer(); return h.some(x => x.tipo === 'perdida' && x.nick === ${JSON.stringify(NICK_A)}) ? 'ok' : null; })()`), 8000, 300);
  ok('histórico: a perdida entrou no histórico de B', histB === 'ok');
  const histA = await esperarAte(async () => { const n = await jsA(`(function(){ var h = window.__bigasEstado.historicoLer(); return h.filter(x => x.tipo === 'fiz' && x.nick === ${JSON.stringify(NICK_B)}).length; })()`); return n >= 2 ? n : null; }, 10000, 400);
  ok('histórico: as chamadas feitas entraram no histórico de A', histA >= 2, String(histA));
  await jsA(`document.getElementById('btn-historico').click(); true`);
  await espera(300);
  ok('histórico: a lateral abre com as entradas', (await jsA(`document.getElementById('sec-historico').classList.contains('mostra') && document.querySelectorAll('#historico .cartinha').length`)) >= 2);
  await jsA(`document.getElementById('btn-fechar-historico').click(); true`);

  // GRUPO: A já numa call chama B pra ela → o painel de A mostra "chamando B…" (antes só B via que tocava)
  {
    await jsA(`window.__bigasEstado.entrarEmEstado('conectada', 'Fulano', 'chamando'); window.__bigasEstado.call.link = 'https://andreunicos.github.io/#e=teste~grupo'; window.__bigasEstado.pintarCall(); true`);
    await jsA(`window.__bigasEstado.chamarParaCall(${JSON.stringify(uidB)}, ${JSON.stringify(NICK_B)}); true`);
    const chamando = await esperarAte(() => jsA(`(function(){ var c = document.getElementById('call-chamando'); return !c.hidden && /chamando teste_bigas_b/.test(c.textContent) ? c.textContent : null; })()`), 10000, 300);
    ok('GRUPO: quem chama VÊ "chamando B…" no painel', !!chamando, chamando);
    const tocouB = await esperarAte(() => jsB(`document.getElementById('convite').classList.contains('tem') ? document.getElementById('convite-sub').textContent : null`), 20000, 300);
    ok('GRUPO: B recebe o convite pra entrar na call', !!tocouB, tocouB);
    await jsB(`document.getElementById('btn-recusar').click(); true`);
    const sumiu = await esperarAte(() => jsA(`(function(){ var c = document.getElementById('call-chamando'); return (c.hidden || !/teste_bigas_b/.test(c.textContent)) && /recusou/.test(document.getElementById('recado').textContent) ? 'ok' : null; })()`), 15000, 300);
    ok('GRUPO: B recusou → some do painel de A com o recado "recusou"', sumiu === 'ok');
    // e cancelar pelo ✕: o convite para de tocar em B
    await esperarAte(() => jsB(`!document.getElementById('convite').classList.contains('tem') ? 'ok' : null`), 8000, 300);
    await jsA(`window.__bigasEstado.chamarParaCall(${JSON.stringify(uidB)}, ${JSON.stringify(NICK_B)}); true`);
    await esperarAte(() => jsB(`document.getElementById('convite').classList.contains('tem') ? 'ok' : null`), 20000, 300);
    await jsA(`document.querySelector('#call-chamando button').click(); true`);
    const parou = await esperarAte(() => jsB(`!document.getElementById('convite').classList.contains('tem') ? 'ok' : null`), 15000, 300);
    ok('GRUPO: ✕ em "chamando B…" para de tocar em B', parou === 'ok');
    await jsA(`window.__bigasEstado.entrarEmEstado('nenhuma'); true`);
  }

  // ===== COFRE DE LOGIN: e-mail cifrado com a senha; abre só com a senha certa =====
  {
    let r = null;
    try { r = await jsA(`(async () => { const E = window.__bigasEstado; await E.guardarNoCofre(${JSON.stringify(NICK_A)}, 'teste.bigas.a@example.com', ${JSON.stringify(senha)}); const certo = await E.abrirCofre(${JSON.stringify(NICK_A)}, ${JSON.stringify(senha)}); let errado = 'abriu'; try { await E.abrirCofre(${JSON.stringify(NICK_A)}, 'senha-errada'); } catch (e) { errado = 'fechado'; } return JSON.stringify({ certo, errado }); })()`); } catch (e) { r = 'erro ' + (e && e.message); }
    ok('COFRE: o e-mail cifrado abre com a senha certa e NÃO abre com a errada (regras v5)', r === '{"certo":"teste.bigas.a@example.com","errado":"fechado"}', String(r).slice(0, 160));
    const dePublico = await jsB(`(async () => { try { return await window.__bigasEstado.abrirCofre(${JSON.stringify(NICK_A)}, 'x'); } catch (e) { return 'fechado'; } })()`);
    ok('COFRE: outra pessoa lê o blob mas não o e-mail', dePublico === 'fechado', String(dePublico));
  }

  // ===== GRUPOS ("servidores") =====
  {
    const nomeG = 'Grupo teste ' + String(Date.now()).slice(-5);
    let gid = null;
    // a estrutura de um servidor do Discord, colada como texto (categorias + # texto + 🔊 voz)
    const estrutura = 'GERAL TEXT' + String.fromCharCode(10) + '# geral' + String.fromCharCode(10) + '# comand-music' + String.fromCharCode(10) + 'SO NAS CALL' + String.fromCharCode(10) + '🔊 GERAL' + String.fromCharCode(10) + '🔊 GERAL 2' + String.fromCharCode(10) + '🔊 AFK' + String.fromCharCode(10) + 'Fortnite' + String.fromCharCode(10) + 'voz Fortnosos';
    ok('GRUPOS: a estrutura colada vira 6 canais em 3 categorias', (await jsA(`JSON.stringify(window.__bigasEstado.lerEstrutura(${JSON.stringify(estrutura)}).map(c => c.categoria + '/' + c.tipo + '/' + c.nome))`)) === JSON.stringify(['GERAL TEXT/texto/geral','GERAL TEXT/texto/comand-music','SO NAS CALL/voz/GERAL','SO NAS CALL/voz/GERAL 2','SO NAS CALL/voz/AFK','Fortnite/voz/Fortnosos']));
    try { gid = await jsA(`window.__bigasEstado.criarGrupo(${JSON.stringify(nomeG)}, ${JSON.stringify(estrutura)})`); }
    catch (e) { ok('GRUPOS: criar grupo (precisa das REGRAS v4 publicadas no console do Firebase)', false, String(e && e.message).slice(0, 120)); }
    if (gid) {
      ok('GRUPOS: A criou o grupo', true, gid);
      await jsA(`window.__bigasEstado.abrirGrupo(${JSON.stringify(gid)}); true`);
      const abriu = await esperarAte(() => jsA(`(function(){ var E = window.__bigasEstado; return !document.getElementById('cab-grupo').hidden && E.grupo.canais.size === 6 && document.querySelectorAll('#trilho-grupos .grupo-ic').length >= 1 ? document.getElementById('grupo-nome').textContent : null; })()`), 10000, 300);
      ok('GRUPOS: o grupo abre com os 6 canais e aparece no trilho', abriu === nomeG, abriu);
      const cats = await jsA(`[...document.querySelectorAll('#canais .categoria span:first-child')].map(e => e.textContent).join('|')`);
      ok('GRUPOS: as categorias aparecem na ordem colada (GERAL TEXT, SO NAS CALL, Fortnite)', cats === 'GERAL TEXT|SO NAS CALL|Fortnite', cats);
      const ordemCanais = await jsA(`[...document.querySelectorAll('#canais .canal .nome')].map(e => e.textContent).join('|')`);
      ok('GRUPOS: os canais ficam dentro das categorias, na ordem', ordemCanais === 'geral|comand-music|GERAL|GERAL 2|AFK|Fortnosos', ordemCanais);
      const codigo = await esperarAte(() => jsA(`(function(){ var g = window.__bigasEstado.grupos.get(${JSON.stringify(gid)}); return g && g.codigo ? g.codigo : null; })()`), 8000, 300);
      ok('GRUPOS: o grupo tem código de entrada', !!codigo && /^[A-Z0-9]{6}$/.test(codigo), codigo);
      // B entra pelo código
      let entrou = null;
      try { entrou = await jsB(`window.__bigasEstado.entrarPorCodigo(${JSON.stringify(codigo)})`); } catch (e) { entrou = 'erro ' + (e && e.message); }
      ok('GRUPOS: B entra pelo código', entrou === gid, String(entrou));
      await jsB(`window.__bigasEstado.abrirGrupo(${JSON.stringify(gid)}); true`);
      const membrosB = await esperarAte(() => jsB(`(function(){ var t = [...document.querySelectorAll('#membros .nome')].map(e => e.textContent); return t.length === 2 ? t.join('|') : null; })()`), 12000, 300);
      ok('GRUPOS: B vê os dois membros (A como dono)', /teste_bigas_a/.test(membrosB || '') && /teste_bigas_b/.test(membrosB || ''), membrosB);
      const donoB = await jsB(`(function(){ return [...document.querySelectorAll('#membros .estado')].map(e => e.textContent).join('|'); })()`);
      ok('GRUPOS: B vê quem é o dono', /dono/.test(donoB || ''), donoB);
      // chat no #geral
      const textoG = 'no grupo ' + Date.now();
      await jsA(`(function(){ var c = [...document.querySelectorAll('#canais .canal')].find(e => /^#geral$/.test(e.textContent)); if (c) c.click(); })(); true`);
      await esperarAte(() => jsA(`document.getElementById('sec-chat').classList.contains('mostra') && /geral/.test(document.getElementById('chat-nick').textContent) ? 'ok' : null`), 5000, 200);
      await jsA(`document.getElementById('chat-texto').value = ${JSON.stringify(textoG)}; document.getElementById('btn-enviar').click(); true`);
      await jsB(`(function(){ var c = [...document.querySelectorAll('#canais .canal')].find(e => /^#geral$/.test(e.textContent)); if (c) c.click(); })(); true`);
      const chegouG = await esperarAte(() => jsB(`(function(){ var m = [...document.querySelectorAll('#mensagens .msg')].find(e => e.textContent.includes(${JSON.stringify(textoG)})); return m ? (m.querySelector('.quem') || {}).textContent || 'sem nome' : null; })()`), 15000, 300);
      ok('GRUPOS: mensagem no #geral chega em B com o nome de quem escreveu', chegouG === 'teste_bigas_a', chegouG);
      await jsA(`document.getElementById('btn-fechar-chat').click(); true`);
      await jsB(`document.getElementById('btn-fechar-chat').click(); true`);
      // A entra no canal de voz (sala fixa do canal, sozinho): vira "conectado", B vê A dentro do canal
      await jsA(`(function(){ var c = document.querySelector('#canais .canal-voz'); if (c) c.click(); })(); true`);
      const noCanal = await esperarAte(() => jsA(`(function(){ var c = window.__bigasEstado.call; return c.estado === 'conectada' && c.grupo === ${JSON.stringify(gid)} ? document.getElementById('call-sub').textContent : null; })()`), 40000, 400);
      ok('GRUPOS: A entra no canal de voz e fica "conectado" mesmo sozinho', !!noCanal, noCanal);
      const dentroB = await esperarAte(() => jsB(`(function(){ var d = document.querySelector('#canais .dentro'); return d && /teste_bigas_a/.test(d.textContent) ? d.textContent : null; })()`), 15000, 400);
      ok('GRUPOS: B vê A dentro do canal de voz', !!dentroB, dentroB);
      // (no canal a tela da call abre na hora; o texto de entrada só importa enquanto ela não abriu)
      const estadoView = janelaA.contentView.children[0] ? await janelaA.contentView.children[0].webContents.executeJavaScript(`document.getElementById('entrada').hidden ? 'tela da call aberta' : document.getElementById('sala-txt').textContent`).catch(() => '') : 'sem view';
      ok('GRUPOS: dentro do canal nada fala em "chamando" (tela da call aberta ou texto de canal)', estadoView === 'tela da call aberta' || (/canal/.test(estadoView) && !/chamando/.test(estadoView)), estadoView);
      // sozinho no canal a tela da call já aparece, com o botão de transmitir liberado
      const sozinho = janelaA.contentView.children[0] ? await esperarAte(() => janelaA.contentView.children[0].webContents.executeJavaScript(`(function(){ var b = document.getElementById('btn-tela'); return !document.getElementById('chamada').hidden && b && !b.disabled ? 'ok' : null; })()`).catch(() => null), 8000, 300) : null;
      ok('GRUPOS: sozinho no canal já dá pra transmitir a tela (botão liberado)', sozinho === 'ok');
      await jsA(`document.getElementById('btn-sair-call').click(); true`);
      const saiu = await esperarAte(() => jsB(`(function(){ var d = document.querySelector('#canais .dentro'); return !d || !/teste_bigas_a/.test(d.textContent) ? 'ok' : null; })()`), 15000, 400);
      ok('GRUPOS: A sai do canal e some da lista de B', saiu === 'ok');
      // dono tira B; convida de volta por pedido; B aceita
      await jsA(`window.__bigasEstado.expulsar(${JSON.stringify(gid)}, ${JSON.stringify(uidB)})`);
      const foraB = await esperarAte(() => jsB(`!window.__bigasEstado.grupos.has(${JSON.stringify(gid)}) && document.getElementById('cab-grupo').hidden ? 'ok' : null`), 15000, 400);
      ok('GRUPOS: expulso, B perde o grupo do trilho (e a tela volta pros amigos)', foraB === 'ok');
      await jsA(`window.__bigasEstado.convidarParaGrupo(${JSON.stringify(uidB)}, ${JSON.stringify(NICK_B)})`);
      const conviteB = await esperarAte(() => jsB(`(function(){ var c = [...document.querySelectorAll('#pedidos .cartinha')].find(e => /convidou pro grupo/.test(e.textContent)); return c ? c.textContent : null; })()`), 15000, 300);
      ok('GRUPOS: B recebe o convite pro grupo como pedido', !!conviteB && conviteB.includes(nomeG), conviteB);
      await jsB(`(function(){ var c = [...document.querySelectorAll('#pedidos .cartinha')].find(e => /convidou pro grupo/.test(e.textContent)); if (c) c.querySelector('.sim').click(); })(); true`);
      const voltou = await esperarAte(() => jsB(`window.__bigasEstado.grupos.has(${JSON.stringify(gid)}) ? 'ok' : null`), 15000, 400);
      ok('GRUPOS: B aceita e volta pro grupo', voltou === 'ok');
      // apagar o grupo: some pros dois
      await jsA(`window.confirm = () => true; window.__bigasEstado.abrirGrupo(${JSON.stringify(gid)}); true`);
      await espera(500);
      await jsA(`window.__bigasEstado.apagarGrupo()`);
      const sumiu = await esperarAte(async () => (!(await jsA(`window.__bigasEstado.grupos.has(${JSON.stringify(gid)})`)) && !(await jsB(`window.__bigasEstado.grupos.has(${JSON.stringify(gid)})`))) ? 'ok' : null, 20000, 500);
      ok('GRUPOS: dono apaga o grupo → some pros dois', sumiu === 'ok');
    }
  }

  // bloqueio: B bloqueia A → A não consegue mais mandar mensagem (regra do servidor); B desbloqueia
  await jsB(`window.__bigasEstado.bloquear(${JSON.stringify(uidA)}, ${JSON.stringify(NICK_A)})`);
  await esperarAte(() => jsB(`window.__bigasEstado.bloqueados.has(${JSON.stringify(uidA)}) ? 'ok' : null`), 10000, 300);
  await jsA(`(function(){ var l = [...document.querySelectorAll('.amigo')].find(x => x.querySelector('.nome').textContent.trim().startsWith(${JSON.stringify(NICK_B)})); if (l) l.click(); })(); true`);
  await esperarAte(() => jsA(`document.getElementById('sec-chat').classList.contains('mostra') ? 'ok' : null`), 5000, 200);
  await jsA(`document.getElementById('chat-texto').value = 'bloqueado?'; document.getElementById('btn-enviar').click(); true`);
  const negado = await esperarAte(() => jsA(`/não são mais amigos|bloqueou/.test(document.getElementById('recado').textContent) ? 'ok' : null`), 15000, 300);
  ok('FIREBASE: bloqueado não consegue mandar mensagem (o servidor recusa)', negado === 'ok');
  await jsA(`document.getElementById('btn-fechar-chat').click(); true`);
  await jsB(`window.__bigasEstado.desbloquear(${JSON.stringify(uidA)})`);
  await esperarAte(() => jsB(`!window.__bigasEstado.bloqueados.has(${JSON.stringify(uidA)}) ? 'ok' : null`), 10000, 300);

  // desfazer: A tira B → B perde A também
  await jsA(`window.__bigasEstado.tirarAmigo(${JSON.stringify(uidB)}, ${JSON.stringify(NICK_B)})`);
  const desfez = await esperarAte(async () => (!(await temAmigo(jsA, uidB)) && !(await temAmigo(jsB, uidA))) ? 'ok' : null, 20000, 500);
  ok('FIREBASE: tirar da lista desfaz dos DOIS lados', desfez === 'ok');
  janelaB.destroy();
}

require('./main.js');

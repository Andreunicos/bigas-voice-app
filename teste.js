/* =====================================================================
 * TESTE MECÂNICO DO APLICATIVO — `npm test`
 * ---------------------------------------------------------------------
 * Roda o app de verdade com TODAS as janelas invisíveis (nada aparece na
 * tela) e dirige a casa por dentro: abre uma call, confere que o site foi
 * "vestido", faz um segundo participante invisível entrar pelo link e
 * conectar P2P, testa botão direito → menu de volume, mic/fone espelhados,
 * sair, entrar por convite, atalhos, e que fechar a janela encerra o app.
 *
 * Não usa Firebase (não loga): o que é conta/amigos/chat é testado à mão.
 *
 * Como funciona: rodado pelo Node, copia o app pra uma pasta temporária
 * (com este arquivo como "main") e abre o Electron nela. Dentro do
 * Electron, este mesmo arquivo vira o harness e depois carrega main.js.
 * ================================================================== */
const path = require('path');
const fs = require('fs');

const ARQUIVOS = ['main.js', 'preload.js', 'home.html', 'home.js', 'seletor-de-tela.html', 'seletor-de-tela.js', 'icone.png'];

if (!process.versions.electron) {
  /* ---------------- modo Node: prepara e dispara o Electron ---------------- */
  const os = require('os');
  const { spawnSync } = require('child_process');
  const raiz = __dirname;
  const pasta = path.join(os.tmpdir(), 'bigas-voice-teste');
  fs.rmSync(pasta, { recursive: true, force: true });
  fs.mkdirSync(pasta, { recursive: true });
  for (const a of ARQUIVOS) fs.copyFileSync(path.join(raiz, a), path.join(pasta, a));
  fs.copyFileSync(__filename, path.join(pasta, 'teste.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'teste.js' }));

  const exe = path.join(raiz, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = Object.assign({}, process.env, { BIGAS_APP_DIR: raiz });
  delete env.ELECTRON_RUN_AS_NODE; // se vier ligado do terminal, o Electron vira Node puro e nada funciona
  const r = spawnSync(exe, [pasta], { env, stdio: 'inherit', timeout: 240000 });
  process.exit(r.status == null ? 1 : r.status);
}

/* ---------------- modo Electron: o harness ---------------- */
const electron = require('electron');
const RealBW = electron.BrowserWindow;
const Module = require('module');
const APP_DIR = process.env.BIGAS_APP_DIR || __dirname;

class BWInvisivel extends RealBW {
  constructor(opts) { super(Object.assign({}, opts || {}, { show: false })); }
}
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
  ok('versao mostrada no login E na casa', /^v[\d.]+\|v[\d.]+$/.test(vers), vers);
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
    setTimeout(() => ipcMain.emit('seletor-de-tela:escolheu', {}, fontes[0] && fontes[0].id), 1500);
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
    const janelasAntes = electron.BaseWindow.getAllWindows().length;
    const cancelado = view.webContents.executeJavaScript(`
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ABRIU'; }, e => e.name)`, true);
    const seletor = await esperarAte(() => electron.BaseWindow.getAllWindows().find((w) => w !== janela && /Escolha o que compartilhar/.test(w.getTitle())) || null, 6000, 150);
    ok('seletor de tela abriu (invisível)', !!seletor);
    if (seletor) seletor.close();
    ok('cancelar o seletor recusa a captura (erro, não trava)', /NotAllowedError|AbortError/.test(String(await cancelado)), String(await cancelado));
    setTimeout(() => ipcMain.emit('seletor-de-tela:escolheu', {}, fontes[0] && fontes[0].id), 1500);
    const denovo = await Promise.race([
      view.webContents.executeJavaScript(`navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ABRIU'; }, e => e.name)`, true),
      espera(9000).then(() => 'TRAVOU'),
    ]);
    ok('transmitir de novo depois de cancelar FUNCIONA (sem ouvinte vazado)', denovo === 'ABRIU', denovo);

    // a lateral (chat/ajustes) abre → o palco encolhe → a view acompanha
    await js('document.getElementById("btn-ajustes").click(); true');
    await espera(500);
    const r2 = JSON.parse(await js('JSON.stringify(document.getElementById("palco").getBoundingClientRect())'));
    const vb2 = view.getBounds();
    ok('ajustes abertos ao lado: view encolheu junto com o palco', r2.width < r.width - 200 && Math.abs(vb2.width - Math.round(r2.width)) <= 1, vb2.width + ' vs ' + Math.round(r2.width));
    await js('document.getElementById("btn-fechar-ajustes").click(); true');
    await espera(300);

    // ===== DUAS PONTAS: um "amigo" entra pelo link numa janela invisível =====
    let avisoConectada = false;
    ipcMain.on('call:aviso', (ev, o) => { if (o === 'conectada') avisoConectada = true; });
    const amigo = new RealBW({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await amigo.loadURL(link);
    await amigo.webContents.executeJavaScript(`var n=document.getElementById('meu-nome'); n.value='Amigo2'; n.dispatchEvent(new Event('input',{bubbles:true})); true`).catch(() => {});
    const conectou = await esperarAte(() => view.webContents.executeJavaScript(
      `(function(){ var p=[...pares.values()][0]; return (p && p.conectado && !document.getElementById('chamada').hidden) ? JSON.stringify({nome:p.nome, n:pares.size}) : null; })()`), 40000, 400);
    ok('AMIGO CONECTOU na call do app (P2P de verdade)', !!conectou, conectou);
    await espera(600);
    ok('casa avisada que a call conectou', avisoConectada);
    ok('casa mostra "Em chamada"', /Em chamada/.test(await js('document.getElementById("call-titulo").textContent')));

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
  const avisosNormais = /favicon|ntfy|429|Failed to load resource|net::|perfil video|servidor entupido/i;
  ok('view sem erro de JS grave', errosView.filter((m) => !avisosNormais.test(m)).length === 0, errosView.join(' | ').slice(0, 400));
  ok('home sem erro de JS ate o fim', errosHome.filter((m) => !/favicon/i.test(m)).length === 0, errosHome.join(' | ').slice(0, 400));

  // fechar a janela tem que ENCERRAR o app (nada em segundo plano)
  let encerrou = false;
  app.on('will-quit', () => { if (!encerrou) { encerrou = true; ok('fechar a janela encerra o app (sem segundo plano)', true); const f = imprimir(); app.exit(f ? 1 : 0); } });
  janela.close();
  setTimeout(() => { if (!encerrou) { encerrou = true; ok('fechar a janela encerra o app (sem segundo plano)', false, 'processo continuou vivo'); imprimir(); app.exit(1); } }, 3000);
});

require('./main.js');

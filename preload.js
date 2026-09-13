/* Ponte mínima e segura entre as páginas e o processo principal.
   contextIsolation está ligado (é o certo, por segurança) — nada além do
   que é explicitamente exposto aqui chega até a página. Este mesmo
   preload serve três páginas diferentes; cada uma só usa a parte dela:
     - home.html              → bigasHome
     - o site, dentro da call → bigasApp
     - seletor-de-tela.html   → bigasSeletor */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bigasHome', {
  // call
  iniciarCall:   (nick, comQuem)       => ipcRenderer.invoke('call:iniciar', nick, comQuem),
  entrarComLink: (link, nick, comQuem) => ipcRenderer.invoke('call:entrar', link, nick, comQuem),
  sairDaCall:    ()  => ipcRenderer.send('call:sair'),
  mic:           ()  => ipcRenderer.send('call:mic'),
  surdo:         ()  => ipcRenderer.send('call:surdo'),
  aoMudarCall:      (funcao) => { ipcRenderer.on('call:estado', (_ev, dados) => funcao(dados)); },
  aoMudarControles: (funcao) => { ipcRenderer.on('call:controles', (_ev, dados) => funcao(dados)); },
  palcoMudou:    (rect) => ipcRenderer.send('palco:rect', rect),

  // avisos pro sistema
  tocar:     (ligado, quem)    => ipcRenderer.send('tocar', !!ligado, String(quem || '')),
  notificar: (titulo, texto)   => ipcRenderer.send('notificar', String(titulo || ''), String(texto || '')),

  // app
  versao:       ()         => ipcRenderer.invoke('app:versao'),
  configLer:    ()         => ipcRenderer.invoke('config:ler'),
  configMudar:  (mudancas) => ipcRenderer.invoke('config:mudar', mudancas),
  verificarAtualizacao: () => ipcRenderer.send('atualizar:verificar'),
  instalarAtualizacao:  () => ipcRenderer.send('atualizar:instalar'),
  aoMudarEstadoAtualizacao: (funcao) => {
    ipcRenderer.on('atualizar:estado', (_ev, dados) => funcao(dados));
  },
});

contextBridge.exposeInMainWorld('bigasApp', {
  sairDaCall: ()  => ipcRenderer.send('call:sair'),
  avisar:     (o) => ipcRenderer.send('call:aviso', String(o || '')),
});

contextBridge.exposeInMainWorld('bigasSeletor', {
  aoReceberFontes: (funcao) => {
    ipcRenderer.on('seletor-de-tela:fontes', (_ev, lista) => funcao(lista));
  },
  escolher: (id) => ipcRenderer.send('seletor-de-tela:escolheu', id),
});

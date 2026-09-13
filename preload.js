/* Ponte mínima e segura entre as páginas e o processo principal.
   contextIsolation está ligado (é o certo, por segurança) — nada além do
   que é explicitamente exposto aqui chega até a página. Este mesmo
   preload serve três páginas diferentes; cada uma só usa a parte dela:
     - home.html            → bigasHome
     - o site, dentro da call → bigasApp
     - seletor-de-tela.html → bigasSeletor */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bigasHome', {
  iniciarCall:   (nick, comQuem)       => ipcRenderer.invoke('call:iniciar', nick, comQuem),
  entrarComLink: (link, nick, comQuem) => ipcRenderer.invoke('call:entrar', link, nick, comQuem),
  sairDaCall:    ()           => ipcRenderer.send('call:sair'),
  aoMudarCall:   (funcao)     => { ipcRenderer.on('call:estado', (_ev, dados) => funcao(dados)); },
  painelMudou:   (rect)       => ipcRenderer.send('painel:rect', rect),
  versao:        ()           => ipcRenderer.invoke('app:versao'),

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

/* Ponte mínima e segura entre a janela do seletor de tela e o processo
 * principal. contextIsolation está ligado (é o certo, por segurança), então
 * a página não pode falar com o Electron sozinha — só pelo que é
 * explicitamente exposto aqui, e nada além disso. */
const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('bigasSeletor', {
  aoReceberFontes: (funcao) => {
    ipcRenderer.on('seletor-de-tela:fontes', (_ev, lista) => funcao(lista));
  },
  escolher: (id) => ipcRenderer.send('seletor-de-tela:escolheu', id),
});

contextBridge.exposeInMainWorld('bigasColarLink', {
  // devolve true/false na hora — quem decide se o link é válido é o
  // processo principal (só ele conhece a origem oficial do site)
  entrar: (url) => ipcRenderer.sendSync('colar-link:entrar', url),
  pegarDaAreaDeTransferencia: () => Promise.resolve(clipboard.readText()),
});

// usado só pela janela principal (o site de verdade, carregado da internet)
// — o botão flutuante de "entrar com um link" chama isto.
contextBridge.exposeInMainWorld('bigasApp', {
  abrirColarLink: () => ipcRenderer.send('colar-link:abrir'),
});

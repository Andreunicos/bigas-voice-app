/* Ponte mínima e segura entre a janela do seletor de tela e o processo
 * principal. contextIsolation está ligado (é o certo, por segurança), então
 * a página não pode falar com o Electron sozinha — só pelo que é
 * explicitamente exposto aqui, e nada além disso. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bigasSeletor', {
  aoReceberFontes: (funcao) => {
    ipcRenderer.on('seletor-de-tela:fontes', (_ev, lista) => funcao(lista));
  },
  escolher: (id) => ipcRenderer.send('seletor-de-tela:escolheu', id),
});

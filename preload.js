/* Ponte mínima e segura entre as janelas do app e o processo principal.
   contextIsolation está ligado (é o certo, por segurança) — nada além do
   que é explicitamente exposto aqui chega até a página. Este preload
   serve tanto a janela principal (home OU o site de verdade, dependendo
   do momento) quanto a janela do seletor de tela — cada uma só usa a
   parte que faz sentido pra ela; o resto fica parado, sem problema. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bigasSeletor', {
  aoReceberFontes: (funcao) => {
    ipcRenderer.on('seletor-de-tela:fontes', (_ev, lista) => funcao(lista));
  },
  escolher: (id) => ipcRenderer.send('seletor-de-tela:escolheu', id),
});

// usado pela HOME (home.html): chamar um amigo e aceitar um convite
contextBridge.exposeInMainWorld('bigasHome', {
  iniciarCall: () => ipcRenderer.invoke('call:iniciar'),
  entrarComLink: (link) => ipcRenderer.send('call:entrar', link),
});

// usado só quando a janela principal está DENTRO de uma call (o site de
// verdade carregado) — os botões flutuantes injetados chamam isto
contextBridge.exposeInMainWorld('bigasApp', {
  voltarParaAmigos: () => ipcRenderer.send('call:sair'),
  verificarAtualizacao: () => ipcRenderer.send('atualizar:verificar'),
  instalarAtualizacao: () => ipcRenderer.send('atualizar:instalar'),
  aoMudarEstadoAtualizacao: (funcao) => {
    ipcRenderer.on('atualizar:estado', (_ev, dados) => funcao(dados));
  },
});

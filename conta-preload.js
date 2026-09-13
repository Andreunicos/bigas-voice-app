const { contextBridge, ipcRenderer } = require('electron');

/* A janela de conta não fala com a janela principal diretamente — os dois
   são processos isolados. Tudo passa pelo processo principal, que sabe
   como pedir pro site (rodando na janela principal) gerar um link de
   verdade, e como navegar até um link recebido. */
contextBridge.exposeInMainWorld('bigasConta', {
  gerarLinkDeConvite: () => ipcRenderer.invoke('conta:gerar-link'),
  entrarComLink: (link) => ipcRenderer.send('colar-link:entrar-silencioso', link),
});

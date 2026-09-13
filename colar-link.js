const campo = document.getElementById('link');
const erro = document.getElementById('erro');

document.getElementById('cancelar').onclick = () => window.close();

function tentarEntrar(){
  const valor = campo.value.trim();
  if (!valor) { erro.textContent = 'Cola o link primeiro.'; return; }
  const ok = window.bigasColarLink.entrar(valor);
  if (!ok) erro.textContent = 'Isso não parece um link do Bigas Voice. Confere se copiou certo.';
}

document.getElementById('entrar').onclick = tentarEntrar;
campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') tentarEntrar(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

// cola automaticamente o que já estiver na área de transferência, pra
// poupar um clique de quem já copiou o link antes de abrir isto aqui
window.bigasColarLink.pegarDaAreaDeTransferencia().then((texto) => {
  if (texto && texto.includes('andreunicos.github.io')) campo.value = texto;
});

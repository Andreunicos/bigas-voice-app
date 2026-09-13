window.bigasSeletor.aoReceberFontes((lista) => {
  const grade = document.getElementById('grade');
  grade.innerHTML = '';
  if (!lista.length) {
    grade.innerHTML = '<p class="vazio">Nenhuma tela ou janela encontrada.</p>';
    return;
  }
  for (const fonte of lista) {
    const botao = document.createElement('button');
    botao.className = 'item';
    botao.type = 'button';
    botao.innerHTML =
      '<img src="' + fonte.miniatura + '" alt="">' +
      '<span>' + (fonte.ehTela ? '🖥️ ' : '🪟 ') + escaparHtml(fonte.nome) + '</span>';
    botao.onclick = () => window.bigasSeletor.escolher(fonte.id);
    grade.appendChild(botao);
  }
});

function escaparHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

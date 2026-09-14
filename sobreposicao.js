/* A sobreposição só desenha o que o app manda: a lista de quem está na
   call, com "falando" e "mudo". Nada de lógica aqui. */
const caixa = document.getElementById('gente');
function iniciais(n){ return String(n || '?').slice(0, 2).toUpperCase(); }

window.bigasSobreposicao.aoReceberGente((gente) => {
  caixa.innerHTML = '';
  (gente || []).forEach((p) => {
    const f = document.createElement('div');
    f.className = 'ficha' + (p.falando ? ' fala' : '') + (p.mudo ? ' calado' : '') + (p.eu ? ' eu' : '');
    const av = document.createElement('div'); av.className = 'av'; av.textContent = iniciais(p.nome);
    const nome = document.createElement('span'); nome.className = 'nome'; nome.textContent = p.nome || '…';
    f.append(av, nome);
    if (p.mudo) { const m = document.createElement('span'); m.className = 'marca'; m.textContent = '🔇'; f.appendChild(m); }
    else if (p.tela) { const m = document.createElement('span'); m.className = 'marca'; m.textContent = '🖥'; f.appendChild(m); }
    caixa.appendChild(f);
  });
});

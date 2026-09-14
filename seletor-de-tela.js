/* A tela de Transmitir: o que compartilhar, em que qualidade/fps, com ou sem
   som. Devolve pro app { id, qualidade, som } — o app entrega a fonte pro
   site e aplica qualidade e som assim que a captura existir. */
const $ = (id) => document.getElementById(id);

// as chaves são os perfis do PRÓPRIO site (PERFIS), pra valer lá dentro
const QUALIDADES = [
  { id: 'auto',        titulo: 'Automático',        sub: 'Mede sua máquina e escolhe. Recomendado.' },
  { id: '1080-60-8',   titulo: '1080p · 60 fps',    sub: 'Jogo rápido, monitor 1080p. ~8 Mbps.' },
  { id: '1080-30-5',   titulo: '1080p · 30 fps',    sub: 'Nítido, gasta menos. ~5 Mbps.' },
  { id: '1440-60-14',  titulo: '1440p · 60 fps',    sub: 'Só com placa e internet fortes. ~14 Mbps.' },
  { id: '720-30-3',    titulo: '720p · 30 fps',     sub: 'Internet fraca. ~3 Mbps.' },
  { id: '480-120-5',   titulo: '480p · 120 fps',    sub: 'Fluidez acima de tudo, imagem pequena.' },
];

let fontes = [];
let aba = 'telas';
let escolhida = null;
let qualidade = 'auto';
let som = true;

function pintarFontes(){
  const caixa = $('fontes');
  caixa.innerHTML = '';
  const lista = fontes.filter((f) => aba === 'telas' ? f.ehTela : !f.ehTela);
  if (!lista.length) {
    caixa.innerHTML = '<p class="vazio">' + (aba === 'telas' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta pra mostrar.') + '</p>';
    return;
  }
  lista.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fonte' + (escolhida === f.id ? ' escolhida' : '');
    const quadro = document.createElement('div'); quadro.className = 'quadro';
    const img = document.createElement('img'); img.src = f.miniatura; img.alt = '';
    const check = document.createElement('div'); check.className = 'check'; check.textContent = '✓';
    quadro.append(img, check);
    const nome = document.createElement('div'); nome.className = 'nome';
    if (f.icone) { const ic = document.createElement('img'); ic.src = f.icone; ic.alt = ''; nome.appendChild(ic); }
    const sp = document.createElement('span'); sp.textContent = f.ehTela ? ('Tela ' + (i + 1) + (lista.length > 1 ? '' : ' (inteira)')) : f.nome; sp.title = f.nome;
    nome.appendChild(sp);
    b.append(quadro, nome);
    b.onclick = () => { escolhida = f.id; pintarFontes(); pintarResumo(); };
    b.ondblclick = () => { escolhida = f.id; transmitir(); };
    caixa.appendChild(b);
  });
}

function pintarQualidades(){
  const caixa = $('qualidades'); caixa.innerHTML = '';
  QUALIDADES.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'opcao' + (qualidade === q.id ? ' escolhida' : '');
    const bola = document.createElement('span'); bola.className = 'bola';
    const txt = document.createElement('div');
    const t = document.createElement('b'); t.textContent = q.titulo;
    const s = document.createElement('small'); s.textContent = q.sub;
    txt.append(t, s);
    b.append(bola, txt);
    b.onclick = () => { qualidade = q.id; pintarQualidades(); pintarResumo(); };
    caixa.appendChild(b);
  });
}

function pintarResumo(){
  const f = fontes.find((x) => x.id === escolhida);
  const q = QUALIDADES.find((x) => x.id === qualidade) || QUALIDADES[0];
  $('btn-ir').disabled = !f;
  $('resumo').textContent = f
    ? (f.ehTela ? 'Tela inteira' : f.nome) + ' · ' + q.titulo + (som ? ' · com som' : ' · sem som')
    : 'Escolhe uma tela ou janela.';
}

function transmitir(){
  if (!escolhida) return;
  $('btn-ir').disabled = true;
  window.bigasSeletor.escolher({ id: escolhida, qualidade, som });
}

$('aba-telas').onclick = () => { aba = 'telas'; $('aba-telas').classList.add('ativa'); $('aba-janelas').classList.remove('ativa'); pintarFontes(); };
$('aba-janelas').onclick = () => { aba = 'janelas'; $('aba-janelas').classList.add('ativa'); $('aba-telas').classList.remove('ativa'); pintarFontes(); };
$('chave-som').onclick = () => { som = !som; $('chave-som').classList.toggle('on', som); pintarResumo(); };
$('btn-ir').onclick = transmitir;
$('btn-cancelar').onclick = () => window.bigasSeletor.escolher(null);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.bigasSeletor.escolher(null);
  if (e.key === 'Enter' && escolhida) transmitir();
});

window.bigasSeletor.aoReceberFontes((dados) => {
  // aceita tanto o formato novo ({lista, qualidade, som}) quanto uma lista pura
  const d = Array.isArray(dados) ? { lista: dados } : (dados || {});
  fontes = d.lista || [];
  if (d.qualidade && QUALIDADES.some((q) => q.id === d.qualidade)) qualidade = d.qualidade;
  som = d.som !== false;
  $('chave-som').classList.toggle('on', som);
  // a tela inteira já vem escolhida: é o caso comum e o que funciona melhor com jogo
  const tela = fontes.find((f) => f.ehTela);
  if (tela && !escolhida) escolhida = tela.id;
  pintarQualidades(); pintarFontes(); pintarResumo();
});

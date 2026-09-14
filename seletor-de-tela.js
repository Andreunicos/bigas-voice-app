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
let apps = [];          // processos com sessão de som (o app lista pelo Windows)
let pidsJanela = {};    // id da janela → pid (pra pré-escolher o som daquele app)
let somDe = 'pc';       // 'pc' (saída padrão inteira) | pid (só aquele app, em qualquer saída)
let somDeManual = false; // a pessoa escolheu na mão: não trocar sozinho ao clicar noutra fonte

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
    // o app já manda o nome de verdade do monitor (modelo · resolução · principal)
    const sp = document.createElement('span'); sp.textContent = f.nome || ('Tela ' + (i + 1)); sp.title = f.nome;
    nome.appendChild(sp);
    b.append(quadro, nome);
    b.onclick = () => { escolhida = f.id; sugerirSom(); pintarFontes(); pintarSom(); pintarResumo(); };
    b.ondblclick = () => { escolhida = f.id; sugerirSom(); transmitir(); };
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

// janela de um app que tem som → o som passa a ser só daquele app
function sugerirSom(){
  if (somDeManual) return;
  const pid = pidsJanela[escolhida];
  somDe = (pid && apps.some((a) => a.pid === pid)) ? pid : 'pc';
}
function nomeDoApp(a){
  const exe = a.exe.replace(/\.exe$/i, '');
  return (a.titulo ? a.titulo.slice(0, 40) + ' (' + exe + ')' : exe) + (a.tocando ? ' · tocando agora' : '');
}
function pintarSom(){
  const sel = $('sel-som');
  sel.innerHTML = '';
  const pc = document.createElement('option'); pc.value = 'pc'; pc.textContent = 'Tudo o que toca na saída padrão'; sel.appendChild(pc);
  apps.forEach((a) => { const o = document.createElement('option'); o.value = String(a.pid); o.textContent = 'Só ' + nomeDoApp(a); sel.appendChild(o); });
  sel.value = String(somDe);
  if (sel.value !== String(somDe)) { somDe = 'pc'; sel.value = 'pc'; }
  $('linha-som-de').hidden = !som;
  $('sem-apps').hidden = !som || apps.length > 0;
}
function pintarResumo(){
  const f = fontes.find((x) => x.id === escolhida);
  const q = QUALIDADES.find((x) => x.id === qualidade) || QUALIDADES[0];
  const a = apps.find((x) => String(x.pid) === String(somDe));
  $('btn-ir').disabled = !f;
  $('resumo').textContent = f
    ? (f.ehTela ? f.nome : f.nome) + ' · ' + q.titulo + (som ? (a ? ' · som só do ' + a.exe.replace(/\.exe$/i, '') : ' · com som') : ' · sem som')
    : 'Escolhe uma tela ou janela.';
}

function transmitir(){
  if (!escolhida) return;
  $('btn-ir').disabled = true;
  window.bigasSeletor.escolher({ id: escolhida, qualidade, som, somDe: som ? somDe : 'pc' });
}

$('aba-telas').onclick = () => { aba = 'telas'; $('aba-telas').classList.add('ativa'); $('aba-janelas').classList.remove('ativa'); pintarFontes(); };
$('aba-janelas').onclick = () => { aba = 'janelas'; $('aba-janelas').classList.add('ativa'); $('aba-telas').classList.remove('ativa'); pintarFontes(); };
$('chave-som').onclick = () => { som = !som; $('chave-som').classList.toggle('on', som); pintarSom(); pintarResumo(); };
$('sel-som').onchange = () => { somDe = $('sel-som').value === 'pc' ? 'pc' : Number($('sel-som').value); somDeManual = true; pintarResumo(); };
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
  apps = Array.isArray(d.apps) ? d.apps : [];
  pidsJanela = d.pidsJanela || {};
  $('chave-som').classList.toggle('on', som);
  // a tela inteira já vem escolhida: é o caso comum e o que funciona melhor com jogo
  const tela = fontes.find((f) => f.ehTela);
  if (tela && !escolhida) escolhida = tela.id;
  sugerirSom();
  pintarQualidades(); pintarFontes(); pintarSom(); pintarResumo();
});

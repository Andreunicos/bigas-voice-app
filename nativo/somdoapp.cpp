/* somdoapp — o som de UM aplicativo só (Windows 10 2004+ / Windows 11).
 *
 * É o "loopback por processo" do WASAPI: em vez de gravar tudo o que sai
 * na caixa de som (Spotify, notificação, a voz dos amigos…), pega só o que
 * o processo escolhido (e os filhos dele) está tocando — em qualquer
 * saída de som. Resolve o "meu amigo não ouve o jogo" quando o jogo toca
 * numa saída que não é a padrão, e nunca manda de volta a voz de ninguém.
 *
 * Uso:
 *   somdoapp lista            → uma linha por processo com sessão de som:
 *                               pid <TAB> executavel <TAB> titulo <TAB> 1|0 (tocando agora)
 *   somdoapp janela <hwnd>    → pid dono da janela
 *   somdoapp janelas <h1,h2,…> → uma linha "hwnd<TAB>pid" por janela
 *   somdoapp <pid>            → escreve na saída padrão float32 48 kHz
 *                               estéreo intercalado, sem cabeçalho, até a
 *                               entrada padrão fechar (o app morreu)
 *   somdoapp mix [--semexe a.exe,b.exe] [--semarvore pid,pid]
 *                             → TUDO que toca no PC (em qualquer saída), MENOS
 *                               os programas listados (Discord…) e as árvores
 *                               de processo listadas (o próprio Bigas Voice):
 *                               abre um loopback por processo pra cada app com
 *                               som e mistura. Novos apps entram sozinhos.
 *
 * Compilar (VS 2022, prompt x64):  cl /O2 /W3 /EHsc somdoapp.cpp
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <vector>
#include <set>
#include <map>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "user32.lib")

using namespace Microsoft::WRL;

static std::string utf8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), NULL, 0, NULL, NULL);
  std::string s(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, NULL, NULL);
  return s;
}

static std::wstring exeDoProcesso(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return L"";
  wchar_t caminho[MAX_PATH * 2]; DWORD n = MAX_PATH * 2;
  std::wstring r;
  if (QueryFullProcessImageNameW(h, 0, caminho, &n)) {
    r = caminho;
    size_t b = r.find_last_of(L"\\/");
    if (b != std::wstring::npos) r = r.substr(b + 1);
  }
  CloseHandle(h);
  return r;
}

struct BuscaJanela { DWORD pid; std::wstring titulo; };
static BOOL CALLBACK acharJanela(HWND h, LPARAM lp) {
  BuscaJanela* b = (BuscaJanela*)lp;
  DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
  if (pid != b->pid || !IsWindowVisible(h) || GetWindow(h, GW_OWNER)) return TRUE;
  wchar_t t[256]; int n = GetWindowTextW(h, t, 256);
  if (n > 0) { b->titulo.assign(t, n); return FALSE; }
  return TRUE;
}
#include <tlhelp32.h>
static DWORD paiDoProcesso(DWORD pid) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W e; e.dwSize = sizeof e; DWORD pai = 0;
  if (Process32FirstW(snap, &e)) do { if (e.th32ProcessID == pid) { pai = e.th32ParentProcessID; break; } } while (Process32NextW(snap, &e));
  CloseHandle(snap);
  return pai;
}
/* o título da janela: do próprio processo ou, se ele não tem janela (apps
   feitos em Chromium tocam som num processo filho), do pai com o mesmo exe */
static std::wstring tituloDoProcesso(DWORD pid) {
  std::wstring exe = exeDoProcesso(pid);
  DWORD atual = pid;
  for (int i = 0; i < 4 && atual; i++) {
    BuscaJanela b{ atual, L"" };
    EnumWindows(acharJanela, (LPARAM)&b);
    if (!b.titulo.empty()) return b.titulo;
    DWORD pai = paiDoProcesso(atual);
    if (!pai || _wcsicmp(exeDoProcesso(pai).c_str(), exe.c_str()) != 0) break;
    atual = pai;
  }
  return L"";
}

/* ---- lista: quem está com sessão de som em QUALQUER saída ---- */
static int listar() {
  ComPtr<IMMDeviceEnumerator> en;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL, IID_PPV_ARGS(&en)))) { printf("erro: enumerador\n"); return 1; }
  ComPtr<IMMDeviceCollection> col;
  if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) { printf("erro: saidas\n"); return 1; }
  UINT n = 0; col->GetCount(&n);
  std::set<DWORD> vistos;
  DWORD eu = GetCurrentProcessId();
  for (UINT i = 0; i < n; i++) {
    ComPtr<IMMDevice> dev; if (FAILED(col->Item(i, &dev))) continue;
    ComPtr<IAudioSessionManager2> ger;
    if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, NULL, &ger))) continue;
    ComPtr<IAudioSessionEnumerator> se; if (FAILED(ger->GetSessionEnumerator(&se))) continue;
    int c = 0; se->GetCount(&c);
    for (int j = 0; j < c; j++) {
      ComPtr<IAudioSessionControl> s; if (FAILED(se->GetSession(j, &s))) continue;
      ComPtr<IAudioSessionControl2> s2; if (FAILED(s.As(&s2))) continue;
      if (s2->IsSystemSoundsSession() == S_OK) continue;
      DWORD pid = 0; s2->GetProcessId(&pid);
      if (!pid || pid == eu || vistos.count(pid)) continue;
      AudioSessionState st = AudioSessionStateInactive; s->GetState(&st);
      if (st == AudioSessionStateExpired) continue;
      vistos.insert(pid);
      std::wstring exe = exeDoProcesso(pid);
      if (exe.empty()) continue;
      printf("%lu\t%s\t%s\t%d\n", (unsigned long)pid, utf8(exe).c_str(), utf8(tituloDoProcesso(pid)).c_str(), st == AudioSessionStateActive ? 1 : 0);
    }
  }
  return 0;
}

/* ---- captura: loopback do processo (e filhos) ---- */
class Concluido : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
  HANDLE ev = NULL; HRESULT hr = E_FAIL; ComPtr<IAudioClient> cliente;
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) {
    HRESULT hrAct = E_FAIL; ComPtr<IUnknown> u;
    op->GetActivateResult(&hrAct, &u);
    if (SUCCEEDED(hrAct) && u) hrAct = u.As(&cliente);
    hr = hrAct; SetEvent(ev); return S_OK;
  }
};

static volatile LONG g_sair = 0;
static DWORD WINAPI vigiarEntrada(LPVOID) {
  char l[64];
  while (fgets(l, sizeof l, stdin)) { if (strncmp(l, "sai", 3) == 0) break; }
  InterlockedExchange(&g_sair, 1);
  return 0;
}

static int capturar(DWORD pid) {
  AUDIOCLIENT_ACTIVATION_PARAMS p = {};
  p.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  p.ProcessLoopbackParams.TargetProcessId = pid;
  p.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv; PropVariantInit(&pv);
  pv.vt = VT_BLOB; pv.blob.cbSize = sizeof p; pv.blob.pBlobData = (BYTE*)&p;

  ComPtr<Concluido> fim = Make<Concluido>();
  fim->ev = CreateEventW(NULL, TRUE, FALSE, NULL);
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, fim.Get(), &op);
  if (FAILED(hr)) { fprintf(stderr, "erro: ativar 0x%08lx\n", (unsigned long)hr); return 1; }
  WaitForSingleObject(fim->ev, 5000);
  if (FAILED(fim->hr) || !fim->cliente) { fprintf(stderr, "erro: loopback por processo indisponivel 0x%08lx (Windows 10 2004+)\n", (unsigned long)fim->hr); return 1; }

  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; fmt.nChannels = 2; fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 32; fmt.nBlockAlign = 8; fmt.nAvgBytesPerSec = 48000 * 8;
  hr = fim->cliente->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 200000, 0, &fmt, NULL);
  if (FAILED(hr)) { fprintf(stderr, "erro: initialize 0x%08lx\n", (unsigned long)hr); return 1; }
  HANDLE evDados = CreateEventW(NULL, FALSE, FALSE, NULL);
  fim->cliente->SetEventHandle(evDados);
  ComPtr<IAudioCaptureClient> cap;
  if (FAILED(fim->cliente->GetService(IID_PPV_ARGS(&cap)))) { fprintf(stderr, "erro: capture client\n"); return 1; }
  if (FAILED(fim->cliente->Start())) { fprintf(stderr, "erro: start\n"); return 1; }

  _setmode(_fileno(stdout), _O_BINARY);
  CreateThread(NULL, 0, vigiarEntrada, NULL, 0, NULL);
  fprintf(stderr, "pronto\n"); fflush(stderr);

  std::vector<float> zeros;
  while (!g_sair) {
    WaitForSingleObject(evDados, 200);
    UINT32 prox = 0;
    while (!g_sair && SUCCEEDED(cap->GetNextPacketSize(&prox)) && prox > 0) {
      BYTE* dados = NULL; UINT32 quadros = 0; DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&dados, &quadros, &flags, NULL, NULL))) break;
      if (quadros) {
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          if (zeros.size() < quadros * 2) zeros.assign(quadros * 2, 0.f);
          fwrite(zeros.data(), 8, quadros, stdout);
        } else fwrite(dados, 8, quadros, stdout);
        fflush(stdout);
      }
      cap->ReleaseBuffer(quadros);
    }
    // o processo alvo morreu: a captura fica muda pra sempre — o app percebe pelo fim do fluxo
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) break;
    DWORD codigo = 0; BOOL vivo = GetExitCodeProcess(h, &codigo) && codigo == STILL_ACTIVE; CloseHandle(h);
    if (!vivo) break;
  }
  fim->cliente->Stop();
  return 0;
}

/* ---- mix: tudo menos X — um loopback por app, misturados ---- */
struct Fluxo {
  DWORD pid = 0;
  ComPtr<IAudioClient> cli;
  ComPtr<IAudioCaptureClient> cap;
  std::vector<float> fila;   // intercalado L R
  bool morto = false;
};

static bool abrirLoopback(DWORD pid, ComPtr<IAudioClient>& cli, ComPtr<IAudioCaptureClient>& cap) {
  AUDIOCLIENT_ACTIVATION_PARAMS p = {};
  p.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  p.ProcessLoopbackParams.TargetProcessId = pid;
  p.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv; PropVariantInit(&pv);
  pv.vt = VT_BLOB; pv.blob.cbSize = sizeof p; pv.blob.pBlobData = (BYTE*)&p;
  ComPtr<Concluido> fim = Make<Concluido>();
  fim->ev = CreateEventW(NULL, TRUE, FALSE, NULL);
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  if (FAILED(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, fim.Get(), &op))) { CloseHandle(fim->ev); return false; }
  WaitForSingleObject(fim->ev, 3000);
  CloseHandle(fim->ev);
  if (FAILED(fim->hr) || !fim->cliente) return false;
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; fmt.nChannels = 2; fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 32; fmt.nBlockAlign = 8; fmt.nAvgBytesPerSec = 48000 * 8;
  if (FAILED(fim->cliente->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200000, 0, &fmt, NULL))) return false;
  if (FAILED(fim->cliente->GetService(IID_PPV_ARGS(&cap)))) return false;
  if (FAILED(fim->cliente->Start())) return false;
  cli = fim->cliente;
  return true;
}

static bool processoVivo(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return false;
  DWORD c = 0; BOOL ok = GetExitCodeProcess(h, &c) && c == STILL_ACTIVE; CloseHandle(h);
  return ok != 0;
}

static std::wstring minusc(std::wstring w) { for (auto& c : w) c = (wchar_t)towlower(c); return w; }

static int misturar(const std::set<std::wstring>& semExe, const std::set<DWORD>& semArvore) {
  ComPtr<IMMDeviceEnumerator> en;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL, IID_PPV_ARGS(&en)))) { fprintf(stderr, "erro: enumerador\n"); return 1; }
  _setmode(_fileno(stdout), _O_BINARY);
  CreateThread(NULL, 0, vigiarEntrada, NULL, 0, NULL);
  fprintf(stderr, "pronto\n"); fflush(stderr);

  std::vector<Fluxo> fluxos;
  std::set<DWORD> recusados;           // pids que não abriram (não insiste a cada volta)
  DWORD eu = GetCurrentProcessId();
  LARGE_INTEGER freq, t0; QueryPerformanceFrequency(&freq); QueryPerformanceCounter(&t0);
  unsigned long long escritos = 0;
  ULONGLONG ultimaVarredura = 0;
  std::vector<float> saida;

  while (!g_sair) {
    ULONGLONG agora = GetTickCount64();
    if (agora - ultimaVarredura >= 2000) {
      ultimaVarredura = agora;
      // mapa pid → pai (uma foto só) e exe por pid
      std::map<DWORD, DWORD> pai;
      HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (snap != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W e; e.dwSize = sizeof e;
        if (Process32FirstW(snap, &e)) do { pai[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32NextW(snap, &e));
        CloseHandle(snap);
      }
      std::set<DWORD> capturados;
      for (auto& f : fluxos) if (!f.morto) capturados.insert(f.pid);
      ComPtr<IMMDeviceCollection> col;
      if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) {
        UINT n = 0; col->GetCount(&n);
        for (UINT i = 0; i < n; i++) {
          ComPtr<IMMDevice> dev; if (FAILED(col->Item(i, &dev))) continue;
          ComPtr<IAudioSessionManager2> ger;
          if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, NULL, &ger))) continue;
          ComPtr<IAudioSessionEnumerator> se; if (FAILED(ger->GetSessionEnumerator(&se))) continue;
          int c = 0; se->GetCount(&c);
          for (int j = 0; j < c; j++) {
            ComPtr<IAudioSessionControl> sc; if (FAILED(se->GetSession(j, &sc))) continue;
            ComPtr<IAudioSessionControl2> s2; if (FAILED(sc.As(&s2))) continue;
            if (s2->IsSystemSoundsSession() == S_OK) continue;
            DWORD pid = 0; s2->GetProcessId(&pid);
            if (!pid || pid == eu || capturados.count(pid) || recusados.count(pid)) continue;
            AudioSessionState st = AudioSessionStateInactive; sc->GetState(&st);
            if (st == AudioSessionStateExpired) continue;
            // fora: exe na lista, ou qualquer ancestral (ou ele mesmo) na lista de árvores / já capturado
            bool fora = false;
            std::wstring exe = minusc(exeDoProcesso(pid));
            if (exe.empty() || semExe.count(exe)) fora = true;
            DWORD atual = pid;
            for (int k = 0; k < 12 && atual && !fora; k++) {
              if (semArvore.count(atual) || atual == eu) fora = true;
              else if (atual != pid && capturados.count(atual)) fora = true;     // o pai já está sendo capturado (árvore inclui)
              else if (atual != pid && semExe.count(minusc(exeDoProcesso(atual)))) fora = true;
              auto it = pai.find(atual); atual = (it == pai.end() || it->second == atual) ? 0 : it->second;
            }
            if (fora) { recusados.insert(pid); continue; }
            Fluxo f; f.pid = pid;
            if (abrirLoopback(pid, f.cli, f.cap)) { fluxos.push_back(f); capturados.insert(pid); fprintf(stderr, "mix: + %lu %s\n", (unsigned long)pid, utf8(exe).c_str()); fflush(stderr); }
            else recusados.insert(pid);
          }
        }
      }
    }

    // recolhe o que cada fluxo tem
    for (auto& f : fluxos) {
      if (f.morto) continue;
      UINT32 prox = 0;
      while (SUCCEEDED(f.cap->GetNextPacketSize(&prox)) && prox > 0) {
        BYTE* dados = NULL; UINT32 quadros = 0; DWORD flags = 0;
        if (FAILED(f.cap->GetBuffer(&dados, &quadros, &flags, NULL, NULL))) { f.morto = true; break; }
        if (quadros) {
          size_t antes = f.fila.size();
          f.fila.resize(antes + quadros * 2);
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) memset(&f.fila[antes], 0, quadros * 8);
          else memcpy(&f.fila[antes], dados, quadros * 8);
        }
        f.cap->ReleaseBuffer(quadros);
      }
      if (f.fila.size() > 48000 * 2 / 5) f.fila.erase(f.fila.begin(), f.fila.begin() + (f.fila.size() - 48000 * 2 / 10)); // > 200 ms: fica com 100
      if (!processoVivo(f.pid)) { f.morto = true; fprintf(stderr, "mix: - %lu\n", (unsigned long)f.pid); fflush(stderr); }
    }
    for (size_t i = 0; i < fluxos.size();) { if (fluxos[i].morto) { if (fluxos[i].cli) fluxos[i].cli->Stop(); fluxos.erase(fluxos.begin() + i); } else i++; }

    // escreve no ritmo do relógio: quantos quadros já deveriam ter saído
    LARGE_INTEGER t; QueryPerformanceCounter(&t);
    unsigned long long devidos = (unsigned long long)((double)(t.QuadPart - t0.QuadPart) * 48000.0 / (double)freq.QuadPart);
    if (devidos > escritos) {
      size_t quadros = (size_t)(devidos - escritos);
      if (quadros > 4800) quadros = 4800;
      saida.assign(quadros * 2, 0.f);
      for (auto& f : fluxos) {
        size_t tem = f.fila.size() / 2; size_t usa = tem < quadros ? tem : quadros;
        for (size_t k = 0; k < usa * 2; k++) saida[k] += f.fila[k];
        if (usa) f.fila.erase(f.fila.begin(), f.fila.begin() + usa * 2);
      }
      for (auto& v : saida) { if (v > 1.f) v = 1.f; else if (v < -1.f) v = -1.f; }
      fwrite(saida.data(), 8, quadros, stdout); fflush(stdout);
      escritos += quadros;
    }
    Sleep(5);
  }
  for (auto& f : fluxos) if (f.cli) f.cli->Stop();
  return 0;
}

int main(int argc, char** argv) {
  if (argc < 2) { printf("uso: somdoapp lista | janela <hwnd> | janelas <h,h> | mix [--semexe a,b] [--semarvore p,p] | <pid>\n"); return 2; }
  if (FAILED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) { printf("erro: com\n"); return 1; }
  int r;
  if (strcmp(argv[1], "lista") == 0) r = listar();
  else if (strcmp(argv[1], "janela") == 0 && argc > 2) {
    HWND h = (HWND)(UINT_PTR)_strtoui64(argv[2], NULL, 10);
    DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
    printf("%lu\n", (unsigned long)pid); r = pid ? 0 : 1;
  } else if (strcmp(argv[1], "janelas") == 0 && argc > 2) {
    // várias de uma vez ("hwnd,hwnd,…"): uma linha "hwnd<TAB>pid" por janela
    char* resto = NULL;
    for (char* tok = strtok_s(argv[2], ",", &resto); tok; tok = strtok_s(NULL, ",", &resto)) {
      HWND h = (HWND)(UINT_PTR)_strtoui64(tok, NULL, 10);
      DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
      printf("%s\t%lu\n", tok, (unsigned long)pid);
    }
    r = 0;
  } else if (strcmp(argv[1], "mix") == 0) {
    std::set<std::wstring> semExe; std::set<DWORD> semArvore;
    for (int i = 2; i + 1 < argc; i += 2) {
      char* resto = NULL;
      if (strcmp(argv[i], "--semexe") == 0) {
        for (char* tok = strtok_s(argv[i + 1], ",", &resto); tok; tok = strtok_s(NULL, ",", &resto)) {
          int n = MultiByteToWideChar(CP_UTF8, 0, tok, -1, NULL, 0); std::wstring w(n ? n - 1 : 0, 0);
          if (n) MultiByteToWideChar(CP_UTF8, 0, tok, -1, &w[0], n);
          semExe.insert(minusc(w));
        }
      } else if (strcmp(argv[i], "--semarvore") == 0) {
        for (char* tok = strtok_s(argv[i + 1], ",", &resto); tok; tok = strtok_s(NULL, ",", &resto)) semArvore.insert((DWORD)strtoul(tok, NULL, 10));
      }
    }
    r = misturar(semExe, semArvore);
  } else r = capturar((DWORD)strtoul(argv[1], NULL, 10));
  CoUninitialize();
  return r;
}

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

int main(int argc, char** argv) {
  if (argc < 2) { printf("uso: somdoapp lista | janela <hwnd> | <pid>\n"); return 2; }
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
  } else r = capturar((DWORD)strtoul(argv[1], NULL, 10));
  CoUninitialize();
  return r;
}

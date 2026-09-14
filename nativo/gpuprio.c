/* gpuprio — prioridade de agendamento da GPU de um processo (Windows).
 *
 * Uso:  gpuprio <pid>            → imprime a classe atual
 *       gpuprio <pid> <classe>   → muda (0 ocioso … 2 normal … 4 alta, 5 tempo real)
 *
 * É o mesmo que o OBS faz consigo mesmo (libobs-d3d11): a fila da placa de
 * vídeo passa a atender o processo de captura ANTES do jogo, em vez de dar
 * as sobras. "Alta" (4) não precisa de administrador; "tempo real" (5)
 * precisa e, sem ele, o Windows aplica "alta". Só toca em processos do
 * próprio usuário — nunca injeta nada em ninguém.
 *
 * Compilar (VS 2022, prompt x64):  cl /O2 /W3 gpuprio.c
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

typedef LONG NTSTATUS;
typedef enum _CLASSE_GPU {
  GPU_OCIOSO = 0, GPU_ABAIXO = 1, GPU_NORMAL = 2, GPU_ACIMA = 3, GPU_ALTA = 4, GPU_TEMPO_REAL = 5
} CLASSE_GPU;
typedef NTSTATUS (APIENTRY *PFN_SET)(HANDLE, CLASSE_GPU);
typedef NTSTATUS (APIENTRY *PFN_GET)(HANDLE, CLASSE_GPU*);

int main(int argc, char** argv) {
  if (argc < 2) { printf("uso: gpuprio <pid> [classe 0-5]\n"); return 2; }
  DWORD pid = (DWORD)atol(argv[1]);
  HMODULE gdi = LoadLibraryA("gdi32.dll");
  if (!gdi) { printf("erro: gdi32\n"); return 1; }
  PFN_SET set = (PFN_SET)GetProcAddress(gdi, "D3DKMTSetProcessSchedulingPriorityClass");
  PFN_GET get = (PFN_GET)GetProcAddress(gdi, "D3DKMTGetProcessSchedulingPriorityClass");
  if (!set || !get) { printf("erro: este Windows nao tem D3DKMT*ProcessSchedulingPriorityClass\n"); return 1; }
  HANDLE h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION, FALSE, pid);
  if (!h) { printf("erro: OpenProcess %lu\n", (unsigned long)GetLastError()); return 1; }
  CLASSE_GPU antes = GPU_NORMAL;
  NTSTATUS sg = get(h, &antes);
  if (argc < 3) { printf("classe=%d status=0x%lx\n", (int)antes, (unsigned long)sg); CloseHandle(h); return sg == 0 ? 0 : 1; }
  int pedido = atoi(argv[2]);
  if (pedido < 0 || pedido > 5) { printf("erro: classe 0-5\n"); CloseHandle(h); return 2; }
  NTSTATUS s = set(h, (CLASSE_GPU)pedido);
  CLASSE_GPU depois = antes;
  get(h, &depois);
  printf("antes=%d pedido=%d depois=%d status=0x%lx\n", (int)antes, pedido, (int)depois, (unsigned long)s);
  CloseHandle(h);
  return (s == 0) ? 0 : 1;
}

/* teclas — "segurar pra falar" que funciona com o jogo na frente (Windows).
 *
 * Uso:  teclas <vk>          → fica rodando; imprime "1" quando a tecla
 *                              desce e "0" quando solta (uma linha por vez)
 *       pela entrada padrão: "vk <n>" troca a tecla ao vivo; "sai" encerra.
 *       Fecha sozinho quando a entrada padrão fecha (o app morreu).
 *
 * Não é gancho de teclado (SetWindowsHookEx) nem injeção: só pergunta ao
 * Windows, a cada 8 ms, se a tecla está apertada (GetAsyncKeyState). Isso
 * não incomoda anti-cheat e não vê o que você digita — só aquela tecla.
 * Funciona com teclas e com os botões laterais do mouse (VK 4, 5 e 6).
 *
 * Compilar (VS 2022, prompt x64):  cl /O2 /W3 teclas.c
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static volatile LONG g_vk = 0;
static volatile LONG g_sair = 0;

static DWORD WINAPI lerEntrada(LPVOID p) {
  char linha[64];
  (void)p;
  while (fgets(linha, sizeof linha, stdin)) {
    if (strncmp(linha, "vk ", 3) == 0) InterlockedExchange(&g_vk, atol(linha + 3));
    else if (strncmp(linha, "sai", 3) == 0) break;
  }
  InterlockedExchange(&g_sair, 1);
  return 0;
}

int main(int argc, char** argv) {
  if (argc < 2) { printf("uso: teclas <vk>\n"); return 2; }
  g_vk = atol(argv[1]);
  setvbuf(stdout, NULL, _IONBF, 0);
  CreateThread(NULL, 0, lerEntrada, NULL, 0, NULL);
  printf("pronto\n");
  int antes = 0;
  while (!g_sair) {
    LONG vk = g_vk;
    int agora = vk > 0 && (GetAsyncKeyState((int)vk) & 0x8000) ? 1 : 0;
    if (agora != antes) { antes = agora; printf("%d\n", agora); }
    Sleep(8);
  }
  return 0;
}

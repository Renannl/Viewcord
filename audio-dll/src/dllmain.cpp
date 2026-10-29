#include <windows.h>
#include <stdio.h>
#include "MinHook.h"

// Forward declarations
extern void InitializeAudioHook();
extern void CleanupAudioHook();

HMODULE g_hModule = NULL;

BOOL APIENTRY DllMain(HMODULE hModule, DWORD dwReason, LPVOID lpReserved) {
    switch (dwReason) {
        case DLL_PROCESS_ATTACH:
            g_hModule = hModule;
            DisableThreadLibraryCalls(hModule);
            
            // Cria thread para inicializar o hook
            CreateThread(NULL, 0, [](LPVOID) -> DWORD {
                InitializeAudioHook();
                return 0;
            }, NULL, 0, NULL);
            break;
            
        case DLL_PROCESS_DETACH:
            CleanupAudioHook();
            break;
    }
    return TRUE;
}

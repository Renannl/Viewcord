#include <windows.h>
#include <iostream>

HANDLE hPipe = INVALID_HANDLE_VALUE;

void OpenAudioPipe() {
    hPipe = CreateFileW(
        L"\\\\.\\pipe\\ViewCordAudioPipe",
        GENERIC_WRITE,
        0,
        nullptr,
        OPEN_EXISTING,
        0,
        nullptr
    );
    
    if (hPipe == INVALID_HANDLE_VALUE) {
        std::cerr << "[ViewCord Audio Hook] Falha ao abrir pipe: " << GetLastError() << std::endl;
    }
}

void SendAudioData(BYTE* data, DWORD size) {
    if (hPipe == INVALID_HANDLE_VALUE) return;
    
    DWORD bytesWritten;
    WriteFile(hPipe, data, size, &bytesWritten, nullptr);
}

void CloseAudioPipe() {
    if (hPipe != INVALID_HANDLE_VALUE) {
        CloseHandle(hPipe);
        hPipe = INVALID_HANDLE_VALUE;
    }
}

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <MinHook.h>
#include <stdio.h>
#include <vector>
#include <string>

// Pipe para enviar dados ao ViewCord
HANDLE g_hPipe = INVALID_HANDLE_VALUE;
const wchar_t* PIPE_NAME = L"\\\\.\\pipe\\viewcord_audio";

// Ponteiros originais das funções hookadas
typedef HRESULT(STDMETHODCALLTYPE *GetBuffer_t)(IAudioCaptureClient*, BYTE**, UINT32*, DWORD*, UINT64*, UINT64*);
GetBuffer_t pOriginalGetBuffer = NULL;

typedef HRESULT(STDMETHODCALLTYPE *ReleaseBuffer_t)(IAudioCaptureClient*, UINT32);
ReleaseBuffer_t pOriginalReleaseBuffer = NULL;

// Buffer temporário para os dados de áudio
std::vector<BYTE> g_audioBuffer;

// Conecta no pipe do ViewCord
bool ConnectToPipe() {
    if (g_hPipe != INVALID_HANDLE_VALUE) return true;
    
    g_hPipe = CreateFileW(
        PIPE_NAME,
        GENERIC_WRITE,
        0,
        NULL,
        OPEN_EXISTING,
        0,
        NULL
    );
    
    return g_hPipe != INVALID_HANDLE_VALUE;
}

// Envia dados de áudio via pipe
void SendAudioData(const BYTE* data, DWORD size) {
    if (!ConnectToPipe()) return;
    
    DWORD bytesWritten;
    WriteFile(g_hPipe, data, size, &bytesWritten, NULL);
}

// Hook de GetBuffer — captura o ponteiro do buffer
HRESULT STDMETHODCALLTYPE HookedGetBuffer(
    IAudioCaptureClient* This,
    BYTE** ppData,
    UINT32* pNumFramesToRead,
    DWORD* pdwFlags,
    UINT64* pu64DevicePosition,
    UINT64* pu64QPCPosition
) {
    HRESULT hr = pOriginalGetBuffer(
        This, ppData, pNumFramesToRead, pdwFlags,
        pu64DevicePosition, pu64QPCPosition
    );
    
    if (SUCCEEDED(hr) && ppData && pNumFramesToRead && *pNumFramesToRead > 0) {
        // Copia os dados do buffer
        UINT32 frameCount = *pNumFramesToRead;
        UINT32 byteCount = frameCount * 4; // 16-bit stereo = 4 bytes por frame
        
        g_audioBuffer.resize(byteCount);
        memcpy(g_audioBuffer.data(), *ppData, byteCount);
        
        // Envia para o ViewCord
        SendAudioData(g_audioBuffer.data(), byteCount);
    }
    
    return hr;
}

// Hook de ReleaseBuffer
HRESULT STDMETHODCALLTYPE HookedReleaseBuffer(
    IAudioCaptureClient* This,
    UINT32 NumFramesRead
) {
    return pOriginalReleaseBuffer(This, NumFramesRead);
}

// Instala hooks nas funções WASAPI
void InstallWASAPIHooks() {
    // Hook IAudioCaptureClient::GetBuffer
    if (MH_CreateHook(
        reinterpret_cast<LPVOID*>(&IAudioCaptureClient::GetBuffer),
        reinterpret_cast<LPVOID>(HookedGetBuffer),
        reinterpret_cast<LPVOID*>(&pOriginalGetBuffer)
    ) != MH_OK) {
        return;
    }
    
    // Hook IAudioCaptureClient::ReleaseBuffer
    if (MH_CreateHook(
        reinterpret_cast<LPVOID*>(&IAudioCaptureClient::ReleaseBuffer),
        reinterpret_cast<LPVOID>(HookedReleaseBuffer),
        reinterpret_cast<LPVOID*>(&pOriginalReleaseBuffer)
    ) != MH_OK) {
        return;
    }
    
    // Ativa todos os hooks
    MH_EnableHook(MH_ALL_HOOKS);
}

// Inicializa o hook
void InitializeAudioHook() {
    // Inicializa MinHook
    if (MH_Initialize() != MH_OK) {
        return;
    }
    
    // Instala os hooks WASAPI
    InstallWASAPIHooks();
}

// Limpa os hooks
void CleanupAudioHook() {
    MH_Uninitialize();
    
    if (g_hPipe != INVALID_HANDLE_VALUE) {
        CloseHandle(g_hPipe);
        g_hPipe = INVALID_HANDLE_VALUE;
    }
}

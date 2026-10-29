use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::System::Memory::{
    VirtualAllocEx, MEM_COMMIT, MEM_RESERVE, PAGE_READWRITE,
};
use windows::Win32::System::ProcessStatus::EnumProcessModules;
use windows::Win32::System::Threading::{
    CreateRemoteThread, GetModuleHandleW, GetProcAddress, OpenProcess, WaitForSingleObject,
    PROCESS_ALL_ACCESS,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::SystemServices::INFINITE;

/// Injeta uma DLL em um processo pelo PID.
///
/// # Arguments
/// * `pid` - PID do processo alvo
/// * `dll_path` - Caminho absoluto da DLL
///
/// # Returns
/// * `Ok(())` se a injeção foi bem-sucedida
/// * `Err(String)` com a mensagem de erro
pub fn inject_dll(pid: u32, dll_path: &Path) -> Result<(), String> {
    // 1. Abrir o processo com permissões totais
    let process_handle = unsafe {
        OpenProcess(PROCESS_ALL_ACCESS, false, pid).map_err(|e| {
            format!("Falha ao abrir processo {}: {}", pid, e)
        })?
    };

    if process_handle == INVALID_HANDLE_VALUE {
        return Err(format!("Handle inválido para processo {}", pid));
    }

    // 2. Converter o caminho da DLL para UTF-16 (LPCWSTR)
    let dll_path_utf16: Vec<u16> = OsStr::new(dll_path.to_str().unwrap())
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let dll_path_bytes = dll_path_utf16.len() * 2;

    // 3. Alocar memória no processo remoto
    let remote_memory = unsafe {
        VirtualAllocEx(
            process_handle,
            None,
            dll_path_bytes,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        )
    };

    if remote_memory.is_null() {
        unsafe { CloseHandle(process_handle).ok(); }
        return Err("Falha ao alocar memória no processo remoto".into());
    }

    // 4. Escrever o caminho da DLL na memória remota
    let bytes_written = unsafe {
        windows::Win32::System::Memory::WriteProcessMemory(
            process_handle,
            remote_memory,
            dll_path_utf16.as_ptr() as *const _,
            dll_path_bytes,
            None,
        )
    };

    if !bytes_written.as_bool() {
        unsafe {
            windows::Win32::System::Memory::VirtualFreeEx(
                process_handle,
                remote_memory,
                0,
                windows::Win32::System::Memory::MEM_RELEASE,
            );
            CloseHandle(process_handle).ok();
        }
        return Err("Falha ao escrever caminho da DLL no processo remoto".into());
    }

    // 5. Obter o endereço de LoadLibraryW em kernel32.dll
    let kernel32 = unsafe {
        GetModuleHandleW(&HSTRING::from("kernel32.dll"))
            .map_err(|e| format!("Falha ao obter kernel32: {}", e))?
    };

    let load_library_addr = unsafe {
        GetProcAddress(kernel32, "LoadLibraryW")
            .ok_or("Falha ao obter endereço de LoadLibraryW")?
    };

    // 6. Criar thread remota que chama LoadLibraryW(dll_path)
    let thread_handle = unsafe {
        CreateRemoteThread(
            process_handle,
            None,
            0,
            Some(std::mem::transmute(load_library_addr)),
            Some(remote_memory),
            0,
            None,
        )
        .map_err(|e| format!("Falha ao criar thread remota: {}", e))?
    };

    // 7. Esperar a thread terminar (a DLL ser carregada)
    unsafe {
        WaitForSingleObject(thread_handle, INFINITE);
    }

    // 8. Limpar recursos
    unsafe {
        windows::Win32::System::Memory::VirtualFreeEx(
            process_handle,
            remote_memory,
            0,
            windows::Win32::System::Memory::MEM_RELEASE,
        );
        CloseHandle(thread_handle).ok();
        CloseHandle(process_handle).ok();
    }

    Ok(())
}

/// Lista processos com sessões de áudio ativas (para o seletor do frontend).
///
/// # Returns
/// * `Vec<(u32, String)>` - Lista de (PID, nome do processo)
pub fn list_audio_processes() -> Result<Vec<(u32, String)>, String> {
    // TODO: Implementar enumeração de sessões de áudio via WASAPI
    // Por enquanto, retorna lista vazia
    Ok(vec![])
}

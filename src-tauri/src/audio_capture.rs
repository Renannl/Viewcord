use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use windows::Win32::Foundation::{
    CloseHandle, E_UNEXPECTED, HANDLE, S_FALSE, WAIT_OBJECT_0, HWND, LPARAM,
};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, SetEvent,
    WaitForSingleObject,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, WNDENUMPROC,
};
use windows_core::{implement, IUnknown, Interface};

#[derive(Clone, serde::Serialize)]
pub struct AudioProcessInfo {
    pub pid: u32,
    pub name: String,
    pub executable: String,
}

#[derive(Clone, serde::Serialize)]
struct AudioChunk {
    data: Vec<u8>,
    sample_rate: u32,
    channels: u16,
    bits: u16,
}

pub struct AudioCaptureState {
    running: Mutex<bool>,
    stop_flag: Arc<AtomicBool>,
    capture_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

unsafe extern "system" fn enum_windows_callback(
    hwnd: HWND,
    lparam: LPARAM,
) -> i32 {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));

    let mut title_buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut title_buf);
    let title = if len > 0 {
        String::from_utf16_lossy(&title_buf[..len as usize])
    } else {
        String::new()
    };

    let visible = IsWindowVisible(hwnd).as_bool();

    if visible && len > 0 && pid > 0 {
        println!("[DEBUG CALLBACK] HWND={:?} PID={pid} visible={visible} titulo='{title}'", hwnd.0);
        let out = &mut *(lparam.0 as *mut Vec<(u32, String)>);
        out.push((pid, title));
    }

    1
}

#[tauri::command]
pub fn list_audio_processes(_state: State<AudioCaptureState>) -> Result<Vec<AudioProcessInfo>, String> {
    unsafe {
        // 1) Enumera janelas visíveis com título -> (pid, título)
        let mut windows: Vec<(u32, String)> = Vec::new();

        let callback: WNDENUMPROC = Some(std::mem::transmute(
            enum_windows_callback as unsafe extern "system" fn(HWND, LPARAM) -> i32,
        ));

        EnumWindows(callback, LPARAM(&mut windows as *mut _ as isize))
            .map_err(|e| format!("EnumWindows falhou: {e}"))?;

        // 2) Cria mapa pid -> nome do executável via snapshot (não precisa de OpenProcess)
        let mut exe_map: HashMap<u32, String> = HashMap::new();
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            .map_err(|e| format!("CreateToolhelp32Snapshot falhou: {e}"))?;

        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                if pid != 0 {
                    let name_raw = String::from_utf16_lossy(&entry.szExeFile);
                    let name = name_raw.trim_end_matches('\0').to_string();
                    if !name.is_empty() {
                        exe_map.insert(pid, name);
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);

        // 3) Junta os dois: título da janela + nome do executável
        let mut seen_pids = HashSet::new();
        let mut list = Vec::new();

        for (pid, title) in windows {
            if !seen_pids.insert(pid) {
                continue;
            }

            let Some(name) = exe_map.get(&pid) else {
                continue;
            };

            if name.eq_ignore_ascii_case("viewcord.exe") {
                continue;
            }

            let display = format!("{title} ({name})");

            list.push(AudioProcessInfo {
                pid,
                name: display,
                executable: name.clone(),
            });
        }

        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(list)
    }
}

#[tauri::command]
pub fn start_audio_capture(
    app: AppHandle,
    state: State<AudioCaptureState>,
    pid: u32,
    _quality: String,
) -> Result<String, String> {
    stop_audio_capture(state.clone())?;

    state.stop_flag.store(false, Ordering::SeqCst);
    *state.running.lock().unwrap() = true;

    let stop_flag = state.stop_flag.clone();
    let app_handle = app.app_handle().clone();

    let handle = thread::spawn(move || {
        if let Err(e) = capture_process_audio(app_handle, pid, stop_flag) {
            eprintln!("Erro na captura de áudio: {e}");
        }
    });

    *state.capture_handle.lock().unwrap() = Some(handle);
    Ok("Captura de áudio iniciada".to_string())
}

#[tauri::command]
pub fn stop_audio_capture(state: State<AudioCaptureState>) -> Result<String, String> {
    let running = *state.running.lock().unwrap();
    if running {
        state.stop_flag.store(true, Ordering::SeqCst);

        if let Some(handle) = state.capture_handle.lock().unwrap().take() {
            let _ = handle.join();
        }

        *state.running.lock().unwrap() = false;
    }
    Ok("Captura de áudio parada".to_string())
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(AudioCaptureState {
        running: Mutex::new(false),
        stop_flag: Arc::new(AtomicBool::new(false)),
        capture_handle: Mutex::new(None),
    });
    Ok(())
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateCompletionHandler {
    event: HANDLE,
    client: Arc<Mutex<Option<IAudioClient>>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateCompletionHandler_Impl {
    fn ActivateCompleted(
        &self,
        operation: windows_core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows_core::Result<()> {
        unsafe {
            let op = operation.as_ref().ok_or(E_UNEXPECTED)?;
            let mut hr = windows_core::HRESULT(0);
            let mut unknown: Option<IUnknown> = None;
            op.GetActivateResult(&mut hr, &mut unknown)?;
            if hr.is_err() {
                return Err(hr.into());
            }
            if let Some(unk) = unknown {
                let client: IAudioClient = unk.cast()?;
                *self.client.lock().unwrap() = Some(client);
            }
            SetEvent(self.event)?;
        }
        Ok(())
    }
}

fn capture_process_audio(
    app: AppHandle,
    pid: u32,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() && hr != S_FALSE {
            return Err(format!("CoInitializeEx falhou: {hr:?}"));
        }

        let params_value = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        let mut activation_params: PROPVARIANT = std::mem::zeroed();
        {
            let anon = &mut activation_params.Anonymous.Anonymous;
            anon.vt = VT_BLOB;
            anon.Anonymous.blob.cbSize =
                std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32;
            anon.Anonymous.blob.pBlobData = &params_value as *const _ as *mut u8;
        }

        let activate_event = CreateEventW(None, true, false, None)
            .map_err(|e| format!("CreateEventW falhou: {e}"))?;

        let shared_client: Arc<Mutex<Option<IAudioClient>>> = Arc::new(Mutex::new(None));
        let handler = ActivateCompletionHandler {
            event: activate_event,
            client: shared_client.clone(),
        };
        let completion_handler: IActivateAudioInterfaceCompletionHandler = handler.into();

        let _async_op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID as *const _,
            Some(&activation_params as *const _),
            &completion_handler,
        )
        .map_err(|e| format!("ActivateAudioInterfaceAsync falhou: {e}"))?;

        if WaitForSingleObject(activate_event, 5000) != WAIT_OBJECT_0 {
            let _ = CloseHandle(activate_event);
            return Err("Tempo esgotado ativando áudio do processo".to_string());
        }
        let _ = CloseHandle(activate_event);

        let client = shared_client
            .lock()
            .unwrap()
            .take()
            .ok_or("Não foi possível obter IAudioClient")?;

        let format = client
            .GetMixFormat()
            .map_err(|e| format!("GetMixFormat falhou: {e}"))?;
        if format.is_null() {
            return Err("GetMixFormat retornou formato nulo".to_string());
        }
        let pwfx = &*format;

        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                0,
                0,
                format,
                None,
            )
            .map_err(|e| format!("IAudioClient::Initialize falhou: {e}"))?;

        let capture_client: IAudioCaptureClient = client
            .GetService()
            .map_err(|e| format!("GetService falhou: {e}"))?;

        client
            .Start()
            .map_err(|e| format!("IAudioClient::Start falhou: {e}"))?;

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }

            let packet_length = capture_client
                .GetNextPacketSize()
                .map_err(|e| format!("GetNextPacketSize falhou: {e}"))?;
            if packet_length == 0 {
                thread::sleep(Duration::from_millis(1));
                continue;
            }

            let mut data_ptr = std::ptr::null_mut();
            let mut frames_available = 0u32;
            let mut flags = 0u32;
            capture_client
                .GetBuffer(&mut data_ptr, &mut frames_available, &mut flags, None, None)
                .map_err(|e| format!("GetBuffer falhou: {e}"))?;

            if frames_available > 0
                && flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0
                && !data_ptr.is_null()
            {
                let bytes = frames_available as usize * pwfx.nBlockAlign as usize;
                let slice = std::slice::from_raw_parts(data_ptr as *const u8, bytes);
                let chunk = AudioChunk {
                    data: slice.to_vec(),
                    sample_rate: pwfx.nSamplesPerSec,
                    channels: pwfx.nChannels,
                    bits: pwfx.wBitsPerSample,
                };
                let _ = app.emit("audio-chunk", &chunk);
            }

            capture_client
                .ReleaseBuffer(frames_available)
                .map_err(|e| format!("ReleaseBuffer falhou: {e}"))?;
        }

        let _ = client.Stop();
        CoTaskMemFree(Some(format as *const core::ffi::c_void));
        CoUninitialize();
    }

    Ok(())
}

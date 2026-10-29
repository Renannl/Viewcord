use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, ReadFile, PIPE_ACCESS_INBOUND,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};

const PIPE_NAME: &str = r"\\.\pipe\viewcord_audio";
const BUFFER_SIZE: u32 = 65536;

static PIPE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Inicia o servidor de named pipe que recebe dados de áudio da DLL.
///
/// # Arguments
/// * `app` - Handle do Tauri para emitir eventos


pub struct AudioCaptureState {
    running: Mutex<bool>,
    stop_flag: Arc<AtomicBool>,
    capture_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(AudioCaptureState {
        running: Mutex::new(false),
        stop_flag: Arc::new(AtomicBool::new(false)),
        capture_handle: Mutex::new(None),
    });
    Ok(())
}

pub fn start_audio_pipe(app: AppHandle) -> Result<(), String> {
    if PIPE_RUNNING.load(Ordering::SeqCst) {
        return Err("Pipe já está rodando".into());
    }

    PIPE_RUNNING.store(true, Ordering::SeqCst);
    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    std::thread::spawn(move || {
        let pipe_name = HSTRING::from(PIPE_NAME);

        loop {
            if !running_clone.load(Ordering::SeqCst) {
                break;
            }

            // Criar o pipe
            let pipe_handle = unsafe {
                CreateNamedPipeW(
                    &pipe_name,
                    PIPE_ACCESS_INBOUND,
                    PIPE_TYPE_BYTE | PIPE_WAIT,
                    1,
                    BUFFER_SIZE,
                    BUFFER_SIZE,
                    0,
                    None,
                )
            };

            if pipe_handle == INVALID_HANDLE_VALUE {
                eprintln!("Falha ao criar pipe");
                continue;
            }

            // Esperar conexão da DLL
            let connected = unsafe { ConnectNamedPipe(pipe_handle, None) };
            if !connected.as_bool() {
                unsafe { CloseHandle(pipe_handle).ok(); }
                continue;
            }

            println!("DLL conectada ao pipe");

            // Loop de leitura
            let mut buffer = vec![0u8; BUFFER_SIZE as usize];
            loop {
                if !running_clone.load(Ordering::SeqCst) {
                    break;
                }

                let mut bytes_read = 0;
                let read_result = unsafe {
                    ReadFile(pipe_handle, Some(&mut buffer), Some(&mut bytes_read), None)
                };

                if !read_result.as_bool() || bytes_read == 0 {
                    println!("DLL desconectou do pipe");
                    break;
                }

                // Emitir evento para o renderer
                let audio_data = buffer[..bytes_read as usize].to_vec();
                if let Err(e) = app.emit("audio-data", audio_data) {
                    eprintln!("Falha ao emitir audio-data: {}", e);
                }
            }

            unsafe {
                DisconnectNamedPipe(pipe_handle).ok();
                CloseHandle(pipe_handle).ok();
            }
        }
    });

    Ok(())
}

/// Para o servidor de pipe.
pub fn stop_audio_pipe() {
    PIPE_RUNNING.store(false, Ordering::SeqCst);
}

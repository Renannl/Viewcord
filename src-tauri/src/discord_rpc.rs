use discord_rich_presence::{
    activity::{Activity, Assets, Button},
    DiscordIpc, DiscordIpcClient,
};
use once_cell::sync::Lazy;
use std::sync::Mutex;

const CLIENT_ID: &str = "798971988722450442";

static RPC_CLIENT: Lazy<Mutex<Option<DiscordIpcClient>>> = Lazy::new(|| Mutex::new(None));
static CURRENT_ROOM_ID: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

pub async fn ensure_connected() -> Result<(), Box<dyn std::error::Error>> {
    let mut client_lock = RPC_CLIENT.lock().unwrap();

    if client_lock.is_some() {
        return Ok(());
    }

    let mut client = DiscordIpcClient::new(CLIENT_ID)?;

    match client.connect() {
        Ok(_) => {
            println!("Discord RPC conectado");
            *client_lock = Some(client);
            Ok(())
        }
        Err(e) => {
            println!("Falha ao conectar Discord RPC: {}", e);
            Err(e)
        }
    }
}

pub async fn update_presence(room_id: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let mut client_lock = RPC_CLIENT.lock().unwrap();

    if let Some(client) = client_lock.as_mut() {
        let mut room_lock = CURRENT_ROOM_ID.lock().unwrap();

        if let Some(id) = room_id {
            *room_lock = Some(id.to_string());
        } else {
            *room_lock = None;
        }

        // A URL precisa viver o tempo suficiente para montar e enviar a activity.
        let url: Option<String> = room_lock.as_ref().map(|id| {
            format!("https://viewcord-site.vercel.app/join?room={}", id)
        });

        let activity = if let Some(ref url) = url {
            Activity::new()
                .details("Compartilhando tela")
                .state("Clique no botão")
                .assets(
                    Assets::new()
                        .large_image("viewcord_logo")
                        .large_text("ViewCord"),
                )
                .buttons(vec![Button::new("Assistir Tela", url)])
        } else {
            Activity::new()
                .details("Aguardando")
                .state("ViewCord")
                .assets(
                    Assets::new()
                        .large_image("viewcord_logo")
                        .large_text("ViewCord"),
                )
        };

        client.set_activity(activity)?;
    }

    Ok(())
}

pub fn stop_presence() {
    let mut client_lock = RPC_CLIENT.lock().unwrap();
    if let Some(mut client) = client_lock.take() {
        let _ = client.close();
    }
}

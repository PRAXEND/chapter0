use std::{io::{BufRead, BufReader}, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Service(Mutex<Option<Child>>);

fn launch(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let entry = resources.join("apps/studio/src/server.mjs");
    let node = resources.join("bin/node");
    let mut server = Command::new(node);
    if let Ok(rel) = std::fs::read_to_string(resources.join("codex-executable.txt")) {
        let codex = resources.join("codex-runtime").join(rel.trim());
        if codex.is_file() {server.env("VIDEO_STUDIO_CODEX", codex);}
    }
    let mut child = server
        .arg(entry).arg("--native")
        .env("VIDEO_STUDIO_BUNDLE", &resources)
        .env("VIDEO_STUDIO_RESOURCE_DIR", &resources)
        .env("VIDEO_STUDIO_FFMPEG_DIR", resources.join("bin"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
    let opening = (|| -> Result<_, Box<dyn std::error::Error>> {
        let mut line = String::new();
        let stdout = child.stdout.take().ok_or("服务启动通道不可用")?;
        let mut reader = BufReader::new(stdout);
        reader.read_line(&mut line)?;
        let ready: serde_json::Value = serde_json::from_str(&line)?;
        let url: tauri::Url = ready["url"].as_str().ok_or("本地服务未就绪")?.parse()?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
            return Err("本地服务地址无效".into());
        }
        let origin = url.origin();
        let window = WebviewWindowBuilder::new(app, "studio", WebviewUrl::External(url))
            .title("Video Studio").inner_size(1360.0, 880.0).min_inner_size(880.0, 640.0)
            .on_navigation(move |to| to.origin() == origin)
            .build()?;
        window.set_focus()?;
        std::thread::spawn(move || { for _ in reader.lines().map_while(Result::ok) {} });
        Ok(())
    })();
    if let Err(err) = opening { let _ = child.kill(); let _ = child.wait(); return Err(err); }
    app.manage(Service(Mutex::new(Some(child))));
    Ok(())
}

fn main() {
    // Finder's environment does not include the user's shell configuration.
    if std::env::var_os("PATH").is_none() {
        std::env::set_var("PATH", PathBuf::from("/usr/bin:/bin:/usr/sbin:/sbin"));
    }
    let app = tauri::Builder::default()
        .on_window_event(|window,event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        }).setup(|app| launch(app)).build(tauri::generate_context!())
        .expect("无法启动 Video Studio 本地服务");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            if let Some(window) = handle.get_webview_window("studio") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(service) = handle.try_state::<Service>() {
                if let Ok(mut guard) = service.0.lock() {
                    if let Some(mut child) = guard.take() {
                        drop(child.stdin.take());
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}

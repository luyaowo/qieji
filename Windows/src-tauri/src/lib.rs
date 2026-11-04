mod desktop;
mod geometry;
pub mod store;

use desktop::{Desktop, Snapshot, View};
use serde_json::json;
use serde_json::Value;
#[cfg(debug_assertions)]
use std::fs;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use store::Store;
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

struct DesktopState {
    store: Mutex<Store>,
    desktop: Mutex<Desktop>,
    initialized: AtomicBool,
    exiting: AtomicBool,
    ready: AtomicBool,
    #[cfg(debug_assertions)]
    smoke_root: Option<PathBuf>,
    #[cfg(debug_assertions)]
    fail_writes: AtomicBool,
}

fn access(state: &DesktopState) -> Result<std::sync::MutexGuard<'_, Store>, String> {
    state
        .store
        .lock()
        .map_err(|_| "数据保存暂时不可用，请保留窗口内容后重试。".into())
}

fn save(state: &DesktopState, workspace: Value) -> Result<Value, String> {
    if !state.initialized.load(Ordering::SeqCst) {
        return Err("工作区尚未读取，不能覆盖原始文件。".into());
    }
    #[cfg(debug_assertions)]
    if state.fail_writes.load(Ordering::SeqCst) {
        return Err("隔离检查：模拟磁盘写入失败。".into());
    }
    access(state)?.save(workspace)
}

#[tauri::command]
async fn qieji_bootstrap(state: State<'_, DesktopState>) -> Result<Value, String> {
    let loaded = access(&state)?.load()?;
    state.initialized.store(true, Ordering::SeqCst);
    let mut desktop = state.desktop.lock().map_err(|_| "窗口状态暂时不可用。")?;
    if loaded.recovered {
        desktop.view = View::Paper;
    }
    Ok(
        json!({"workspace": loaded.workspace, "recovered": loaded.recovered, "desktop": desktop.snapshot()}),
    )
}

#[tauri::command]
async fn qieji_window(
    view: View,
    workspace: Value,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Snapshot, String> {
    save(&state, workspace)?;
    state
        .desktop
        .lock()
        .map_err(|_| "窗口状态暂时不可用。")?
        .apply(&window, view, true)
}

#[tauri::command]
fn qieji_reveal(window: WebviewWindow, state: State<'_, DesktopState>) -> Result<Snapshot, String> {
    // Revealing an error must remain possible even when workspace writes fail.
    state
        .desktop
        .lock()
        .map_err(|_| "窗口状态暂时不可用。")?
        .apply(&window, View::Paper, true)
}

#[tauri::command]
fn qieji_drag(
    phase: String,
    screen_y: f64,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .desktop
        .lock()
        .map_err(|_| "窗口状态暂时不可用。")?
        .drag(&window, &phase, screen_y)
}

#[tauri::command]
async fn qieji_save(workspace: Value, state: State<'_, DesktopState>) -> Result<Value, String> {
    save(&state, workspace)
}

#[tauri::command]
async fn qieji_pick_import(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Option<Value>, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = &state.smoke_root {
        return store::read_import(&root.join("incoming.json")).map(Some);
    }
    let _ = &state;
    let path = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("且记 JSON 备份", &["json"])
        .blocking_pick_file();
    match path {
        None => Ok(None),
        Some(path) => {
            store::read_import(&path.into_path().map_err(|_| "文件位置无效。")?).map(Some)
        }
    }
}

#[tauri::command]
async fn qieji_confirm_import(
    summary: Value,
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
    #[cfg(debug_assertions)]
    if state.smoke_root.is_some() {
        return Ok(true);
    }
    let _ = &state;
    let count = |key: &str| summary.get(key).and_then(Value::as_u64).unwrap_or(0);
    Ok(app
        .dialog()
        .message(format!(
            "将新增 {} 条任务、{} 条回收记录，跳过 {} 条冲突记录。\n\n导入前会保存当前工作区备份。",
            count("tasks"),
            count("trash"),
            count("conflicts")
        ))
        .parent(&window)
        .title("合并导入任务")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "导入".into(),
            "取消".into(),
        ))
        .blocking_show())
}

#[tauri::command]
async fn qieji_import(
    before: Value,
    workspace: Value,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    if !state.initialized.load(Ordering::SeqCst) {
        return Err("工作区尚未读取。".into());
    }
    access(&state)?.import(&before, workspace)
}

#[tauri::command]
async fn qieji_export(
    workspace: Value,
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
    store::validate(&workspace)?;
    let path: Option<PathBuf> = {
        #[cfg(debug_assertions)]
        if let Some(root) = &state.smoke_root {
            Some(root.join("exported.json"))
        } else {
            app.dialog()
                .file()
                .set_parent(&window)
                .add_filter("且记 JSON 备份", &["json"])
                .set_file_name("且记-任务备份.json")
                .blocking_save_file()
                .map(|p| p.into_path().map_err(|_| "文件位置无效。".to_string()))
                .transpose()?
        }
        #[cfg(not(debug_assertions))]
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("且记 JSON 备份", &["json"])
            .set_file_name("且记-任务备份.json")
            .blocking_save_file()
            .map(|p| p.into_path().map_err(|_| "文件位置无效。".to_string()))
            .transpose()?
    };
    let _ = &state;
    let Some(path) = path else {
        return Ok(false);
    };
    store::atomic_write(
        &path,
        &serde_json::to_vec_pretty(&workspace).map_err(|_| "导出编码失败。")?,
    )?;
    Ok(true)
}

#[tauri::command]
async fn qieji_exit(
    workspace: Option<Value>,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    if state.initialized.load(Ordering::SeqCst) {
        save(&state, workspace.ok_or("清单尚未准备好，已取消退出。")?)?;
    }
    state.exiting.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn qieji_ready(window: WebviewWindow, state: State<'_, DesktopState>) -> Result<(), String> {
    if state.ready.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    {
        let mut desktop = state.desktop.lock().map_err(|_| "窗口状态暂时不可用。")?;
        let view = desktop.view;
        if desktop.apply(&window, view, view != View::Edge).is_err() {
            desktop.apply(&window, View::Paper, true)?;
        }
    }
    #[cfg(debug_assertions)]
    if state.smoke_root.is_some() {
        window
            .eval(include_str!("../../Scripts/windows-stage1-smoke.js"))
            .map_err(|_| "无法启动隔离检查。")?;
    }
    let _ = window;
    Ok(())
}

#[cfg(debug_assertions)]
#[tauri::command]
fn qieji_smoke(
    action: String,
    payload: Value,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    let root = state.smoke_root.as_ref().ok_or("不是隔离检查模式。")?;
    match action.as_str() {
        "read" => {
            let current = access(&state)?.load()?.workspace;
            let exported = fs::read(root.join("exported.json"))
                .ok()
                .and_then(|v| serde_json::from_slice::<Value>(&v).ok());
            let backups = fs::read_dir(root.join("Data/Backups"))
                .map(|v| v.count())
                .unwrap_or(0);
            let window = app.get_webview_window("main").ok_or("窗口不可用。")?;
            let desktop = state
                .desktop
                .lock()
                .map_err(|_| "窗口状态不可用。")?
                .snapshot();
            Ok(
                json!({"workspace":current,"exported":exported,"backups":backups,"desktop":desktop,
                "visible":window.is_visible().unwrap_or(false), "size":window.inner_size().ok(),
                "scale":window.scale_factor().unwrap_or(1.0), "position":window.outer_position().ok(),
                "resizable":window.is_resizable().unwrap_or(false), "maximizable":window.is_maximizable().unwrap_or(false)}),
            )
        }
        "failWrites" => {
            state
                .fail_writes
                .store(payload.as_bool().unwrap_or(false), Ordering::SeqCst);
            Ok(Value::Null)
        }
        "result" => {
            store::atomic_write(
                &root.join("results.json"),
                &serde_json::to_vec_pretty(&payload).unwrap(),
            )?;
            println!("Stage 1 verification: {}", root.display());
            state.exiting.store(true, Ordering::SeqCst);
            app.exit(
                if payload.get("valid").and_then(Value::as_bool) == Some(true) {
                    0
                } else {
                    1
                },
            );
            Ok(Value::Null)
        }
        _ => Err("无效的检查操作。".into()),
    }
}

fn request_close(app: &tauri::AppHandle, quit: bool) {
    if let Some(web) = app.get_webview_window("main") {
        let _ = web.eval(if quit {
            "window.QieJi?.platform?.requestClose()"
        } else {
            "window.QieJi?.platform?.requestWindowClose()"
        });
    }
}

pub fn run() {
    #[cfg(debug_assertions)]
    let smoke = std::env::args().any(|a| a == "--verify-stage1");
    #[cfg(not(debug_assertions))]
    let smoke = false;
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // Each synthetic-data probe has its own store and nonpersistent webview.
    // It must not attach to or terminate an already-open development preview.
    if !smoke {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            desktop::request(app, View::Paper);
        }));
    }
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        qieji_bootstrap,
        qieji_save,
        qieji_pick_import,
        qieji_confirm_import,
        qieji_import,
        qieji_export,
        qieji_exit,
        qieji_ready,
        qieji_window,
        qieji_reveal,
        qieji_drag,
        qieji_smoke
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        qieji_bootstrap,
        qieji_save,
        qieji_pick_import,
        qieji_confirm_import,
        qieji_import,
        qieji_export,
        qieji_exit,
        qieji_ready,
        qieji_window,
        qieji_reveal,
        qieji_drag
    ]);
    let app = builder.setup(move |app| {
        #[cfg(debug_assertions)]
        if app.config().identifier != "com.luyaowo.qieji.dev" {
            return Err("开发运行请使用 npm run dev，避免混用正式版数据。".into());
        }
        #[cfg(debug_assertions)]
        let smoke_root = if smoke {
            let root = tempfile::Builder::new().prefix("qieji-windows-stage1-smoke-").tempdir()?.keep();
            let incoming = json!({"format":"qieji-workspace","version":2,"tasks":[{"id":"imported-native","text":"原生导入合成任务","group":"upcoming","done":false}],"trash":[]});
            fs::write(root.join("incoming.json"), serde_json::to_vec(&incoming)?)?;
            println!("Stage 1 data: {}", root.display()); Some(root)
        } else { None };
        let data = app.path().app_local_data_dir()?;
        #[cfg(debug_assertions)]
        let data = smoke_root.as_ref().map(|r| r.join("Data")).unwrap_or(data);
        let web_data = data.join("WebView");
        app.manage(DesktopState {
            desktop: Mutex::new(Desktop::new(data.clone())),
            store: Mutex::new(Store::new(data)), initialized: AtomicBool::new(false),
            exiting: AtomicBool::new(false), ready: AtomicBool::new(false),
            #[cfg(debug_assertions)] smoke_root,
            #[cfg(debug_assertions)] fail_writes: AtomicBool::new(false),
        });
        let config = app.config().app.windows.first().ok_or("缺少主窗口配置。")?;
        let window = WebviewWindowBuilder::from_config(app, config)?.data_directory(web_data)
            .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https") && matches!(url.host_str(), Some("localhost" | "tauri.localhost")));
        #[cfg(debug_assertions)]
        let window = window.incognito(app.state::<DesktopState>().smoke_root.is_some());
        window.build()?;
        if !smoke {
            match desktop::init_tray(app.handle()) {
                Ok(()) => { app.state::<DesktopState>().desktop.lock().map_err(|_| "托盘状态不可用。")?.tray_ready = true; },
                Err(error) => eprintln!("托盘创建失败，将保留完整窗口与保存后退出入口：{error}"),
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if handle.state::<DesktopState>().exiting.load(Ordering::SeqCst) { break; }
                let scheduled = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(window) = scheduled.get_webview_window("main") {
                        let state = scheduled.state::<DesktopState>();
                        if state.ready.load(Ordering::SeqCst) {
                            if let Ok(mut desktop) = state.desktop.try_lock() { desktop.refresh(&window); }
                        }
                    }
                });
            });
        }
        Ok(())
    }).on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let state = window.state::<DesktopState>();
            if !state.exiting.load(Ordering::SeqCst) && state.initialized.load(Ordering::SeqCst) {
                api.prevent_close(); request_close(window.app_handle(), false);
            }
        }
        if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
            let state = window.state::<DesktopState>();
            if state.ready.load(Ordering::SeqCst) {
                if let Some(web) = window.app_handle().get_webview_window("main") {
                    if let Ok(mut desktop) = state.desktop.try_lock() { desktop.record_paper(&web); }
                }
            }
        }
    }).build(tauri::generate_context!()).expect("无法启动且记 Windows 工程");
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = handle.state::<DesktopState>();
            if !state.exiting.load(Ordering::SeqCst) && state.initialized.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_close(handle, true);
            }
        }
    });
}

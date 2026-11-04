use crate::{
    geometry::{self, Display, Rect},
    store,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    #[default]
    Paper,
    Side,
    Edge,
    Hidden,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Preferences {
    version: u32,
    view: View,
    monitor: Option<String>,
    height_ratio: f64,
    paper_position: Option<(i32, i32)>,
    paper_size: (f64, f64),
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            view: View::Paper,
            monitor: None,
            height_ratio: 0.5,
            paper_position: None,
            paper_size: (720.0, 840.0),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub view: View,
    pub mode: &'static str,
    pub open: bool,
    pub tray_ready: bool,
    pub warning: Option<String>,
}

struct Drag {
    start_y: i32,
    cursor_y: f64,
    original_ratio: f64,
}

pub struct Desktop {
    path: PathBuf,
    prefs: Preferences,
    pub view: View,
    pub tray_ready: bool,
    displays: Vec<Display>,
    drag: Option<Drag>,
    dirty_since: Option<Instant>,
}

fn displays(window: &WebviewWindow) -> Result<Vec<Display>, String> {
    let mut monitors = window.available_monitors().map_err(|e| e.to_string())?;
    if let Ok(Some(primary)) = window.primary_monitor() {
        if let Some(index) = monitors
            .iter()
            .position(|m| m.position() == primary.position())
        {
            monitors.swap(0, index);
        }
    }
    let result: Vec<_> = monitors
        .into_iter()
        .map(|m| {
            let area = m.work_area();
            Display {
                name: m
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("{}:{}", area.position.x, area.position.y)),
                area: Rect {
                    x: area.position.x,
                    y: area.position.y,
                    width: area.size.width,
                    height: area.size.height,
                },
                scale: m.scale_factor(),
            }
        })
        .filter(|m| m.area.width > 0 && m.area.height > 0 && m.scale.is_finite() && m.scale > 0.0)
        .collect();
    if result.is_empty() {
        return Err("暂时无法获取屏幕位置，请使用完整窗口。".into());
    }
    Ok(result)
}

impl Desktop {
    pub fn new(directory: PathBuf) -> Self {
        let path = directory.join("window-preferences.json");
        let mut prefs: Preferences = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if prefs.version != 1 {
            prefs = Preferences::default();
        }
        if prefs.view == View::Hidden {
            prefs.view = View::Paper;
        }
        if !prefs.height_ratio.is_finite() {
            prefs.height_ratio = 0.5;
        }
        prefs.height_ratio = prefs.height_ratio.clamp(0.0, 1.0);
        if !prefs.paper_size.0.is_finite()
            || !prefs.paper_size.1.is_finite()
            || prefs.paper_size.0 <= 0.0
            || prefs.paper_size.1 <= 0.0
        {
            prefs.paper_size = (720.0, 840.0);
        }
        let view = prefs.view;
        Self {
            path,
            prefs,
            view,
            tray_ready: false,
            displays: vec![],
            drag: None,
            dirty_since: None,
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        let shown = if self.view == View::Hidden {
            self.prefs.view
        } else {
            self.view
        };
        Snapshot {
            view: self.view,
            mode: if shown == View::Paper {
                "paper"
            } else {
                "side"
            },
            open: shown != View::Edge,
            tray_ready: self.tray_ready,
            warning: None,
        }
    }
    fn persist(&mut self) -> Result<(), String> {
        store::atomic_write(
            &self.path,
            &serde_json::to_vec(&self.prefs).map_err(|_| "窗口偏好编码失败。")?,
        )?;
        self.dirty_since = None;
        Ok(())
    }
    fn emit(&self, window: &WebviewWindow) {
        if let Ok(payload) = serde_json::to_string(&self.snapshot()) {
            let _ = window.eval(format!(
                "window.QieJi?.platform?.applyDesktopState({payload})"
            ));
        }
    }
    fn display(&self, all: &[Display]) -> Display {
        all.iter()
            .find(|m| Some(&m.name) == self.prefs.monitor.as_ref())
            .unwrap_or(&all[0])
            .clone()
    }
    pub fn record_paper(&mut self, window: &WebviewWindow) {
        if self.view != View::Paper
            || !window.is_visible().unwrap_or(false)
            || window.is_minimized().unwrap_or(false)
            || window.is_maximized().unwrap_or(false)
        {
            return;
        }
        if let (Ok(pos), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.inner_size(),
            window.scale_factor(),
        ) {
            if size.width == 0 || size.height == 0 {
                return;
            }
            self.prefs.paper_position = Some((pos.x, pos.y));
            self.prefs.paper_size = (size.width as f64 / scale, size.height as f64 / scale);
            if let Ok(Some(m)) = window.current_monitor() {
                self.prefs.monitor = m.name().cloned();
            }
            self.dirty_since = Some(Instant::now());
        }
    }
    fn layout(
        &mut self,
        window: &WebviewWindow,
        view: View,
        all: &[Display],
    ) -> Result<(), String> {
        let display = self.display(all);
        let area = display.area;
        let error = |e: tauri::Error| e.to_string();
        window
            .set_min_size(None::<PhysicalSize<u32>>)
            .map_err(error)?;
        let paper = view == View::Paper;
        // Tao's macOS decoration change captures the resizable state and applies
        // its style mask asynchronously. Set the desired capabilities first.
        window.set_resizable(paper).map_err(error)?;
        window.set_minimizable(paper).map_err(error)?;
        window.set_maximizable(paper).map_err(error)?;
        window.set_decorations(paper).map_err(error)?;
        window.set_always_on_top(!paper).map_err(error)?;
        #[cfg(target_os = "windows")]
        window.set_skip_taskbar(!paper).map_err(error)?;
        if paper {
            let width = (self.prefs.paper_size.0 * display.scale)
                .round()
                .clamp(1.0, area.width as f64) as u32;
            // Leave room for the native title bar and frame inside the work area.
            let height = (self.prefs.paper_size.1 * display.scale)
                .round()
                .clamp(1.0, (area.height as f64 - 48.0 * display.scale).max(1.0))
                as u32;
            window
                .set_size(PhysicalSize::new(width, height))
                .map_err(error)?;
            window
                .set_min_size(Some(PhysicalSize::new(
                    (500.0 * display.scale).min(width as f64) as u32,
                    (560.0 * display.scale).min(height as f64) as u32,
                )))
                .map_err(error)?;
            let outer = window.outer_size().map_err(error)?;
            let preferred = self.prefs.paper_position.unwrap_or((
                area.x + (area.width.saturating_sub(outer.width) / 2) as i32,
                area.y + (area.height.saturating_sub(outer.height) / 2) as i32,
            ));
            let pos = geometry::clamp_position(area, (outer.width, outer.height), preferred);
            window
                .set_position(PhysicalPosition::new(pos.0, pos.1))
                .map_err(error)?;
        } else {
            window.unmaximize().map_err(error)?;
            let rect = geometry::edge_rect(&display, self.prefs.height_ratio, view == View::Side);
            window
                .set_size(PhysicalSize::new(rect.width, rect.height))
                .map_err(error)?;
            window
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(error)?;
        }
        self.prefs.monitor = Some(display.name);
        self.displays = all.to_vec();
        Ok(())
    }
    pub fn apply(
        &mut self,
        window: &WebviewWindow,
        view: View,
        focus: bool,
    ) -> Result<Snapshot, String> {
        if view == View::Hidden && !self.tray_ready {
            return Err("托盘尚不可用，窗口已保留。可选择退出且记。".into());
        }
        if view == self.view && window.is_visible().unwrap_or(false) && view != View::Hidden {
            window.unminimize().map_err(|e| e.to_string())?;
            if focus {
                window.set_focus().map_err(|e| e.to_string())?;
            }
            return Ok(self.snapshot());
        }
        self.record_paper(window);
        if view == View::Hidden {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            let all = displays(window)?;
            if let Err(error) = self.layout(window, view, &all) {
                // Restore a reachable full window if a native style/size change
                // fails halfway through. The same webview and workspace survive.
                self.view = View::Paper;
                self.prefs.view = View::Paper;
                let _ = self.layout(window, View::Paper, &all);
                let _ = window.show();
                self.emit(window);
                return Err(error);
            }
            self.prefs.view = view;
            window.show().map_err(|e| e.to_string())?;
            if focus && view != View::Edge {
                window.set_focus().map_err(|e| e.to_string())?;
            }
        }
        self.view = view;
        self.drag = None;
        let mut snapshot = self.snapshot();
        if self.persist().is_err() {
            snapshot.warning =
                Some("窗口位置暂未保存，下次可能恢复默认位置。任务保存不受影响。".into());
        }
        self.emit(window);
        Ok(snapshot)
    }
    pub fn drag(
        &mut self,
        window: &WebviewWindow,
        phase: &str,
        screen_y: f64,
    ) -> Result<(), String> {
        if !screen_y.is_finite() {
            return Err("纸边拖动坐标无效。".into());
        }
        if self.view != View::Edge {
            return Err("只能拖动收起的纸边。".into());
        }
        match phase {
            "begin" => {
                self.drag = Some(Drag {
                    start_y: window.outer_position().map_err(|e| e.to_string())?.y,
                    cursor_y: screen_y,
                    original_ratio: self.prefs.height_ratio,
                });
            }
            "move" => {
                if let Some(drag) = &self.drag {
                    let all = displays(window)?;
                    let d = self.display(&all);
                    let mut r = geometry::edge_rect(&d, self.prefs.height_ratio, false);
                    r.y = geometry::dragged_y(&d, drag.start_y, drag.cursor_y, screen_y, r.height);
                    self.prefs.height_ratio = geometry::height_ratio(d.area, r.y, r.height);
                    window
                        .set_position(PhysicalPosition::new(r.x, r.y))
                        .map_err(|e| e.to_string())?;
                }
            }
            "end" | "cancel" => {
                if let Some(drag) = self.drag.take() {
                    if phase == "cancel" {
                        self.prefs.height_ratio = drag.original_ratio;
                        let all = displays(window)?;
                        self.layout(window, View::Edge, &all)?;
                    }
                    self.persist()?;
                }
            }
            _ => return Err("无效的纸边拖动操作。".into()),
        }
        Ok(())
    }
    pub fn refresh(&mut self, window: &WebviewWindow) {
        if self
            .dirty_since
            .is_some_and(|t| t.elapsed() >= Duration::from_millis(400))
        {
            let _ = self.persist();
        }
        if !matches!(self.view, View::Side | View::Edge) || self.drag.is_some() {
            return;
        }
        if let Ok(all) = displays(window) {
            if all != self.displays {
                let view = self.view;
                if self.layout(window, view, &all).is_ok() {
                    self.emit(window);
                }
            }
        }
    }
}

pub fn request(app: &AppHandle, view: View) {
    if let Some(window) = app.get_webview_window("main") {
        let target = serde_json::to_string(&view).unwrap();
        let _ = window.eval(format!("window.QieJi?.platform?.requestDesktop({target})"));
    }
}

pub fn init_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let paper = MenuItem::with_id(app, "paper", "打开完整清单", true, None::<&str>)?;
    let edge = MenuItem::with_id(app, "edge", "显示纸边", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出且记", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&paper, &edge, &quit])?;
    let mut tray = TrayIconBuilder::with_id("qieji")
        .tooltip("且记")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "paper" => request(app, View::Paper),
            "edge" => request(app, View::Edge),
            "quit" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("window.QieJi?.platform?.requestClose()");
                }
            }
            _ => (),
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                request(tray.app_handle(), View::Paper);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_start_is_full_window_and_settings_are_separate() {
        let temp = tempfile::tempdir().unwrap();
        let desktop = Desktop::new(temp.path().into());
        assert_eq!(desktop.view, View::Paper);
        assert!(!desktop.snapshot().tray_ready);
        assert!(!temp.path().join("workspace.json").exists());
    }
    #[test]
    fn hidden_and_invalid_settings_never_make_startup_inaccessible() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("window-preferences.json"),
            br#"{"view":"hidden","heightRatio":99,"paperSize":[-1,0]}"#,
        )
        .unwrap();
        let desktop = Desktop::new(temp.path().into());
        assert_eq!(desktop.view, View::Paper);
        assert_eq!(desktop.prefs.height_ratio, 1.0);
        assert_eq!(desktop.prefs.paper_size, (720.0, 840.0));
    }
    #[test]
    fn saved_side_mode_and_relative_height_are_read_back() {
        let temp = tempfile::tempdir().unwrap();
        let mut desktop = Desktop::new(temp.path().into());
        desktop.prefs.view = View::Edge;
        desktop.prefs.height_ratio = 0.3;
        desktop.persist().unwrap();
        let restored = Desktop::new(temp.path().into());
        assert_eq!(restored.view, View::Edge);
        assert_eq!(restored.prefs.height_ratio, 0.3);
    }
    #[test]
    fn broken_window_preferences_do_not_read_or_replace_tasks() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("window-preferences.json"), "invalid").unwrap();
        std::fs::write(temp.path().join("workspace.json"), "sentinel").unwrap();
        assert_eq!(Desktop::new(temp.path().into()).view, View::Paper);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("workspace.json")).unwrap(),
            "sentinel"
        );
    }
}

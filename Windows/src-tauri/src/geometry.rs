use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Display {
    pub name: String,
    pub area: Rect,
    pub scale: f64,
}

pub fn edge_rect(display: &Display, ratio: f64, open: bool) -> Rect {
    let area = display.area;
    let scale = display.scale;
    let width = ((if open { 470.0 } else { 54.0 }) * scale).round() as u32;
    let height = ((if open { 760.0 } else { 170.0 }) * scale).round() as u32;
    let width = width.min(area.width).max(1);
    let height = height.min(area.height).max(1);
    let tab_height = (170.0 * scale).round().min(area.height as f64);
    let ratio = if ratio.is_finite() {
        ratio.clamp(0.0, 1.0)
    } else {
        0.5
    };
    let center = area.y as f64 + ratio * (area.height as f64 - tab_height) + tab_height / 2.0;
    let y = (center - height as f64 / 2.0).round() as i32;
    Rect {
        x: area
            .x
            .saturating_add(area.width as i32)
            .saturating_sub(width as i32),
        y: y.clamp(area.y, area.y.saturating_add((area.height - height) as i32)),
        width,
        height,
    }
}

pub fn dragged_y(display: &Display, start_y: i32, origin: f64, current: f64, height: u32) -> i32 {
    let delta = ((current - origin) * display.scale).round() as i32;
    start_y.saturating_add(delta).clamp(
        display.area.y,
        display
            .area
            .y
            .saturating_add(display.area.height.saturating_sub(height) as i32),
    )
}

pub fn height_ratio(area: Rect, y: i32, height: u32) -> f64 {
    let travel = area.height.saturating_sub(height);
    if travel == 0 {
        return 0.5;
    }
    ((y as f64 - area.y as f64) / travel as f64).clamp(0.0, 1.0)
}

pub fn clamp_position(area: Rect, size: (u32, u32), position: (i32, i32)) -> (i32, i32) {
    (
        position.0.clamp(
            area.x,
            area.x
                .saturating_add(area.width.saturating_sub(size.0) as i32),
        ),
        position.1.clamp(
            area.y,
            area.y
                .saturating_add(area.height.saturating_sub(size.1) as i32),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display(scale: f64) -> Display {
        Display {
            name: "synthetic".into(),
            area: Rect {
                x: -1920,
                y: 40,
                width: 1920,
                height: 1040,
            },
            scale,
        }
    }
    #[test]
    fn right_edge_uses_work_area_and_negative_monitor_origin() {
        let r = edge_rect(&display(1.0), 0.5, false);
        assert_eq!(r.x + r.width as i32, 0);
        assert!(r.y >= 40 && r.y + r.height as i32 <= 1080);
        assert_eq!(r.width, 54);
    }
    #[test]
    fn edge_is_correct_at_all_target_scales() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let r = edge_rect(&display(scale), 0.5, false);
            assert_eq!(r.width, (54.0 * scale).round() as u32);
            assert_eq!(r.x + r.width as i32, 0);
        }
    }
    #[test]
    fn expanded_panel_stays_inside_short_work_area() {
        let d = Display {
            area: Rect {
                x: 0,
                y: 0,
                width: 600,
                height: 500,
            },
            ..display(1.5)
        };
        for ratio in [0.0, 0.5, 1.0] {
            let r = edge_rect(&d, ratio, true);
            assert!(r.x >= 0 && r.y >= 0);
            assert!(r.width <= 600 && r.height <= 500);
        }
    }
    #[test]
    fn invalid_or_extreme_ratios_do_not_lose_the_window() {
        for ratio in [f64::NAN, -100.0, 100.0] {
            let r = edge_rect(&display(1.0), ratio, false);
            assert!(r.y >= 40 && r.y + r.height as i32 <= 1080);
        }
    }
    #[test]
    fn drag_ratio_round_trip_and_clamping() {
        let d = display(1.0);
        for ratio in [0.0, 0.25, 0.5, 1.0] {
            let r = edge_rect(&d, ratio, false);
            assert!((height_ratio(d.area, r.y, r.height) - ratio).abs() < 0.002);
        }
        assert_eq!(height_ratio(d.area, -9999, 170), 0.0);
        assert_eq!(height_ratio(d.area, 9999, 170), 1.0);
    }
    #[test]
    fn unplugged_monitor_position_returns_inside_primary() {
        let area = Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 680,
        };
        assert_eq!(clamp_position(area, (720, 600), (-1800, 900)), (0, 80));
    }
    #[test]
    fn gesture_delta_scales_without_reading_global_cursor() {
        assert_eq!(dragged_y(&display(1.5), 200, 100.0, 140.0, 255), 260);
        assert_eq!(dragged_y(&display(1.0), 200, 100.0, 140.0, 170), 240);
    }
    #[test]
    fn extreme_gesture_coordinates_clamp_without_overflow() {
        assert_eq!(dragged_y(&display(1.0), 200, 0.0, f64::MAX, 170), 910);
        assert_eq!(dragged_y(&display(1.0), 200, 0.0, -f64::MAX, 170), 40);
    }
}

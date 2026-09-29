//! Thin Rust boundary for the single-frame ScreenCaptureKit implementation.
//! Native allocations are copied into Rust-owned memory before the boundary returns.

use std::{ffi::{c_char, CStr}, ptr, slice};

use super::{ScreenCapture, WindowTarget};

#[repr(C)]
#[derive(Clone, Copy)]
struct NativeWindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[repr(C)]
struct NativeCapture {
    png: *mut u8,
    png_length: usize,
    x: f64,
    y: f64,
    logical_width: f64,
    logical_height: f64,
    targets: *mut NativeWindowRect,
    target_count: usize,
    error: *mut c_char,
}

unsafe extern "C" {
    fn tb_capture_current_display(output: *mut NativeCapture) -> i32;
    fn tb_free_capture(capture: *mut NativeCapture);
    fn tb_copy_png_to_clipboard(bytes: *const u8, length: usize) -> i32;
    fn tb_set_window_frame(window: *mut std::ffi::c_void, x: f64, y: f64, width: f64, height: f64) -> i32;
}

pub(super) fn capture_current_monitor() -> Result<ScreenCapture, String> {
    let mut native = NativeCapture {
        png: ptr::null_mut(),
        png_length: 0,
        x: 0.0,
        y: 0.0,
        logical_width: 0.0,
        logical_height: 0.0,
        targets: ptr::null_mut(),
        target_count: 0,
        error: ptr::null_mut(),
    };
    let success = unsafe { tb_capture_current_display(&mut native) } != 0;
    let result = if success {
        (|| {
            if native.png.is_null() || native.png_length == 0 || native.logical_width <= 0.0 || native.logical_height <= 0.0 {
                return Err("屏幕截图数据无效".to_string());
            }
            let png = unsafe { slice::from_raw_parts(native.png, native.png_length) }.to_vec();
            let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&png), image::ImageFormat::Png)
                .into_dimensions()
                .map_err(|_| "屏幕截图图片无效".to_string())?;
            let window_targets = if native.targets.is_null() || native.target_count == 0 {
                Vec::new()
            } else {
                unsafe { slice::from_raw_parts(native.targets, native.target_count) }
                    .iter()
                    .map(|target| WindowTarget {
                        x: target.x,
                        y: target.y,
                        width: target.width,
                        height: target.height,
                    })
                    .collect()
            };
            Ok(ScreenCapture {
                png,
                width,
                height,
                x: native.x.round() as i32,
                y: native.y.round() as i32,
                logical_size: Some((native.logical_width, native.logical_height)),
                window_targets,
            })
        })()
    } else {
        Err(if native.error.is_null() {
            "无法捕获屏幕".to_string()
        } else {
            unsafe { CStr::from_ptr(native.error) }.to_string_lossy().into_owned()
        })
    };
    unsafe { tb_free_capture(&mut native) };
    result
}

pub(super) fn copy_png_to_clipboard(png: &[u8]) -> Result<(), String> {
    if unsafe { tb_copy_png_to_clipboard(png.as_ptr(), png.len()) } != 0 {
        Ok(())
    } else {
        Err("无法将截图复制到剪贴板".to_string())
    }
}

pub(super) fn set_window_frame(window: &tauri::WebviewWindow, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let native = window.ns_window().map_err(|error| error.to_string())?;
    if unsafe { tb_set_window_frame(native, x, y, width, height) } != 0 {
        Ok(())
    } else {
        Err("无法设置截图窗口位置".to_string())
    }
}

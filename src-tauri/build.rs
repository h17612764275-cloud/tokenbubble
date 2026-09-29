fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/screenshot_macos.m");
        cc::Build::new()
            .file("src/screenshot_macos.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("screenshot_macos");
        for framework in ["AppKit", "CoreGraphics", "CoreFoundation", "ImageIO", "ScreenCaptureKit", "UniformTypeIdentifiers"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}

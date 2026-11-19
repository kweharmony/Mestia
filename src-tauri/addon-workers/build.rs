fn main() {
    println!("cargo:rustc-check-cfg=cfg(mestia_addon)");
    println!("cargo:rustc-check-cfg=cfg(desktop)");
    println!("cargo:rustc-check-cfg=cfg(mobile)");
    println!("cargo:rustc-cfg=mestia_addon");
    let platform = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    println!(
        "cargo:rustc-cfg={}",
        if platform == "android" {
            "mobile"
        } else {
            "desktop"
        }
    );
}

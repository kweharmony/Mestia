fn main() {
    println!("cargo:rustc-check-cfg=cfg(mestia_addon)");
    tauri_build::build()
}

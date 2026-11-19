"""Собирает APK-модули под подпись и номер версии готового APK Mestia."""

import argparse
import json
import os
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "src-tauri"
ABIS = {
    "arm64-v8a": ("aarch64-linux-android", "aarch64-linux-android", "arm64"),
    "armeabi-v7a": ("armv7-linux-androideabi", "armv7a-linux-androideabi", "armv7"),
    "x86_64": ("x86_64-linux-android", "x86_64-linux-android", "x86_64"),
}


def run(*args, capture=False, env=None):
    return subprocess.run(args, cwd=TAURI, check=True, text=True, capture_output=capture, env=env).stdout


def properties(path):
    return dict(line.split("=", 1) for line in path.read_text(encoding="utf-8").splitlines() if "=" in line and not line.lstrip().startswith("#"))


def certificate(apksigner, apk):
    output = run(*apksigner, "verify", "--print-certs", apk, capture=True)
    result = tuple(re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)", output))
    if not result:
        raise SystemExit("Could not read the APK signing certificate")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_apk", type=lambda path: Path(path).resolve())
    parser.add_argument("--abi", choices=ABIS, required=True)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    sdk = Path(os.environ["ANDROID_HOME"])
    ndk = Path(os.environ["NDK_HOME"])
    windows = os.name == "nt"
    exe = ".exe" if windows else ""
    tools = sdk / "build-tools" / "36.0.0"
    platform = sdk / "platforms" / "android-36" / "android.jar"
    java_home = os.environ.get("JAVA_HOME")
    java = Path(java_home) / "bin" / f"java{exe}" if java_home else "java"
    apksigner = (java, "-jar", tools / "lib" / "apksigner.jar")
    base_certificate = certificate(apksigner, args.base_apk)
    badging = run(tools / f"aapt2{exe}", "dump", "badging", args.base_apk, capture=True)
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    config = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    if not package or package[1] != config["identifier"] or package[3] != config["version"]:
        raise SystemExit("The base APK must match the current Mestia package and version")
    package_name, version_code, version = package.groups()
    with zipfile.ZipFile(args.base_apk) as archive:
        if f"lib/{args.abi}/libmestia_lib.so" not in archive.namelist():
            raise SystemExit("The base APK does not contain the requested ABI")

    if args.debug:
        android_user_home = Path(os.environ.get("ANDROID_USER_HOME", Path.home() / ".android"))
        key = android_user_home / "debug.keystore"
        alias = "androiddebugkey"
        store_password = key_password = "android"
    else:
        android_project = TAURI / "gen" / "android"
        signing = properties(android_project / "keystore.properties")
        key = android_project / signing["storeFile"]
        alias = signing["keyAlias"]
        store_password, key_password = signing["storePassword"], signing["keyPassword"]

    target, clang_target, suffix = ABIS[args.abi]
    host = next((ndk / "toolchains" / "llvm" / "prebuilt").glob("windows-*" if windows else "linux-*"))
    compiler = host / "bin" / f"{clang_target}30-clang{'.cmd' if windows else ''}"
    cargo_env = {**os.environ, f"CARGO_TARGET_{target.upper().replace('-', '_')}_LINKER": str(compiler)}
    run("cargo", "build", "--locked", "--release", "--target", target, "-p", "mestia-addon-workers", "--bins", env=cargo_env)

    target_dir = TAURI / "target"
    out_dir = target_dir / "addon-apks"
    out_dir.mkdir(parents=True, exist_ok=True)
    sign_env = {**os.environ, "MESTIA_APK_STORE_PASSWORD": store_password, "MESTIA_APK_KEY_PASSWORD": key_password}
    with tempfile.TemporaryDirectory(prefix="split-", dir=out_dir) as staging:
        staging = Path(staging)
        for addon in ("tags", "nearby"):
            manifest = staging / f"{addon}.xml"
            manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="{package_name}" split="mestia_{addon}" android:isFeatureSplit="true"
    android:versionCode="{version_code}" android:versionName="{version}">
    <application android:hasCode="false" />
</manifest>''', encoding="utf-8")
            unsigned = staging / f"{addon}-raw.apk"
            aligned = staging / f"{addon}-aligned.apk"
            filename = f"Mestia_Addon_{addon}_{version}_android_{suffix}.apk"
            signed = staging / filename
            run(tools / f"aapt2{exe}", "link", "-I", platform, "--manifest", manifest,
                "--min-sdk-version", "30", "--target-sdk-version", "36", "-o", unsigned)
            worker = target_dir / target / "release" / f"mestia-addon-{addon}"
            with zipfile.ZipFile(unsigned, "a", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(worker, f"lib/{args.abi}/libmestia_addon_{addon}.so")
            run(tools / f"zipalign{exe}", "-P", "16", "-f", "4", unsigned, aligned)
            run(*apksigner, "sign", "--ks", key, "--ks-key-alias", alias,
                "--ks-pass", "env:MESTIA_APK_STORE_PASSWORD", "--key-pass", "env:MESTIA_APK_KEY_PASSWORD",
                "--v4-signing-enabled", "false", "--out", signed, aligned, env=sign_env)
            if certificate(apksigner, signed) != base_certificate:
                raise SystemExit("The add-on APK signer does not match the base Mestia APK")
        for signed in staging.glob("Mestia_Addon_*.apk"):
            destination = out_dir / signed.name
            signed.replace(destination)
            print(destination)


if __name__ == "__main__":
    main()

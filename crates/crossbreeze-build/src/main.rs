//! Native distribution staging without Node or npm.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn target(name: &str) -> Option<&'static str> {
    Some(match name {
        "windows-x86_64" => "x86_64-pc-windows-msvc",
        "windows-arm64" => "aarch64-pc-windows-msvc",
        "linux-x86_64" => "x86_64-unknown-linux-musl",
        "linux-arm64" => "aarch64-unknown-linux-musl",
        "mac-x86_64" => "x86_64-apple-darwin",
        "mac-arm64" => "aarch64-apple-darwin",
        _ => return None,
    })
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("bundle") {
        return Err(
            "Usage: cargo run -p crossbreeze-build -- bundle --target <os>-<arch> [--debug]".into(),
        );
    }
    let name = args
        .windows(2)
        .find(|a| a[0] == "--target")
        .map(|a| a[1].as_str())
        .ok_or("Missing --target")?;
    let triple = target(name).ok_or("Unsupported distribution target")?;
    let debug = args.iter().any(|a| a == "--debug");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let version = Command::new(&cargo)
        .args(["--version", "--verbose"])
        .output()?;
    let version = String::from_utf8(version.stdout)?;
    let host = version
        .lines()
        .find_map(|line| line.strip_prefix("host: "))
        .ok_or("Cannot identify Cargo host target")?;
    let mut build = Command::new(&cargo);
    build
        .current_dir(&root)
        .args(["build", "--locked", "-p", "crossbreeze", "-j", "1"]);
    if triple != host {
        build.args(["--target", triple]);
    }
    if !debug {
        build.arg("--release");
    }
    if !build.status()?.success() {
        return Err("Native server build failed".into());
    }
    let metadata = Command::new(&cargo)
        .current_dir(&root)
        .args([
            "metadata",
            "--locked",
            "--format-version",
            "1",
            "--filter-platform",
            triple,
        ])
        .output()?;
    if !metadata.status.success() {
        return Err("Cargo dependency metadata failed".into());
    }
    let metadata: Value = serde_json::from_slice(&metadata.stdout)?;
    let executable = if name.starts_with("windows-") {
        "crossbreeze.exe"
    } else {
        "crossbreeze"
    };
    let profile = if debug { "debug" } else { "release" };
    let mut artifact = PathBuf::from(
        metadata["target_directory"]
            .as_str()
            .ok_or("Missing Cargo target directory")?,
    );
    if triple != host {
        artifact = artifact.join(triple);
    }
    let artifact = artifact.join(profile).join(executable);
    let destination = root.join("dist/native").join(name).join("server");
    if !destination.starts_with(root.join("dist/native")) {
        return Err("Invalid staging destination".into());
    }
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    fs::create_dir_all(destination.join("licenses"))?;
    fs::copy(artifact, destination.join(executable))?;
    fs::copy(root.join("Cargo.lock"), destination.join("Cargo.lock"))?;
    let mut hashes = BTreeMap::new();
    record(&destination, executable, &mut hashes)?;
    record(&destination, "Cargo.lock", &mut hashes)?;
    let mut packages = Vec::new();
    for package in metadata["packages"].as_array().ok_or("Missing packages")? {
        if package["name"] == "crossbreeze-build" {
            continue;
        }
        let id = format!(
            "{}-{}",
            package["name"].as_str().unwrap(),
            package["version"].as_str().unwrap()
        );
        let path = Path::new(package["manifest_path"].as_str().unwrap())
            .parent()
            .unwrap();
        let mut notices = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let filename = entry.file_name().to_string_lossy().into_owned();
            let upper = filename.to_ascii_uppercase();
            if entry.file_type()?.is_file()
                && (upper.contains("LICENSE")
                    || upper.starts_with("COPYING")
                    || upper.contains("NOTICE"))
            {
                let relative = format!("licenses/{id}/{filename}");
                fs::create_dir_all(destination.join("licenses").join(&id))?;
                fs::copy(entry.path(), destination.join(&relative))?;
                record(&destination, &relative, &mut hashes)?;
                notices.push(relative);
            }
        }
        packages.push(json!({"name":package["name"],"version":package["version"],"license":package["license"],"source":package["source"],"notices":notices}));
    }
    fs::write(
        destination.join("native-manifest.json"),
        serde_json::to_vec_pretty(
            &json!({"target":name,"rustTarget":triple,"profile":profile,"files":hashes,"packages":packages}),
        )?,
    )?;
    println!("Staged native server at {}", destination.display());
    Ok(())
}

fn record(root: &Path, name: &str, hashes: &mut BTreeMap<String, String>) -> std::io::Result<()> {
    hashes.insert(
        name.into(),
        format!("{:x}", Sha256::digest(fs::read(root.join(name))?)),
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_six_distribution_targets_have_native_toolchains() {
        for name in [
            "windows-x86_64",
            "windows-arm64",
            "linux-x86_64",
            "linux-arm64",
            "mac-x86_64",
            "mac-arm64",
        ] {
            assert!(target(name).is_some());
        }
        assert!(target("unknown").is_none());
    }
}

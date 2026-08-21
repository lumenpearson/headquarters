use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let workspace_root = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../../..");
    let proto_root = workspace_root.join("packages/protocol/proto");
    let protobuf_include = protoc_bin_vendored::include_path()?;
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let proto_files = [
        "gremuchaya/bridge/v1/bridge.proto",
        "gremuchaya/common/v1/common.proto",
        "gremuchaya/control/v1/control.proto",
        "gremuchaya/integration/v1/integration.proto",
        "gremuchaya/material/v1/material.proto",
        "gremuchaya/realtime/v1/realtime.proto",
        "gremuchaya/settings/v1/settings.proto",
        "gremuchaya/sync/v1/sync.proto",
        "gremuchaya/telemetry/v1/telemetry.proto",
    ]
    .map(|relative_path| proto_root.join(relative_path));

    for proto_file in &proto_files {
        println!("cargo:rerun-if-changed={}", proto_file.display());
    }
    println!("cargo:rerun-if-changed={}", proto_root.display());

    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.include_file("gremuchaya.protocol.v1.rs");
    config.compile_protos(&proto_files, &[proto_root, protobuf_include])?;

    tauri_build::build();

    Ok(())
}

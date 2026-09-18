use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    println!("cargo:rerun-if-changed=web/dist");
    let root = PathBuf::from("web").join("dist");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("assets.rs");
    let mut files = Vec::new();
    if root.is_dir() {
        collect(&root, &root, &mut files);
    }
    files.sort();

    let mut generated = String::from(
        "pub fn embedded_asset(path: &str) -> Option<&'static [u8]> {\n    match path {\n",
    );
    for (name, path) in files {
        generated.push_str(&format!(
            "        {name:?} => Some(include_bytes!({path:?})),\n",
            name = name,
            path = path.canonicalize().expect("asset path").to_string_lossy()
        ));
    }
    if !root.join("index.html").is_file() {
        generated.push_str(
            "        \"index.html\" => Some(b\"<!doctype html><html><head><meta charset=\\\"utf-8\\\"><title>Simple Multicast Share</title></head><body><h1>Simple Multicast Share</h1><p>Web assets were not present when the server was built.</p></body></html>\"),\n",
        );
    }
    generated.push_str("        _ => None,\n    }\n}\n");
    fs::write(output, generated).expect("write generated assets");
}

fn collect(root: &Path, directory: &Path, files: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(directory).expect("read web/dist") {
        let entry = entry.expect("web asset entry");
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, files);
        } else if path.is_file() {
            let name = path
                .strip_prefix(root)
                .expect("asset under root")
                .to_string_lossy()
                .replace('\\', "/");
            files.push((name, path));
        }
    }
}

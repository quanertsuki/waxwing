use serde_json::{Map, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

const DEFAULT_PORT: u16 = 43187;

fn env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
}

fn absolute_from_cwd(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Ok(path);
    }
    env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|error| format!("Cannot resolve relative path {value}: {error}"))
}

fn contains_backend(root: &Path) -> bool {
    root.join("prototype").join("server.mjs").is_file()
        || root
            .join("backend")
            .join("prototype")
            .join("server.mjs")
            .is_file()
}

/// Locate the backend root in development or in the portable resource layout.
/// Release builds only inspect paths next to the executable; development
/// builds may additionally use the checkout that produced the binary.
pub fn repo_root() -> Result<PathBuf, String> {
    if let Some(value) = env_value(&["WAXWING_BACKEND_DIR", "DSH_SUBAGENT_REPO"]) {
        let root = absolute_from_cwd(&value)?;
        if !contains_backend(&root) {
            return Err(format!(
                "WAXWING_BACKEND_DIR does not contain prototype/server.mjs: {}",
                root.display()
            ));
        }
        return fs::canonicalize(root)
            .map_err(|error| format!("Cannot resolve backend root: {error}"));
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(containing_directory) = exe.parent() {
            candidates.push(containing_directory.join("resources").join("backend"));
            candidates.push(containing_directory.join("backend"));
            candidates.push(containing_directory.to_path_buf());
            if let Some(parent) = containing_directory.parent() {
                candidates.push(parent.join("Resources").join("backend"));
            }
        }
    }

    if cfg!(debug_assertions) {
        candidates.insert(0, PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
        if let Ok(cwd) = env::current_dir() {
            candidates.push(cwd);
        }
        if let Some(manifest_root) = candidates.first() {
            for ancestor in manifest_root.ancestors() {
                if contains_backend(ancestor) {
                    return fs::canonicalize(ancestor)
                        .map_err(|error| format!("Cannot resolve backend root: {error}"));
                }
            }
        }
    }

    for candidate in candidates {
        if !contains_backend(&candidate) {
            continue;
        }
        let root = if candidate
            .join("backend")
            .join("prototype")
            .join("server.mjs")
            .is_file()
        {
            candidate.join("backend")
        } else {
            candidate
        };
        return fs::canonicalize(root)
            .map_err(|error| format!("Cannot resolve backend root: {error}"));
    }

    Err("Cannot locate the Waxwing backend. Set WAXWING_BACKEND_DIR to the directory containing prototype/server.mjs.".to_string())
}

#[cfg(debug_assertions)]
fn development_repo_root() -> Result<PathBuf, String> {
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for start in [manifest_root] {
        for ancestor in start.ancestors() {
            if contains_backend(ancestor) {
                return fs::canonicalize(ancestor)
                    .map_err(|error| format!("Cannot resolve repository root: {error}"));
            }
        }
    }
    Err("Cannot locate development backend resources".to_string())
}

pub fn config_path() -> Result<PathBuf, String> {
    if let Some(value) = env_value(&["WAXWING_CONFIG", "DSH_SUBAGENT_CONFIG"]) {
        return absolute_from_cwd(&value);
    }
    let root = repo_root()?;
    let candidate = if root
        .join("backend")
        .join("prototype")
        .join("config.json")
        .is_file()
    {
        root.join("backend").join("prototype").join("config.json")
    } else {
        root.join("prototype").join("config.json")
    };
    Ok(candidate)
}

pub fn local_config_path() -> Result<PathBuf, String> {
    if let Some(value) = env_value(&["WAXWING_LOCAL_CONFIG", "DSH_SUBAGENT_LOCAL_CONFIG"]) {
        return absolute_from_cwd(&value);
    }
    Ok(config_path()?
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("config.local.json"))
}

pub fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Invalid JSON in {}: {error}", path.display()))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))
}

fn merge_objects(base: &mut Map<String, Value>, overlay: &Map<String, Value>) {
    for (key, value) in overlay {
        match (base.get_mut(key), value) {
            (Some(Value::Object(base_nested)), Value::Object(overlay_nested)) => {
                merge_objects(base_nested, overlay_nested);
            }
            _ => {
                base.insert(key.clone(), value.clone());
            }
        }
    }
}

/// Effective file configuration with the same layering as the Node manager:
/// public config followed by ignored local overrides. Path environment
/// variables are applied by the accessors below.
pub fn effective_config() -> Result<Map<String, Value>, String> {
    let public_path = config_path()?;
    let local_path = local_config_path()?;
    let mut config = read_json_object(&public_path)?;
    if local_path != public_path {
        merge_objects(&mut config, &read_json_object(&local_path)?);
    }
    Ok(config)
}

pub fn write_json_object(path: &Path, value: &Map<String, Value>) -> Result<(), String> {
    if let Some(containing_directory) = path.parent() {
        fs::create_dir_all(containing_directory).map_err(|error| {
            format!("Cannot create {}: {error}", containing_directory.display())
        })?;
    }
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Cannot serialize configuration: {error}"))?;
    let temporary = path.with_extension("json.new");
    fs::write(&temporary, format!("{text}\n"))
        .map_err(|error| format!("Cannot write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Cannot replace {}: {error}", path.display()))
}

fn resolve_config_path(value: &str, config_dir: &Path) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        config_dir.join(path)
    }
}

fn config_dir() -> Result<PathBuf, String> {
    Ok(config_path()?
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf())
}

fn resolve_executable(value: &str, config_dir: &Path) -> String {
    let path = PathBuf::from(value);
    if path.is_absolute() || value.contains('/') || value.contains('\\') {
        resolve_config_path(value, config_dir)
            .to_string_lossy()
            .into_owned()
    } else {
        value.to_string()
    }
}

pub fn data_root() -> Result<PathBuf, String> {
    if let Some(value) = env_value(&["WAXWING_HOME", "DSH_SUBAGENT_ROOT", "DSH_PROTOTYPE_ROOT"]) {
        return Ok(resolve_config_path(&value, &config_dir()?));
    }
    let config = effective_config()?;
    let config_dir = config_dir()?;
    if let Some(value) = config.get("root").and_then(Value::as_str) {
        return Ok(resolve_config_path(value, &config_dir));
    }
    if cfg!(windows) {
        if let Some(value) = env::var_os("LOCALAPPDATA") {
            return Ok(PathBuf::from(value).join("Waxwing"));
        }
    }
    if cfg!(target_os = "macos") {
        if let Some(home) = env::var_os("HOME") {
            return Ok(PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Waxwing"));
        }
    }
    if let Some(value) = env::var_os("XDG_DATA_HOME") {
        return Ok(PathBuf::from(value).join("waxwing"));
    }
    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("waxwing"));
    }
    #[cfg(debug_assertions)]
    {
        return development_repo_root().map(|root| root.join("data"));
    }
    #[cfg(not(debug_assertions))]
    Err("Cannot determine a per-user Waxwing data directory".to_string())
}

pub fn providers_dir() -> Result<PathBuf, String> {
    if let Some(value) = env_value(&["WAXWING_PROVIDERS_DIR", "DSH_SUBAGENT_PROVIDERS_DIR"]) {
        return Ok(resolve_config_path(&value, &config_dir()?));
    }
    let config = effective_config()?;
    let config_dir = config_dir()?;
    if let Some(value) = config.get("providersDir").and_then(Value::as_str) {
        return Ok(resolve_config_path(value, &config_dir));
    }
    Ok(data_root()?.join("providers"))
}

pub fn node_command() -> Result<String, String> {
    if let Some(value) = env_value(&["WAXWING_NODE", "DSH_SUBAGENT_NODE", "DSH_PROTOTYPE_NODE"]) {
        return Ok(resolve_executable(&value, &config_dir()?));
    }
    let config = effective_config()?;
    let value = config
        .get("node")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if value.is_empty() {
        if let Ok(exe) = env::current_exe() {
            if let Some(parent) = exe.parent() {
                let bundled = parent
                    .join("resources")
                    .join("node")
                    .join(if cfg!(windows) { "node.exe" } else { "node" });
                if bundled.is_file() {
                    return Ok(bundled.to_string_lossy().into_owned());
                }
            }
        }
        return Ok("node".to_string());
    }
    Ok(resolve_executable(value, &config_dir()?))
}

pub fn port() -> Result<u16, String> {
    if let Some(value) = env_value(&["WAXWING_PORT", "DSH_SUBAGENT_PORT", "DSH_PROTOTYPE_PORT"]) {
        return value
            .parse::<u16>()
            .map_err(|_| format!("Port must be an integer between 1 and 65535, got {value}"));
    }
    let config = effective_config()?;
    match config.get("port").and_then(Value::as_u64) {
        Some(value) if (1..=u16::MAX as u64).contains(&value) => Ok(value as u16),
        Some(value) => Err(format!("Port must be between 1 and 65535, got {value}")),
        None => Ok(DEFAULT_PORT),
    }
}

pub fn manager_url() -> Result<String, String> {
    Ok(format!("http://127.0.0.1:{}/api", port()?))
}

pub fn manager_script() -> Result<PathBuf, String> {
    let root = repo_root()?;
    let script = if root
        .join("backend")
        .join("prototype")
        .join("server.mjs")
        .is_file()
    {
        root.join("backend").join("prototype").join("server.mjs")
    } else {
        root.join("prototype").join("server.mjs")
    };
    if !script.is_file() {
        return Err(format!(
            "Manager script does not exist: {}. Set WAXWING_BACKEND_DIR to the backend root.",
            script.display()
        ));
    }
    Ok(script)
}

pub fn server_token() -> Result<PathBuf, String> {
    Ok(data_root()?.join("runtime").join("server-token"))
}

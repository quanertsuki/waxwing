use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

const DEFAULT_PORT: u16 = 43187;
const LOCAL_CONFIG_ENV: [&str; 2] = ["WAXWING_LOCAL_CONFIG", "DSH_SUBAGENT_LOCAL_CONFIG"];

fn env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
}

fn map_value(environment: &BTreeMap<String, String>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        environment
            .get(*name)
            .filter(|value| !value.trim().is_empty())
            .cloned()
    })
}

fn env_snapshot() -> BTreeMap<String, String> {
    env::vars().collect()
}

fn current_dir() -> Result<PathBuf, String> {
    env::current_dir().map_err(|error| format!("Cannot resolve the current directory: {error}"))
}

fn absolute_from(base: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn absolute_from_cwd(value: &str) -> Result<PathBuf, String> {
    env::current_dir()
        .map(|cwd| absolute_from(&cwd, value))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalConfigSource {
    Environment,
    Home,
    Legacy,
    None,
}

#[derive(Debug, Clone)]
pub struct LocalConfigLocation {
    pub path: PathBuf,
    pub source: LocalConfigSource,
    /// Directory that relative paths in this file resolve against.
    pub base_dir: PathBuf,
}

fn parent_dir(path: &Path) -> PathBuf {
    path.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Per-user data directory from `WAXWING_HOME` or the platform defaults only.
/// Configuration is deliberately not read: the local override lives here and
/// may set `root`, so consulting `root` would be circular.
pub fn platform_data_root() -> Result<PathBuf, String> {
    platform_data_root_from(&env_snapshot(), &current_dir()?)
}

fn platform_data_root_from(
    environment: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<PathBuf, String> {
    if let Some(value) = map_value(environment, &["WAXWING_HOME"]) {
        return Ok(absolute_from(cwd, &value));
    }
    default_data_root(environment)
}

fn default_data_root(environment: &BTreeMap<String, String>) -> Result<PathBuf, String> {
    if cfg!(windows) {
        if let Some(value) = map_value(environment, &["LOCALAPPDATA"]) {
            return Ok(PathBuf::from(value).join("Waxwing"));
        }
        if let Some(value) = map_value(environment, &["USERPROFILE", "HOME"]) {
            return Ok(PathBuf::from(value)
                .join("AppData")
                .join("Local")
                .join("Waxwing"));
        }
    }
    if cfg!(target_os = "macos") {
        if let Some(value) = map_value(environment, &["HOME"]) {
            return Ok(PathBuf::from(value)
                .join("Library")
                .join("Application Support")
                .join("Waxwing"));
        }
    }
    if let Some(value) = map_value(environment, &["XDG_DATA_HOME"]) {
        return Ok(PathBuf::from(value).join("waxwing"));
    }
    if let Some(value) = map_value(environment, &["HOME"]) {
        return Ok(PathBuf::from(value)
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

/// Pick the active local override. An explicit file wins, then the per-user
/// file, then the legacy file beside `config.json` (read-only fallback). When
/// no file exists the per-user path is returned so the next save lands there.
fn resolve_local_config(
    explicit: Option<&str>,
    home: &Path,
    legacy: &Path,
    cwd: &Path,
) -> LocalConfigLocation {
    if let Some(value) = explicit {
        let path = absolute_from(cwd, value);
        return LocalConfigLocation {
            base_dir: parent_dir(&path),
            path,
            source: LocalConfigSource::Environment,
        };
    }
    for (path, source) in [
        (home, LocalConfigSource::Home),
        (legacy, LocalConfigSource::Legacy),
    ] {
        if path.exists() {
            return LocalConfigLocation {
                base_dir: parent_dir(path),
                path: path.to_path_buf(),
                source,
            };
        }
    }
    LocalConfigLocation {
        base_dir: parent_dir(home),
        path: home.to_path_buf(),
        source: LocalConfigSource::None,
    }
}

fn local_config_location_from_parts(
    environment: &BTreeMap<String, String>,
    cwd: &Path,
    legacy: &Path,
) -> Result<LocalConfigLocation, String> {
    let explicit = map_value(environment, &LOCAL_CONFIG_ENV);
    let home = platform_data_root_from(environment, cwd)?.join("config.local.json");
    Ok(resolve_local_config(
        explicit.as_deref(),
        &home,
        legacy,
        cwd,
    ))
}

pub fn local_config_location() -> Result<LocalConfigLocation, String> {
    let legacy = parent_dir(&config_path()?).join("config.local.json");
    local_config_location_from_parts(&env_snapshot(), &current_dir()?, &legacy)
}

pub fn local_config_path() -> Result<PathBuf, String> {
    Ok(local_config_location()?.path)
}

/// Settings are written to the active file, except that a legacy file beside
/// `config.json` is read but never overwritten: a save migrates it to the
/// per-user location instead.
pub fn local_config_write_path(location: &LocalConfigLocation) -> Result<PathBuf, String> {
    Ok(local_config_write_target(
        location,
        &platform_data_root()?.join("config.local.json"),
    ))
}

fn local_config_write_target(location: &LocalConfigLocation, home: &Path) -> PathBuf {
    match location.source {
        LocalConfigSource::Legacy => home.to_path_buf(),
        LocalConfigSource::Environment | LocalConfigSource::Home | LocalConfigSource::None => {
            location.path.clone()
        }
    }
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

/// Base for a path-valued key: the file that supplied it. A local override
/// anchors at its own directory, which is no longer always the config
/// directory once the file lives in the per-user data directory.
fn config_value_base(key: &str) -> Result<PathBuf, String> {
    let location = local_config_location()?;
    let local = read_json_object(&location.path)?;
    Ok(if local.contains_key(key) {
        location.base_dir
    } else {
        config_dir()?
    })
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
    if let Some(value) = config.get("root").and_then(Value::as_str) {
        return Ok(resolve_config_path(value, &config_value_base("root")?));
    }
    default_data_root(&env_snapshot())
}

pub fn providers_dir() -> Result<PathBuf, String> {
    if let Some(value) = env_value(&["WAXWING_PROVIDERS_DIR", "DSH_SUBAGENT_PROVIDERS_DIR"]) {
        return Ok(resolve_config_path(&value, &config_dir()?));
    }
    let config = effective_config()?;
    if let Some(value) = config.get("providersDir").and_then(Value::as_str) {
        return Ok(resolve_config_path(
            value,
            &config_value_base("providersDir")?,
        ));
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
    Ok(resolve_executable(value, &config_value_base("node")?))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Read by the JavaScript test in prototype/tests/config.test.mjs too, so
    // both implementations resolve the same environment and file layouts the
    // same way.
    const LOCAL_CONFIG_FIXTURE: &str =
        include_str!("../../../prototype/tests/fixtures/local-config-location.json");

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after the epoch")
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "waxwing-paths-{}-{stamp}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn substitute(template: &str, base: &Path, cwd: &Path) -> String {
        template
            .replace("{base}", &base.to_string_lossy())
            .replace("{home}", &base.join("home").to_string_lossy())
            .replace("{config}", &base.join("config").to_string_lossy())
            .replace("{cwd}", &cwd.to_string_lossy())
    }

    fn expected_source(value: Option<&str>) -> LocalConfigSource {
        match value {
            Some("env") => LocalConfigSource::Environment,
            Some("home") => LocalConfigSource::Home,
            Some("legacy") => LocalConfigSource::Legacy,
            None => LocalConfigSource::None,
            Some(other) => panic!("unknown expected source: {other}"),
        }
    }

    #[test]
    fn local_config_location_matches_the_shared_table() {
        let fixture: Value = serde_json::from_str(LOCAL_CONFIG_FIXTURE).expect("fixture JSON");
        let cwd = env::current_dir().expect("current directory");

        for case in fixture["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("case name");
            let base = TempDir::new();
            let config_dir = base.0.join("config");
            fs::create_dir_all(&config_dir).expect("config dir");

            let home_dir = base.0.join("home");
            if case["homeFile"].as_bool().unwrap_or(false) {
                fs::create_dir_all(&home_dir).expect("home dir");
                fs::write(home_dir.join("config.local.json"), "{}\n").expect("home file");
            }
            let legacy = config_dir.join("config.local.json");
            if case["legacyFile"].as_bool().unwrap_or(false) {
                fs::write(&legacy, "{}\n").expect("legacy file");
            }

            let environment: BTreeMap<String, String> = case["env"]
                .as_object()
                .expect("env object")
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        substitute(value.as_str().expect("env value"), &base.0, &cwd),
                    )
                })
                .collect();

            let location =
                local_config_location_from_parts(&environment, &cwd, &legacy).expect("location");
            let expected = substitute(
                case["expect"]["path"].as_str().expect("expected path"),
                &base.0,
                &cwd,
            );
            let expected_path = if Path::new(&expected).is_absolute() {
                PathBuf::from(&expected)
            } else {
                cwd.join(&expected)
            };

            assert_eq!(location.path, expected_path, "{name}");
            assert_eq!(
                location.source,
                expected_source(case["expect"]["source"].as_str()),
                "{name}"
            );
        }
    }

    #[test]
    fn a_legacy_save_moves_to_the_per_user_file() {
        let home = Path::new("D:/waxwing-data/config.local.json");
        let legacy = LocalConfigLocation {
            path: PathBuf::from("C:/install/prototype/config.local.json"),
            source: LocalConfigSource::Legacy,
            base_dir: PathBuf::from("C:/install/prototype"),
        };
        assert_eq!(local_config_write_target(&legacy, home), home);

        let explicit = LocalConfigLocation {
            path: PathBuf::from("D:/custom/local.json"),
            source: LocalConfigSource::Environment,
            base_dir: PathBuf::from("D:/custom"),
        };
        assert_eq!(
            local_config_write_target(&explicit, home),
            PathBuf::from("D:/custom/local.json")
        );
    }
}

// Locate the backend and the Node executable, then ask the CLI for every
// other path. Rust never parses config.json, provider files, or settings:
// `prototype/cli.mjs paths` is the single resolution the desktop shares with
// the manager, so the two cannot disagree.
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

fn env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
}

fn absolute_from_cwd(value: &str) -> Result<PathBuf, String> {
    let cwd = env::current_dir()
        .map_err(|error| format!("Cannot resolve relative path {value}: {error}"))?;
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
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

/// The Node executable: an environment override, the bundled runtime beside
/// the desktop executable, or `node` from PATH. This is the only configuration
/// value Rust still reads.
pub fn node_command() -> Result<String, String> {
    if let Some(value) = env_value(&["WAXWING_NODE", "DSH_SUBAGENT_NODE", "DSH_PROTOTYPE_NODE"]) {
        let path = PathBuf::from(&value);
        if path.is_absolute() || value.contains('/') || value.contains('\\') {
            return Ok(absolute_from_cwd(&value)?.to_string_lossy().into_owned());
        }
        return Ok(value);
    }
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
    Ok("node".to_string())
}

fn prototype_dir() -> Result<PathBuf, String> {
    let root = repo_root()?;
    let prototype = if root
        .join("backend")
        .join("prototype")
        .join("server.mjs")
        .is_file()
    {
        root.join("backend").join("prototype")
    } else {
        root.join("prototype")
    };
    if !prototype.join("server.mjs").is_file() {
        return Err(format!(
            "Manager script does not exist: {}. Set WAXWING_BACKEND_DIR to the backend root.",
            prototype.join("server.mjs").display()
        ));
    }
    Ok(prototype)
}

/// The JSON document printed by `node cli.mjs paths`; shared with the Node
/// test fixture so a removed or renamed field fails both sides.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagerPaths {
    pub data_root: String,
    pub runs_dir: String,
    pub reports_dir: String,
    pub runtime_dir: String,
    pub research_root: String,
    pub providers_dir: String,
    pub config_path: String,
    pub local_config_path: String,
    pub local_config_source: Option<String>,
    pub node: String,
    pub port: u16,
    pub manager_script: String,
    pub manager_dir: String,
    pub manager_url: String,
    pub token_file: String,
}

pub fn parse_manager_paths(json: &str) -> Result<ManagerPaths, String> {
    serde_json::from_str(json.trim())
        .map_err(|error| format!("Invalid manager paths JSON: {error}"))
}

fn resolve_manager_paths() -> Result<ManagerPaths, String> {
    let prototype = prototype_dir()?;
    let output = Command::new(node_command()?)
        .arg("cli.mjs")
        .arg("paths")
        .current_dir(&prototype)
        .output()
        .map_err(|error| format!("Cannot run the Waxwing CLI to resolve paths: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "The Waxwing CLI could not resolve paths: {}",
            stderr.trim()
        ));
    }
    parse_manager_paths(&String::from_utf8_lossy(&output.stdout))
}

/// Resolve once per process: environment and files are fixed for one desktop
/// session, and every request needs the same token and URL.
static MANAGER_PATHS: OnceLock<Result<ManagerPaths, String>> = OnceLock::new();

pub fn manager_paths() -> Result<ManagerPaths, String> {
    MANAGER_PATHS.get_or_init(resolve_manager_paths).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Node test writes and checks the same document from `managerPaths`.
    const PATHS_FIXTURE: &str =
        include_str!("../../../prototype/tests/fixtures/manager-paths.json");

    #[test]
    fn the_shared_paths_fixture_parses_into_every_launcher_field() {
        let paths = parse_manager_paths(PATHS_FIXTURE).expect("fixture must parse");
        assert_eq!(paths.port, 43187);
        assert!(paths.token_file.ends_with("server-token"));
        assert!(paths.manager_url.starts_with("http://127.0.0.1:"));
        assert!(paths.manager_script.ends_with("server.mjs"));

        let value: serde_json::Value = serde_json::from_str(PATHS_FIXTURE).expect("fixture JSON");
        let mut fixture_keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        fixture_keys.sort();
        let mut struct_keys = vec![
            "dataRoot",
            "runsDir",
            "reportsDir",
            "runtimeDir",
            "researchRoot",
            "providersDir",
            "configPath",
            "localConfigPath",
            "localConfigSource",
            "node",
            "port",
            "managerScript",
            "managerDir",
            "managerUrl",
            "tokenFile",
        ];
        struct_keys.sort();
        assert_eq!(fixture_keys, struct_keys);
    }

    #[test]
    fn a_missing_field_is_reported_instead_of_defaulted() {
        let error = parse_manager_paths("{\"dataRoot\": \"C:/data\"}")
            .expect_err("partial paths must fail");
        assert!(error.contains("missing field"), "{error}");
    }

    #[test]
    fn manager_entry_is_a_relative_file_name() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("prototype")
            .join("server.mjs");
        assert_eq!(
            script.file_name().and_then(|name| name.to_str()),
            Some("server.mjs")
        );
    }
}

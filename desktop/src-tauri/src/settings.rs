use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const PATH_KEYS: [&str; 5] = [
    "root",
    "researchRoot",
    "dshRepo",
    "credentialsFile",
    "providersDir",
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_provider: String,
    pub fallback_provider: String,
    pub usage_limits: UsageLimits,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub enabled: bool,
    pub warn_cost_cny: f64,
    pub block_cost_cny: f64,
    pub warn_requests: u32,
    pub block_requests: u32,
}

fn default_settings() -> Settings {
    Settings {
        default_provider: "dsh-sdk".to_string(),
        fallback_provider: "dsh-sdk".to_string(),
        usage_limits: UsageLimits {
            enabled: false,
            warn_cost_cny: 3.0,
            block_cost_cny: 5.0,
            warn_requests: 100,
            block_requests: 160,
        },
    }
}

/// A legacy local file may store relative paths. Writing it to the per-user
/// directory would resolve them against a different base, so convert each one
/// to an absolute path against the directory the old file lived in. This
/// mirrors `prototype/config.mjs`: `node` stays a bare command unless it
/// contains a path separator.
fn absolutize_paths(config: &mut Map<String, Value>, base_dir: &Path) {
    for key in PATH_KEYS {
        let value = match config.get(key) {
            Some(Value::String(value)) if !value.trim().is_empty() => value.trim().to_string(),
            _ => continue,
        };
        let path = PathBuf::from(&value);
        let resolved = if path.is_absolute() {
            path
        } else {
            base_dir.join(path)
        };
        config.insert(
            key.to_string(),
            Value::String(resolved.to_string_lossy().into_owned()),
        );
    }

    if let Some(Value::String(value)) = config.get("node") {
        let value = value.trim();
        let path = PathBuf::from(value);
        if !value.is_empty() && !path.is_absolute() && (value.contains('/') || value.contains('\\'))
        {
            config.insert(
                "node".to_string(),
                Value::String(base_dir.join(path).to_string_lossy().into_owned()),
            );
        }
    }
}

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    let config = Value::Object(paths::effective_config()?);
    let defaults = default_settings();

    let settings = Settings {
        default_provider: config["defaultProvider"]
            .as_str()
            .unwrap_or(&defaults.default_provider)
            .to_string(),
        fallback_provider: config["fallbackProvider"]
            .as_str()
            .unwrap_or(&defaults.fallback_provider)
            .to_string(),
        usage_limits: UsageLimits {
            enabled: config["usageLimits"]["enabled"]
                .as_bool()
                .unwrap_or(defaults.usage_limits.enabled),
            warn_cost_cny: config["usageLimits"]["warnCostCny"]
                .as_f64()
                .unwrap_or(defaults.usage_limits.warn_cost_cny),
            block_cost_cny: config["usageLimits"]["blockCostCny"]
                .as_f64()
                .unwrap_or(defaults.usage_limits.block_cost_cny),
            warn_requests: config["usageLimits"]["warnRequests"]
                .as_u64()
                .unwrap_or(defaults.usage_limits.warn_requests as u64)
                as u32,
            block_requests: config["usageLimits"]["blockRequests"]
                .as_u64()
                .unwrap_or(defaults.usage_limits.block_requests as u64)
                as u32,
        },
    };

    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(settings: Settings) -> Result<(), String> {
    let location = paths::local_config_location()?;
    let write_path = paths::local_config_write_path(&location)?;
    let mut config = paths::read_json_object(&location.path)?;
    // Relative paths in a legacy file are reinterpreted before the move, so
    // they keep pointing at the same directories afterwards.
    absolutize_paths(&mut config, &location.base_dir);
    let mut usage_limits = config
        .get("usageLimits")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    config.insert(
        "defaultProvider".to_string(),
        Value::String(settings.default_provider),
    );
    config.insert(
        "fallbackProvider".to_string(),
        Value::String(settings.fallback_provider),
    );
    usage_limits.insert(
        "enabled".to_string(),
        Value::Bool(settings.usage_limits.enabled),
    );
    usage_limits.insert(
        "warnCostCny".to_string(),
        Value::from(settings.usage_limits.warn_cost_cny),
    );
    usage_limits.insert(
        "blockCostCny".to_string(),
        Value::from(settings.usage_limits.block_cost_cny),
    );
    usage_limits.insert(
        "warnRequests".to_string(),
        Value::from(settings.usage_limits.warn_requests),
    );
    usage_limits.insert(
        "blockRequests".to_string(),
        Value::from(settings.usage_limits.block_requests),
    );
    config.insert("usageLimits".to_string(), Value::Object(usage_limits));

    paths::write_json_object(&write_path, &config)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_makes_relative_paths_absolute_without_moving_targets() {
        let base = Path::new("C:/waxwing/prototype");
        let absolute = std::env::current_dir().unwrap().join("absolute.yaml");
        let mut config = serde_json::json!({
            "root": "../data",
            "providersDir": "./providers",
            "credentialsFile": absolute.to_string_lossy(),
            "node": "./bin/node.exe",
            "defaultProvider": "dsh-sdk"
        })
        .as_object()
        .cloned()
        .unwrap();

        absolutize_paths(&mut config, base);

        let expected = |value: &str| Value::String(base.join(value).to_string_lossy().into_owned());
        assert_eq!(config["root"], expected("../data"));
        assert_eq!(config["providersDir"], expected("./providers"));
        assert_eq!(
            config["credentialsFile"],
            Value::String(absolute.to_string_lossy().into_owned())
        );
        assert_eq!(config["node"], expected("./bin/node.exe"));
        assert_eq!(config["defaultProvider"], "dsh-sdk");
    }

    #[test]
    fn a_bare_node_command_is_not_anchored() {
        let mut config = serde_json::json!({"node": "node"})
            .as_object()
            .cloned()
            .unwrap();
        absolutize_paths(&mut config, Path::new("C:/waxwing/prototype"));
        assert_eq!(config["node"], "node");
    }
}

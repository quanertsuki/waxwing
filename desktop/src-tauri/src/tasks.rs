use crate::paths;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::path::Path;
use std::process::Stdio;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub requests: usize,
    pub estimated_cost_cny: Option<f64>,
    pub cost_complete: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub status: String,
    pub round_count: usize,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub workspace: String,
    pub source_workspace: Option<String>,
    pub workspace_mode: Option<String>,
    pub branch: Option<String>,
    pub base_commit: Option<String>,
    pub runtime_health: Option<String>,
    pub summary: String,
    pub live: bool,
    pub accepted: bool,
    pub max_tokens: Option<u64>,
    pub usage: Option<TaskUsage>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

fn read_server_token() -> Result<String, String> {
    let token_path = paths::server_token()?;
    std::fs::read_to_string(&token_path)
        .map(|t| t.trim().to_string())
        .map_err(|e| {
            format!(
                "Cannot read server token at {}: {}",
                token_path.display(),
                e
            )
        })
}

fn manager_entry_argument(manager_script: &Path) -> Result<&OsStr, String> {
    manager_script
        .file_name()
        .ok_or_else(|| "Manager script has no file name".to_string())
}

async fn manager_request(
    action: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let token = read_server_token()?;
    let client = reqwest::Client::new();
    let response = client
        .post(paths::manager_url()?)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"action": action, "args": args}))
        .send()
        .await
        .map_err(|e| format!("Manager request failed: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Manager error: {}", body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

#[tauri::command]
pub async fn get_tasks() -> Result<Vec<Task>, String> {
    let result = manager_request("list", serde_json::json!({})).await?;
    let tasks: Vec<Task> =
        serde_json::from_value(result).map_err(|e| format!("Failed to parse task list: {}", e))?;
    Ok(tasks)
}

#[tauri::command]
pub async fn get_task_detail(id: String) -> Result<serde_json::Value, String> {
    manager_request("status", serde_json::json!({"id": id})).await
}

#[tauri::command]
pub async fn get_task_usage(id: String) -> Result<serde_json::Value, String> {
    manager_request("status", serde_json::json!({"id": id, "view": "usage"})).await
}

#[tauri::command]
pub async fn get_task_view(
    id: String,
    view: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    manager_request(
        "status",
        serde_json::json!({
            "id": id,
            "view": view,
            "offset": offset.unwrap_or(0),
            "limit": limit.unwrap_or(2000)
        }),
    )
    .await
}

#[tauri::command]
pub async fn create_task(args: serde_json::Value) -> Result<serde_json::Value, String> {
    manager_request("create", args).await
}

#[tauri::command]
pub async fn rework_task(args: serde_json::Value) -> Result<serde_json::Value, String> {
    manager_request("rework", args).await
}

#[tauri::command]
pub async fn cleanup_worktree(id: String) -> Result<serde_json::Value, String> {
    manager_request("cleanup_worktree", serde_json::json!({"id": id})).await
}

#[tauri::command]
pub async fn cancel_task(id: String) -> Result<serde_json::Value, String> {
    manager_request("cancel", serde_json::json!({"id": id})).await
}

#[tauri::command]
pub async fn close_task(id: String) -> Result<serde_json::Value, String> {
    manager_request("close", serde_json::json!({"id": id})).await
}

#[tauri::command]
pub async fn accept_task(id: String, evidence: String) -> Result<serde_json::Value, String> {
    manager_request(
        "accept",
        serde_json::json!({"id": id, "evidence": evidence}),
    )
    .await
}

#[tauri::command]
pub async fn is_manager_running() -> Result<bool, String> {
    // Use a short-timeout TCP connect check; if the port is taken the manager is up.
    // Reading the token also fails when no manager has written it yet.
    let token = match read_server_token() {
        Ok(t) if !t.is_empty() => t,
        _ => return Ok(false),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(paths::manager_url()?)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"action": "health", "args": {}}))
        .send()
        .await;
    Ok(response.map(|r| r.status().is_success()).unwrap_or(false))
}

#[tauri::command]
pub async fn start_manager() -> Result<bool, String> {
    if is_manager_running().await.unwrap_or(false) {
        return Ok(true);
    }

    let port = paths::port()?;
    let address = format!("127.0.0.1:{port}");
    let port_busy = std::net::TcpStream::connect_timeout(
        &address
            .parse()
            .map_err(|_| format!("Invalid manager address: {address}"))?,
        std::time::Duration::from_millis(500),
    )
    .is_ok();

    if port_busy {
        return Err(format!(
            "Port {port} is already in use, but it is not a healthy Waxwing manager. Stop that process or set WAXWING_PORT to another port."
        ));
    }

    let manager_script = paths::manager_script()?;
    let manager_dir = manager_script
        .parent()
        .ok_or_else(|| "Manager script has no containing directory".to_string())?;
    let manager_entry = manager_entry_argument(&manager_script)?;
    let runtime_dir = paths::data_root()?.join("runtime");
    std::fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Cannot create runtime directory: {e}"))?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime_dir.join("manager.log"))
        .map_err(|e| format!("Cannot open manager log: {e}"))?;
    let error_log = log
        .try_clone()
        .map_err(|e| format!("Cannot duplicate manager log handle: {e}"))?;

    let spawned_manager = std::process::Command::new(paths::node_command()?)
        // Node on Windows can misread Rust's canonical `\\?\` path as a drive
        // root. Run the entry point relative to the script directory instead.
        .arg(manager_entry)
        .current_dir(manager_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn();

    match spawned_manager {
        Ok(_) => {
            for _ in 0..20 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                if is_manager_running().await.unwrap_or(false) {
                    return Ok(true);
                }
            }
            Err(format!(
                "Manager did not become healthy at {}. Inspect {}.",
                paths::manager_url()?,
                runtime_dir.join("manager.log").display()
            ))
        }
        Err(e) => Err(format!("Failed to start manager: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_entry_is_a_relative_file_name() {
        let script = std::fs::canonicalize(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("prototype")
                .join("server.mjs"),
        )
        .expect("manager script should exist in the checkout");

        assert_eq!(
            manager_entry_argument(&script),
            Ok(OsStr::new("server.mjs"))
        );
    }
}

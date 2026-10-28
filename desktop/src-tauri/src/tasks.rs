use crate::paths;
use crate::transport::{clamp_page_limit, error_message, health_from_result, ManagerHealth};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::path::Path;
use std::process::Stdio;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub requests: usize,
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub estimated_cost_cny: Option<f64>,
    #[serde(default)]
    pub cost_complete: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub status_label: Option<String>,
    pub round_count: usize,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub workspace: String,
    #[serde(default)]
    pub source_workspace: Option<String>,
    #[serde(default)]
    pub workspace_mode: Option<String>,
    #[serde(default)]
    pub workspace_label: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base_commit: Option<String>,
    #[serde(default)]
    pub runtime_health: Option<String>,
    #[serde(default)]
    pub cleanup_authorized: Option<bool>,
    pub summary: String,
    #[serde(default)]
    pub summary_truncated: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_truncated: bool,
    pub live: bool,
    pub accepted: bool,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub last_round: Option<u32>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub usage: Option<TaskUsage>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub shard_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRound {
    pub number: u32,
    #[serde(default)]
    pub round_id: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRuntime {
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub manual_action_required: Option<bool>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetailUsage {
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub requests: Option<usize>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub estimated_cost_cny: Option<f64>,
    #[serde(default)]
    pub cost_complete: Option<bool>,
    #[serde(default)]
    pub limit_state: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub status_label: Option<String>,
    #[serde(default)]
    pub round_count: usize,
    #[serde(default)]
    pub round_id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub workspace: String,
    #[serde(default)]
    pub source_workspace: Option<String>,
    #[serde(default)]
    pub workspace_mode: Option<String>,
    #[serde(default)]
    pub workspace_label: Option<String>,
    #[serde(default)]
    pub worktree_status: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base_commit: Option<String>,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub accepted: bool,
    #[serde(default)]
    pub can_rework: Option<bool>,
    #[serde(default)]
    pub manual_action_required: Option<bool>,
    #[serde(default)]
    pub runtime_health: Option<String>,
    #[serde(default)]
    pub runtime_phase: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<TaskRuntime>,
    #[serde(default)]
    pub rework_blocked_reason: Option<String>,
    #[serde(default)]
    pub last_round: Option<TaskRound>,
    #[serde(default)]
    pub last_event: Option<serde_json::Value>,
    #[serde(default)]
    pub usage: Option<TaskDetailUsage>,
    #[serde(default)]
    pub usage_rounds: Vec<serde_json::Value>,
    #[serde(default)]
    pub result_preview: Option<String>,
    #[serde(default)]
    pub result_preview_chars: Option<usize>,
    #[serde(default)]
    pub result_total_chars: Option<usize>,
    #[serde(default)]
    pub result_preview_complete: Option<bool>,
    #[serde(default)]
    pub result_preview_truncated: Option<bool>,
    #[serde(default)]
    pub result_finish_reason: Option<String>,
    #[serde(default)]
    pub event_count: Option<u64>,
    #[serde(default)]
    pub runtime_ready: Option<bool>,
    #[serde(default)]
    pub accepted_at: Option<String>,
    #[serde(default)]
    pub data_directory: Option<String>,
    #[serde(default)]
    pub report: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub cleanup_authorized: Option<bool>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
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
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(error_message(status, &body));
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
pub async fn get_task_detail(id: String) -> Result<TaskDetail, String> {
    let result = manager_request("status", serde_json::json!({"id": id})).await?;
    serde_json::from_value(result).map_err(|e| format!("Failed to parse task detail: {}", e))
}

#[tauri::command]
pub async fn get_task_view(
    id: String,
    view: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    manager_request(
        "status",
        serde_json::json!({
            "id": id,
            "view": view,
            "offset": offset.unwrap_or(0).max(0),
            "limit": clamp_page_limit(limit)
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
pub async fn is_manager_running() -> Result<ManagerHealth, String> {
    // Reading the token fails when no manager has written it yet.
    let token = match read_server_token() {
        Ok(t) if !t.is_empty() => t,
        _ => return Ok(ManagerHealth::NotRunning),
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
    let probe = match response {
        Ok(response) => {
            let status = response.status().as_u16();
            Ok((status, response.text().await.unwrap_or_default()))
        }
        Err(_) => Err(()),
    };
    Ok(health_from_result(probe))
}

#[tauri::command]
pub async fn start_manager() -> Result<bool, String> {
    if is_manager_running().await == Ok(ManagerHealth::Running) {
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
                if is_manager_running().await == Ok(ManagerHealth::Running) {
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

    // The checked-in fixture is generated by scripts/generate-task-contract.mjs
    // from the real JavaScript view functions. Parsing it here fails whenever
    // the JS contract grows a field the Rust models cannot read.
    const CONTRACT_FIXTURE: &str =
        include_str!("../../../prototype/tests/fixtures/task-view-contract.json");

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

    #[test]
    fn task_contract_accepts_the_shared_view_labels_and_compatibility_fields() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-0123456789ab",
            "status": "awaiting_review",
            "statusLabel": "待验收",
            "roundCount": 2,
            "workspace": "C:/work/task",
            "workspaceMode": "worktree",
            "workspaceLabel": "独立 Worktree",
            "runtimeHealth": "healthy",
            "cleanupAuthorized": true,
            "summary": "bounded",
            "live": true,
            "accepted": false
        }))
        .expect("shared task view must deserialize");

        assert_eq!(task.status_label.as_deref(), Some("待验收"));
        assert_eq!(task.workspace_label.as_deref(), Some("独立 Worktree"));
        assert_eq!(task.cleanup_authorized, Some(true));
        assert_eq!(task.round_count, 2);
    }

    #[test]
    fn task_detail_accepts_the_bounded_shared_contract() {
        let detail: TaskDetail = serde_json::from_value(serde_json::json!({
            "id": "task-0123456789ab",
            "status": "awaiting_review",
            "statusLabel": "待验收",
            "roundCount": 1,
            "roundId": "round-1",
            "workspace": "C:/work/task",
            "workspaceMode": "worktree",
            "workspaceLabel": "独立 Worktree",
            "worktreeStatus": "active",
            "live": true,
            "accepted": false,
            "canRework": true,
            "manualActionRequired": true,
            "runtimeHealth": "unhealthy",
            "runtime": {"pid": 4242, "manualActionRequired": true},
            "lastRound": {
                "number": 1,
                "roundId": "round-1",
                "maxTokens": 4096
            },
            "usage": {
                "available": true,
                "requests": 2,
                "inputTokens": 10,
                "outputTokens": 20,
                "estimatedCostCny": 0.25,
                "costComplete": true
            },
            "usageRounds": [{"number": 1, "requests": 2}]
        }))
        .expect("bounded task detail must deserialize");

        assert_eq!(detail.status_label.as_deref(), Some("待验收"));
        assert_eq!(detail.workspace_label.as_deref(), Some("独立 Worktree"));
        assert_eq!(
            detail.runtime.as_ref().and_then(|runtime| runtime.pid),
            Some(4242)
        );
        assert_eq!(
            detail.last_round.as_ref().map(|round| round.number),
            Some(1)
        );
        assert_eq!(
            detail.usage.as_ref().and_then(|usage| usage.requests),
            Some(2)
        );
        assert_eq!(detail.usage_rounds.len(), 1);
    }

    #[test]
    fn rust_models_parse_the_committed_task_view_contract() {
        let fixture: serde_json::Value =
            serde_json::from_str(CONTRACT_FIXTURE).expect("contract fixture must be valid JSON");
        let list: Task = serde_json::from_value(fixture["list"].clone())
            .expect("list fixture must deserialize into Task");
        let detail: TaskDetail = serde_json::from_value(fixture["detail"].clone())
            .expect("detail fixture must deserialize into TaskDetail");

        assert_eq!(list.id, "task-0123456789ab");
        assert_eq!(list.summary, "bounded preview");
        assert!(!list.summary_truncated);
        assert_eq!(list.last_round, Some(1));
        assert_eq!(list.effort.as_deref(), Some("high"));
        assert_eq!(list.usage.as_ref().map(|usage| usage.requests), Some(2));

        assert_eq!(detail.status_label.as_deref(), Some("待验收"));
        assert_eq!(detail.runtime_phase.as_deref(), Some("running"));
        assert_eq!(detail.session_id.as_deref(), Some("session-1"));
        assert_eq!(detail.event_count, Some(7));
        assert_eq!(detail.result_preview_chars, Some(14));
        assert_eq!(detail.result_total_chars, Some(100));
        assert_eq!(detail.result_preview_complete, Some(false));
        assert_eq!(detail.result_preview_truncated, Some(true));
        assert_eq!(
            detail
                .last_round
                .as_ref()
                .and_then(|round| round.started_at.as_deref()),
            Some("2026-10-28T01:00:00.000Z")
        );
    }

    #[test]
    fn task_detail_accepts_an_old_minimal_response() {
        let detail: TaskDetail = serde_json::from_value(serde_json::json!({
            "id": "task-0123456789ab",
            "status": "closed",
            "workspace": "C:/work/task"
        }))
        .expect("old minimal status response must remain readable");

        assert_eq!(detail.id, "task-0123456789ab");
        assert_eq!(detail.round_count, 0);
        assert_eq!(detail.live, false);
        assert!(detail.runtime.is_none());
        assert!(detail.usage.is_none());
        assert!(detail.usage_rounds.is_empty());
    }
}

//! Transport policy shared by every desktop manager request.
//!
//! These functions are pure so the HTTP mapping, page bounds, and health
//! classification can be tested without a running manager.

use serde::{Deserialize, Serialize};

pub const DEFAULT_PAGE_LIMIT: u32 = 2000;
pub const MAX_PAGE_LIMIT: u32 = 4000;
const ERROR_DETAIL_MAX_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagerHealth {
    Running,
    Unhealthy,
    NotRunning,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: Option<String>,
}

/// Clamp a requested page limit to the range the manager accepts. Missing or
/// invalid values fall back to the same default as MCP/CLI.
pub fn clamp_page_limit(limit: Option<i64>) -> u32 {
    match limit {
        Some(value) if value < 1 => 1,
        Some(value) => value.min(MAX_PAGE_LIMIT as i64) as u32,
        None => DEFAULT_PAGE_LIMIT,
    }
}

fn clip_detail(value: &str) -> String {
    let text = value.trim();
    let count = text.chars().count();
    if count <= ERROR_DETAIL_MAX_CHARS {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(ERROR_DETAIL_MAX_CHARS - 1).collect();
    clipped.push('…');
    clipped
}

/// Stable user-facing error for a non-2xx manager response. A JSON `{error}`
/// body keeps its server reason; plain text and empty bodies stay readable.
pub fn error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<ErrorBody>(body)
        .ok()
        .and_then(|parsed| parsed.error)
        .map(|error| clip_detail(&error))
        .filter(|error| !error.is_empty());
    match detail {
        Some(error) => format!("Manager error (HTTP {status}): {error}"),
        None if body.trim().is_empty() => {
            format!("Manager error (HTTP {status}): empty response")
        }
        None => format!("Manager error (HTTP {status}): {}", clip_detail(body)),
    }
}

/// Classify one health probe. A request that reached the manager is either
/// healthy or unhealthy; only a send failure means the manager is not running.
pub fn health_from_result(result: Result<(u16, String), ()>) -> ManagerHealth {
    match result {
        Err(()) => ManagerHealth::NotRunning,
        Ok((status, body)) if (200..300).contains(&status) => {
            if serde_json::from_str::<serde_json::Value>(&body).is_ok() {
                ManagerHealth::Running
            } else {
                ManagerHealth::Unhealthy
            }
        }
        Ok(_) => ManagerHealth::Unhealthy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_body_keeps_the_server_reason() {
        assert_eq!(
            error_message(400, r#"{"error":"task is still running"}"#),
            "Manager error (HTTP 400): task is still running"
        );
    }

    #[test]
    fn plain_text_and_empty_bodies_stay_readable() {
        assert_eq!(
            error_message(502, "bad gateway\n"),
            "Manager error (HTTP 502): bad gateway"
        );
        assert_eq!(
            error_message(503, "   "),
            "Manager error (HTTP 503): empty response"
        );
        assert_eq!(
            error_message(500, r#"{"error":""}"#),
            r#"Manager error (HTTP 500): {"error":""}"#
        );
    }

    #[test]
    fn long_error_details_are_clipped() {
        let body = format!(r#"{{"error":"{}"}}"#, "x".repeat(2000));
        let message = error_message(500, &body);
        assert!(message.ends_with('…'));
        assert!(message.chars().count() < 600);
    }

    #[test]
    fn page_limits_are_clamped_to_one_through_four_thousand() {
        assert_eq!(clamp_page_limit(Some(-1)), 1);
        assert_eq!(clamp_page_limit(Some(0)), 1);
        assert_eq!(clamp_page_limit(Some(2000)), 2000);
        assert_eq!(clamp_page_limit(Some(4000)), 4000);
        assert_eq!(clamp_page_limit(Some(999999)), 4000);
        assert_eq!(clamp_page_limit(None), DEFAULT_PAGE_LIMIT);
    }

    #[test]
    fn health_is_a_tri_state() {
        assert_eq!(
            health_from_result(Ok((200, r#"{"waxwing":true}"#.to_string()))),
            ManagerHealth::Running
        );
        assert_eq!(
            health_from_result(Ok((401, r#"{"error":"unauthorized"}"#.to_string()))),
            ManagerHealth::Unhealthy
        );
        assert_eq!(
            health_from_result(Ok((500, "boom".to_string()))),
            ManagerHealth::Unhealthy
        );
        assert_eq!(
            health_from_result(Ok((200, "not json".to_string()))),
            ManagerHealth::Unhealthy
        );
        assert_eq!(health_from_result(Err(())), ManagerHealth::NotRunning);
    }

    #[test]
    fn health_serializes_with_camel_case_names() {
        assert_eq!(
            serde_json::to_string(&ManagerHealth::NotRunning).unwrap(),
            r#""notRunning""#
        );
        assert_eq!(
            serde_json::to_string(&ManagerHealth::Unhealthy).unwrap(),
            r#""unhealthy""#
        );
    }
}

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::identity::{self, Identity};
use crate::agent_db::{Endpoint, AgentDb, AgentRecord};

const DEFAULT_IPC_PORT: u16 = 8199;
const PORT_FILE: &str = "daemon.port";
const PID_FILE: &str = "daemon.pid";

#[derive(Clone)]
pub struct DaemonState {
    pub identity: Identity,
    pub agent_db: Arc<Mutex<AgentDb>>,
    pub data_dir: PathBuf,
    pub gateway_url: String,
    pub listen_port: u16,
}

#[derive(Serialize, Deserialize)]
pub struct StatusResponse {
    pub agent_id: String,
    pub pub_b64: String,
    pub version: String,
    pub listen_port: u16,
    pub gateway_url: String,
    pub known_agents: usize,
    pub data_dir: String,
}

#[derive(Serialize, Deserialize)]
pub struct AgentsResponse {
    pub agents: Vec<AgentRecord>,
}

#[derive(Serialize, Deserialize)]
pub struct WorldsResponse {
    pub worlds: Vec<WorldSummary>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WorldSummary {
    #[serde(rename = "worldId")]
    pub world_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub name: String,
    pub endpoints: Vec<Endpoint>,
    pub reachable: bool,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
}

#[derive(Serialize, Deserialize)]
pub struct WorldInfoResponse {
    #[serde(rename = "worldId")]
    pub world_id: String,
    pub name: String,
    pub endpoints: Vec<Endpoint>,
    pub reachable: bool,
    pub manifest: Option<WorldManifest>,
}

#[derive(Serialize, Deserialize)]
pub struct WorldManifest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<std::collections::HashMap<String, ActionSchema>>,
}

#[derive(Serialize, Deserialize)]
pub struct ActionSchema {
    pub desc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<std::collections::HashMap<String, ActionParam>>,
}

#[derive(Serialize, Deserialize)]
pub struct ActionParam {
    #[serde(rename = "type")]
    pub param_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
}

#[derive(Deserialize)]
pub struct AgentsQuery {
    pub capability: Option<String>,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub struct DaemonHandle {
    shutdown_tx: oneshot::Sender<()>,
    pub addr: SocketAddr,
}

impl DaemonHandle {
    pub fn shutdown(self) {
        let _ = self.shutdown_tx.send(());
    }
}

pub async fn start_daemon(
    data_dir: PathBuf,
    gateway_url: String,
    listen_port: u16,
    ipc_port: u16,
) -> Result<DaemonHandle, DaemonError> {
    let identity = identity::load_or_create_identity(&data_dir, "identity")
        .map_err(|e| DaemonError::Identity(e.to_string()))?;
    let agent_db = AgentDb::open(&data_dir);

    let state = DaemonState {
        identity,
        agent_db: Arc::new(Mutex::new(agent_db)),
        data_dir,
        gateway_url,
        listen_port,
    };

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (ipc_shutdown_tx, ipc_shutdown_rx) = oneshot::channel::<()>();

    let app = Router::new()
        .route("/ipc/status", get(handle_status))
        .route("/ipc/agents", get(handle_agents))
        .route("/ipc/worlds", get(handle_worlds))
        .route("/ipc/world/{world_id}", get(handle_world_info))
        .route("/ipc/ping", get(handle_ping))
        .route(
            "/ipc/shutdown",
            post({
                let tx = Arc::new(std::sync::Mutex::new(Some(ipc_shutdown_tx)));
                move || {
                    let tx = tx.clone();
                    async move {
                        if let Some(tx) = tx.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        Json(OkResponse {
                            ok: true,
                            message: Some("shutting down".to_string()),
                        })
                    }
                }
            }),
        )
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], ipc_port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| DaemonError::Bind(e.to_string()))?;
    let bound_addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                tokio::select! {
                    _ = shutdown_rx => {}
                    _ = ipc_shutdown_rx => {}
                }
            })
            .await
            .ok();
    });

    Ok(DaemonHandle {
        shutdown_tx,
        addr: bound_addr,
    })
}

async fn handle_status(State(state): State<DaemonState>) -> Json<StatusResponse> {
    let agent_count = state.agent_db.lock().unwrap().size();
    Json(StatusResponse {
        agent_id: state.identity.agent_id.clone(),
        pub_b64: state.identity.pub_b64.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        listen_port: state.listen_port,
        gateway_url: state.gateway_url.clone(),
        known_agents: agent_count,
        data_dir: state.data_dir.to_string_lossy().to_string(),
    })
}

async fn handle_agents(
    State(state): State<DaemonState>,
    axum::extract::Query(query): axum::extract::Query<AgentsQuery>,
) -> Json<AgentsResponse> {
    let db = state.agent_db.lock().unwrap();
    let agents = if let Some(cap) = &query.capability {
        db.find_by_capability(cap).into_iter().cloned().collect()
    } else {
        db.list().into_iter().cloned().collect()
    };
    Json(AgentsResponse { agents })
}

async fn handle_worlds(State(state): State<DaemonState>) -> Json<WorldsResponse> {
    // Fetch from gateway
    let mut worlds = Vec::new();
    let url = format!("{}/worlds", state.gateway_url.trim_end_matches('/'));
    if let Ok(resp) = reqwest::get(&url).await {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            if let Some(arr) = data.get("worlds").and_then(|w| w.as_array()) {
                for w in arr {
                    let world_id = w.get("worldId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let agent_id = w.get("agentId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = w.get("name").and_then(|v| v.as_str()).unwrap_or(&world_id).to_string();
                    let last_seen = w.get("lastSeen").and_then(|v| v.as_u64()).unwrap_or(0);
                    let endpoints: Vec<Endpoint> = w
                        .get("endpoints")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let reachable = !endpoints.is_empty();
                    worlds.push(WorldSummary {
                        world_id,
                        agent_id,
                        name,
                        endpoints,
                        reachable,
                        last_seen,
                    });
                }
            }
        }
    }

    // Merge with local cache
    {
        let db = state.agent_db.lock().unwrap();
        let local_worlds = db.find_by_capability("world:");
        for lw in local_worlds {
            if !worlds.iter().any(|w| w.agent_id == lw.agent_id) {
                let cap = lw.capabilities.iter().find(|c| c.starts_with("world:")).cloned().unwrap_or_default();
                let world_id = cap.strip_prefix("world:").unwrap_or("").to_string();
                worlds.push(WorldSummary {
                    world_id,
                    agent_id: lw.agent_id.clone(),
                    name: if lw.alias.is_empty() { cap.clone() } else { lw.alias.clone() },
                    endpoints: lw.endpoints.clone(),
                    reachable: !lw.endpoints.is_empty(),
                    last_seen: lw.last_seen,
                });
            }
        }
    }

    Json(WorldsResponse { worlds })
}

async fn handle_world_info(
    State(state): State<DaemonState>,
    Path(world_id): Path<String>,
) -> Result<Json<WorldInfoResponse>, StatusCode> {
    // First try to get from gateway
    let url = format!("{}/worlds", state.gateway_url.trim_end_matches('/'));
    let mut world_summary: Option<WorldSummary> = None;

    if let Ok(resp) = reqwest::get(&url).await {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            if let Some(arr) = data.get("worlds").and_then(|w| w.as_array()) {
                for w in arr {
                    let wid = w.get("worldId").and_then(|v| v.as_str()).unwrap_or("");
                    if wid == world_id {
                        let agent_id = w.get("agentId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = w.get("slug").and_then(|v| v.as_str()).unwrap_or(&world_id).to_string();
                        let last_seen = w.get("lastSeen").and_then(|v| v.as_u64()).unwrap_or(0);
                        let endpoints: Vec<Endpoint> = w
                            .get("endpoints")
                            .and_then(|v| serde_json::from_value(v.clone()).ok())
                            .unwrap_or_default();
                        let reachable = !endpoints.is_empty();
                        world_summary = Some(WorldSummary {
                            world_id: wid.to_string(),
                            agent_id,
                            name,
                            endpoints,
                            reachable,
                            last_seen,
                        });
                        break;
                    }
                }
            }
        }
    }

    // Fallback to local cache
    if world_summary.is_none() {
        let db = state.agent_db.lock().unwrap();
        let local_worlds = db.find_by_capability("world:");

        // Try to find by protocol ID (agent_id) or by slug (from capability)
        for lw in local_worlds {
            let cap = lw.capabilities.iter().find(|c| c.starts_with("world:")).cloned().unwrap_or_default();
            let slug = cap.strip_prefix("world:").unwrap_or("");

            // Match by protocol ID or slug
            if lw.agent_id == world_id || slug == world_id {
                world_summary = Some(WorldSummary {
                    world_id: slug.to_string(),
                    agent_id: lw.agent_id.clone(),
                    name: if lw.alias.is_empty() { slug.to_string() } else { lw.alias.clone() },
                    endpoints: lw.endpoints.clone(),
                    reachable: !lw.endpoints.is_empty(),
                    last_seen: lw.last_seen,
                });
                break;
            }
        }
    }

    let world = world_summary.ok_or(StatusCode::NOT_FOUND)?;

    // Try to fetch manifest from world endpoint
    let mut manifest: Option<WorldManifest> = None;
    if !world.endpoints.is_empty() {
        let sorted = {
            let mut eps = world.endpoints.clone();
            eps.sort_by_key(|e| e.priority);
            eps
        };

        for ep in sorted {
            let url = if ep.address.contains(':') && !ep.address.contains('.') {
                format!("http://[{}]:{}/world/manifest", ep.address, ep.port)
            } else {
                format!("http://{}:{}/world/manifest", ep.address, ep.port)
            };

            if let Ok(resp) = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                reqwest::get(&url)
            ).await {
                if let Ok(resp) = resp {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        if let Some(m) = data.get("manifest") {
                            manifest = serde_json::from_value(m.clone()).ok();
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(Json(WorldInfoResponse {
        world_id: world.world_id,
        name: world.name,
        endpoints: world.endpoints,
        reachable: world.reachable,
        manifest,
    }))
}

async fn handle_ping() -> Json<OkResponse> {
    Json(OkResponse {
        ok: true,
        message: Some("daemon alive".to_string()),
    })
}

pub fn ipc_port() -> u16 {
    std::env::var("AWN_IPC_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_IPC_PORT)
}

pub fn default_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".awn")
}

pub fn default_gateway_url() -> String {
    std::env::var("GATEWAY_URL").unwrap_or_else(|_| "https://gateway.agentworlds.ai".to_string())
}

pub fn write_port_file(data_dir: &std::path::Path, port: u16) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(data_dir.join(PORT_FILE), port.to_string());
}

pub fn read_port_file(data_dir: &std::path::Path) -> Option<u16> {
    std::fs::read_to_string(data_dir.join(PORT_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

pub fn remove_port_file(data_dir: &std::path::Path) {
    let _ = std::fs::remove_file(data_dir.join(PORT_FILE));
}

pub fn write_pid_file(data_dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(data_dir.join(PID_FILE), std::process::id().to_string());
}

pub fn read_pid_file(data_dir: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(data_dir.join(PID_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

pub fn remove_pid_file(data_dir: &std::path::Path) {
    let _ = std::fs::remove_file(data_dir.join(PID_FILE));
}

#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error("identity error: {0}")]
    Identity(String),
    #[error("bind error: {0}")]
    Bind(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_daemon_starts_and_responds_to_ping() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            8099,
            0, // OS-assigned port
        )
        .await
        .unwrap();

        let url = format!("http://{}/ipc/ping", handle.addr);
        let resp: OkResponse = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(resp.ok);

        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_status_returns_identity() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            8099,
            0,
        )
        .await
        .unwrap();

        let url = format!("http://{}/ipc/status", handle.addr);
        let resp: StatusResponse = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(resp.agent_id.starts_with("aw:sha256:"));
        assert_eq!(resp.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(resp.listen_port, 8099);

        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_agents_empty() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            8099,
            0,
        )
        .await
        .unwrap();

        let url = format!("http://{}/ipc/agents", handle.addr);
        let resp: AgentsResponse = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(resp.agents.is_empty());

        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_creates_identity_file() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            8099,
            0,
        )
        .await
        .unwrap();

        assert!(tmp.path().join("identity.json").exists());
        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_reuses_identity() {
        let tmp = TempDir::new().unwrap();

        let handle1 = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            8099,
            0,
        )
        .await
        .unwrap();
        let url1 = format!("http://{}/ipc/status", handle1.addr);
        let resp1: StatusResponse = reqwest::get(&url1).await.unwrap().json().await.unwrap();
        handle1.shutdown();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let handle2 = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            8099,
            0,
        )
        .await
        .unwrap();
        let url2 = format!("http://{}/ipc/status", handle2.addr);
        let resp2: StatusResponse = reqwest::get(&url2).await.unwrap().json().await.unwrap();
        handle2.shutdown();

        assert_eq!(resp1.agent_id, resp2.agent_id);
    }
}

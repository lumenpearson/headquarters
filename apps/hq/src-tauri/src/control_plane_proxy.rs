//! Command-side HTTP proxy for control-plane addresses the desktop CSP cannot admit.
//!
//! `tauri.conf.json`'s `connect-src` names loopback and the deployed
//! `https://*.vercel.app` control plane; it cannot name an arbitrary LAN
//! address such as `http://192.168.10.5:4100`, because CSP wildcards only
//! the leftmost label of a hostname and cannot wildcard an IP address at
//! all (`docs/release/known-limitations.md`, "desktop CSP"). A request to
//! that address is refused by the webview before it is ever sent, which
//! reads to the operator as a network failure rather than a policy one.
//!
//! This module is the R18-aligned fix named in that limitation: the
//! webview never talks to a LAN control plane directly. It calls this
//! Tauri command instead -- `ipc:`, which the CSP already admits -- and the
//! command makes the real HTTP request from the native process, entirely
//! outside the webview's CSP. `apps/hq/src/infrastructure/tauri/controlPlaneLanProxy.ts`
//! is the other half: a `fetch`-shaped adapter that routes through this
//! command exactly when the configured control-plane address is one the
//! CSP could not have admitted.
//!
//! The command is scoped narrowly on purpose, not as a general HTTP relay:
//!
//! - Only `GET` and `POST` are accepted -- the health probe and the
//!   ConnectRPC binary POSTs are everything this proxy exists to carry.
//! - Only `http://` URLs are accepted. Adding TLS here would mean adding a
//!   TLS backend to a native shell that has none; a LAN control plane
//!   behind TLS is out of this proxy's scope (see "Known limitations" in
//!   `docs/release/known-limitations.md`).
//! - The host must be a literal IPv4 or IPv6 address in a private-use,
//!   loopback or link-local range. No DNS resolution happens in this
//!   module at all: a hostname is refused outright, so a compromised
//!   renderer cannot use this command to reach an arbitrary public host,
//!   and there is no name to rebind mid-flight.
//! - Both the request and the response body are capped well below what a
//!   legitimate ConnectRPC message on this contract would carry.
//!
//! Long-lived server-streaming RPCs (`WatchGroup`, `TimeSync`) are read
//! start-to-finish before the response crosses back over `ipc:`, so a call
//! that never completes on its own never completes through this proxy
//! either. Only the request/response half is carried; see the Rust
//! `#[cfg(test)] mod tests` module here and
//! `controlPlaneLanProxy.test.ts` for what is and is not proven, and
//! `docs/release/known-limitations.md` for the standing note on the
//! WebSocket realtime channel, which does not go through this command at
//! all.

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request, Uri};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use tauri::State;
use thiserror::Error;
use tokio::time::timeout;
use url::{Host, Url};

/// A ConnectRPC message on this contract is measured against a much smaller
/// ceiling server-side (`maxDocumentBodyBytes`, 4,000,000 bytes, in
/// `apps/control-plane/src/http-policy.ts`). This proxy's own cap only has
/// to be an outer bound against a hostile or malfunctioning peer, so it is
/// set generously above that with room for framing overhead, not tuned to
/// match it exactly.
const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;
const PROXY_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Error)]
pub enum ControlPlaneProxyError {
    #[error("control-plane proxy request method must be GET or POST")]
    UnsupportedMethod,
    #[error("control-plane proxy request url could not be parsed")]
    InvalidUrl,
    #[error("control-plane proxy only carries http:// requests")]
    UnsupportedScheme,
    #[error(
        "control-plane proxy only carries a request to a literal private-use, loopback or \
         link-local address; a hostname or a public address is refused"
    )]
    HostNotAllowed,
    #[error("control-plane proxy request header is malformed")]
    InvalidHeader,
    #[error("control-plane proxy request body exceeds the proxy's size limit")]
    RequestBodyTooLarge,
    #[error("control-plane proxy response body exceeds the proxy's size limit")]
    ResponseBodyTooLarge,
    #[error("control-plane proxy request timed out")]
    Timeout,
    #[error("control-plane proxy could not reach the control plane")]
    ConnectionFailed,
    #[error("control-plane proxy received a response it could not carry back")]
    MalformedResponse,
}

// Serialized as a fixed sentence, the same way `MediaGatewayError` is: this
// error crosses into the UI, and none of the variants above ever repeats
// the address or a header value back to the caller.
impl Serialize for ControlPlaneProxyError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// What the TS adapter sends over `ipc:`. Headers are an ordered list, not a
/// map, because a request may repeat a header name and a map would silently
/// keep only one.
#[derive(Debug, Deserialize)]
pub struct ControlPlaneProxyRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    /// `number[]` on the TS side, matching `native_fs::read_file`'s existing
    /// convention for a byte payload crossing this boundary.
    body: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
pub struct ControlPlaneProxyResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

type ProxyHttpClient = Client<HttpConnector, Full<Bytes>>;

/// Tauri-managed state holding the one pooled HTTP client this command uses.
///
/// A fresh client per call would open a fresh TCP connection per call; one
/// pooled client lets repeated polling (health probes, `GetPresence`, and
/// the rest of the control-plane traffic this proxy carries) reuse a
/// connection the way a browser's own `fetch` would.
pub struct ControlPlaneProxyState {
    client: ProxyHttpClient,
}

impl ControlPlaneProxyState {
    pub fn new() -> Self {
        Self {
            client: Client::builder(TokioExecutor::new()).build_http(),
        }
    }

    async fn execute(
        &self,
        request: ControlPlaneProxyRequest,
    ) -> Result<ControlPlaneProxyResponse, ControlPlaneProxyError> {
        let method = parse_method(&request.method)?;
        let url = Url::parse(&request.url).map_err(|_| ControlPlaneProxyError::InvalidUrl)?;
        if url.scheme() != "http" {
            return Err(ControlPlaneProxyError::UnsupportedScheme);
        }
        if !host_is_allowed(&url) {
            return Err(ControlPlaneProxyError::HostNotAllowed);
        }
        let body_bytes = request.body.unwrap_or_default();
        if body_bytes.len() > MAX_REQUEST_BODY_BYTES {
            return Err(ControlPlaneProxyError::RequestBodyTooLarge);
        }

        let uri: Uri = url
            .as_str()
            .parse()
            .map_err(|_| ControlPlaneProxyError::InvalidUrl)?;
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, value) in &request.headers {
            if is_hop_by_hop_header(name) {
                continue;
            }
            builder = builder.header(name.as_str(), value.as_str());
        }
        let outgoing = builder
            .body(Full::new(Bytes::from(body_bytes)))
            .map_err(|_| ControlPlaneProxyError::InvalidHeader)?;

        let response = timeout(PROXY_REQUEST_TIMEOUT, self.client.request(outgoing))
            .await
            .map_err(|_| ControlPlaneProxyError::Timeout)?
            .map_err(|_| ControlPlaneProxyError::ConnectionFailed)?;

        let status = response.status().as_u16();
        let mut headers = Vec::with_capacity(response.headers().len());
        for (name, value) in response.headers() {
            if is_hop_by_hop_header(name.as_str()) {
                continue;
            }
            let value = value
                .to_str()
                .map_err(|_| ControlPlaneProxyError::MalformedResponse)?;
            headers.push((name.as_str().to_owned(), value.to_owned()));
        }

        let limited = Limited::new(response.into_body(), MAX_RESPONSE_BODY_BYTES);
        let collected = limited
            .collect()
            .await
            .map_err(|_| ControlPlaneProxyError::ResponseBodyTooLarge)?;
        let body = collected.to_bytes().to_vec();

        Ok(ControlPlaneProxyResponse {
            status,
            headers,
            body,
        })
    }
}

impl Default for ControlPlaneProxyState {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_method(value: &str) -> Result<Method, ControlPlaneProxyError> {
    match value.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        _ => Err(ControlPlaneProxyError::UnsupportedMethod),
    }
}

/// No DNS resolution happens anywhere in this module: a hostname (as
/// opposed to a literal address) is refused here, before any connection is
/// attempted, which is what keeps this command from being turned into a
/// general-purpose relay to the public internet by a compromised renderer.
fn host_is_allowed(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(address)) => is_allowed_ipv4(address),
        Some(Host::Ipv6(address)) => is_allowed_ipv6(address),
        _ => false,
    }
}

fn is_allowed_ipv4(address: Ipv4Addr) -> bool {
    address.is_loopback() || address.is_private() || address.is_link_local()
}

fn is_allowed_ipv6(address: Ipv6Addr) -> bool {
    if address.is_loopback() {
        return true;
    }
    let segments = address.segments();
    // fc00::/7 -- unique local addresses (RFC 4193). `Ipv6Addr::is_unique_local`
    // is not yet stable on the Rust version this crate is pinned to, so this
    // checks the same seven bits by hand.
    let is_unique_local = (segments[0] & 0xfe00) == 0xfc00;
    // fe80::/10 -- link-local addresses.
    let is_link_local = (segments[0] & 0xffc0) == 0xfe80;
    is_unique_local || is_link_local
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    )
}

#[tauri::command]
pub async fn control_plane_http_request(
    state: State<'_, ControlPlaneProxyState>,
    request: ControlPlaneProxyRequest,
) -> Result<ControlPlaneProxyResponse, ControlPlaneProxyError> {
    state.execute(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Router,
    };
    use std::net::{Ipv4Addr as StdIpv4Addr, SocketAddr, TcpListener as StdTcpListener};

    /// Starts a tiny fixture server on loopback and returns its base URL.
    ///
    /// Loopback passes this module's own host allowlist (`is_loopback`), so
    /// it exercises the real request path end to end, the same way a LAN
    /// control plane at a private address would, without needing one.
    async fn spawn_fixture() -> String {
        let listener =
            StdTcpListener::bind(SocketAddr::from((StdIpv4Addr::LOCALHOST, 0))).expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("local addr").port();
        let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");

        async fn health() -> impl IntoResponse {
            (
                StatusCode::OK,
                [("x-fixture", "health")],
                "{\"status\":\"SERVING\"}",
            )
        }

        async fn echo(headers: HeaderMap, body: axum::body::Bytes) -> impl IntoResponse {
            let echoed = headers
                .get("x-echo")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_owned();
            (StatusCode::OK, [("x-echo-reply", echoed)], body)
        }

        async fn big() -> impl IntoResponse {
            (StatusCode::OK, vec![0u8; MAX_RESPONSE_BODY_BYTES + 1])
        }

        let router = Router::new()
            .route("/health", get(health))
            .route("/echo", post(echo))
            .route("/big", get(big));

        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("fixture server");
        });

        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn carries_a_get_health_probe() {
        let base = spawn_fixture().await;
        let state = ControlPlaneProxyState::new();

        let response = state
            .execute(ControlPlaneProxyRequest {
                method: "GET".to_owned(),
                url: format!("{base}/health"),
                headers: vec![],
                body: None,
            })
            .await
            .expect("health probe must succeed");

        assert_eq!(response.status, 200);
        assert_eq!(
            String::from_utf8(response.body).unwrap(),
            "{\"status\":\"SERVING\"}"
        );
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("x-fixture") && value == "health"));
    }

    #[tokio::test]
    async fn round_trips_a_post_body_and_a_custom_header() {
        let base = spawn_fixture().await;
        let state = ControlPlaneProxyState::new();

        let response = state
            .execute(ControlPlaneProxyRequest {
                method: "post".to_owned(),
                url: format!("{base}/echo"),
                headers: vec![
                    ("x-echo".to_owned(), "carried-through".to_owned()),
                    (
                        "content-type".to_owned(),
                        "application/connect+proto".to_owned(),
                    ),
                ],
                body: Some(b"connect-rpc-binary-frame".to_vec()),
            })
            .await
            .expect("echo must succeed");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"connect-rpc-binary-frame");
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("x-echo-reply")
                && value == "carried-through"));
    }

    #[tokio::test]
    async fn refuses_a_public_address_before_connecting() {
        let state = ControlPlaneProxyState::new();

        let error = state
            .execute(ControlPlaneProxyRequest {
                method: "GET".to_owned(),
                url: "http://93.184.216.34/".to_owned(),
                headers: vec![],
                body: None,
            })
            .await
            .expect_err("a public address must be refused");

        assert!(matches!(error, ControlPlaneProxyError::HostNotAllowed));
    }

    #[tokio::test]
    async fn refuses_a_hostname_because_no_dns_lookup_ever_runs_here() {
        let state = ControlPlaneProxyState::new();

        let error = state
            .execute(ControlPlaneProxyRequest {
                method: "GET".to_owned(),
                url: "http://control-plane.local/".to_owned(),
                headers: vec![],
                body: None,
            })
            .await
            .expect_err("a hostname must be refused");

        assert!(matches!(error, ControlPlaneProxyError::HostNotAllowed));
    }

    #[tokio::test]
    async fn refuses_https_because_this_proxy_carries_no_tls() {
        let state = ControlPlaneProxyState::new();

        let error = state
            .execute(ControlPlaneProxyRequest {
                method: "GET".to_owned(),
                url: "https://192.168.1.20/".to_owned(),
                headers: vec![],
                body: None,
            })
            .await
            .expect_err("https must be refused");

        assert!(matches!(error, ControlPlaneProxyError::UnsupportedScheme));
    }

    #[tokio::test]
    async fn refuses_a_method_outside_get_and_post() {
        let state = ControlPlaneProxyState::new();

        let error = state
            .execute(ControlPlaneProxyRequest {
                method: "DELETE".to_owned(),
                url: "http://192.168.1.20/".to_owned(),
                headers: vec![],
                body: None,
            })
            .await
            .expect_err("delete must be refused");

        assert!(matches!(error, ControlPlaneProxyError::UnsupportedMethod));
    }

    #[tokio::test]
    async fn refuses_an_oversized_request_body_before_connecting() {
        let state = ControlPlaneProxyState::new();

        let error = state
            .execute(ControlPlaneProxyRequest {
                method: "POST".to_owned(),
                url: "http://192.168.1.20/".to_owned(),
                headers: vec![],
                body: Some(vec![0u8; MAX_REQUEST_BODY_BYTES + 1]),
            })
            .await
            .expect_err("an oversized body must be refused");

        assert!(matches!(error, ControlPlaneProxyError::RequestBodyTooLarge));
    }

    #[tokio::test]
    async fn refuses_an_oversized_response_body() {
        let base = spawn_fixture().await;
        let state = ControlPlaneProxyState::new();

        let error = state
            .execute(ControlPlaneProxyRequest {
                method: "GET".to_owned(),
                url: format!("{base}/big"),
                headers: vec![],
                body: None,
            })
            .await
            .expect_err("an oversized response must be refused");

        assert!(matches!(
            error,
            ControlPlaneProxyError::ResponseBodyTooLarge
        ));
    }

    #[test]
    fn allows_private_use_loopback_and_link_local_ipv4_only() {
        for address in [
            "10.0.0.5",
            "172.16.4.9",
            "192.168.10.5",
            "127.0.0.1",
            "169.254.1.1",
        ] {
            let url = Url::parse(&format!("http://{address}/")).unwrap();
            assert!(host_is_allowed(&url), "{address} must be allowed");
        }
        for address in ["93.184.216.34", "8.8.8.8", "1.1.1.1"] {
            let url = Url::parse(&format!("http://{address}/")).unwrap();
            assert!(!host_is_allowed(&url), "{address} must be refused");
        }
    }

    #[test]
    fn allows_loopback_and_unique_local_ipv6_only() {
        let url = Url::parse("http://[::1]/").unwrap();
        assert!(host_is_allowed(&url));
        let url = Url::parse("http://[fd00::1]/").unwrap();
        assert!(host_is_allowed(&url));
        let url = Url::parse("http://[fe80::1]/").unwrap();
        assert!(host_is_allowed(&url));
        let url = Url::parse("http://[2001:4860:4860::8888]/").unwrap();
        assert!(!host_is_allowed(&url));
    }
}

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Protocol {
    #[default]
    Ftp,
    Ftps,
    Sftp,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthMethod {
    #[default]
    Password,
    PrivateKey,
    Agent,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionInfo {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub secure: bool,
    pub protocol: Protocol,
    pub auth_method: AuthMethod,
    pub cwd: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionInput {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub protocol: Option<Protocol>,
    #[serde(default)]
    pub auth_method: AuthMethod,
    pub private_key_path: Option<String>,
    pub timeout_seconds: Option<u32>,
    pub remote_path: Option<String>,
}
impl ConnectionInput {
    pub fn protocol(&self) -> Protocol {
        self.protocol.unwrap_or(if self.secure {
            Protocol::Ftps
        } else {
            Protocol::Ftp
        })
    }
    pub fn timeout(&self) -> Result<Duration, String> {
        timeout(self.timeout_seconds)
    }
}

pub(crate) fn timeout(seconds: Option<u32>) -> Result<Duration, String> {
    let seconds = seconds.unwrap_or(30);
    if !(1..=300).contains(&seconds) {
        return Err("Timeout must be between 1 and 300 seconds.".into());
    }
    Ok(Duration::from_secs(seconds as u64))
}

#[derive(Serialize)]
pub(crate) struct ConnectionResult {
    pub cwd: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TransferProgress {
    pub id: String,
    pub bytes: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct LocalListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Direction {
    Upload,
    Download,
}

#[derive(Deserialize)]
pub(crate) struct TransferInput {
    #[serde(default)]
    pub id: Option<String>,
    pub direction: Direction,
    pub source: String,
    pub destination: String,
}

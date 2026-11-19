use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
pub struct Request {
    pub id: u64,
    pub command: String,
    pub args: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    Result {
        id: u64,
        result: Result<Value, String>,
    },
    Event {
        name: String,
        payload: Value,
    },
    #[cfg(target_os = "android")]
    Android {
        action: AndroidAction,
    },
}

#[cfg(target_os = "android")]
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AndroidAction {
    Multicast {
        on: bool,
    },
    KeepAwake {
        id: String,
        on: bool,
    },
    Progress {
        id: String,
        name: String,
        percent: f64,
    },
    Scan {
        path: String,
    },
}

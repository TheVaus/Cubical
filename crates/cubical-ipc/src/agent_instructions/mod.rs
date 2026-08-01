mod consent;
mod content;

pub use consent::{
    accept, canonical_path, decline, status, sync_canonical, AgentInstructionsAccepted,
    AgentInstructionsStatus, OFFERED_SETTING_KEY,
};
pub use content::{render, CANONICAL_REL, POINTER_FILES};

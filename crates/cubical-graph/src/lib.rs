#![forbid(unsafe_code)]

mod error;
mod model;

pub use error::GraphError;
pub use model::{EdgeKind, GraphEdge, GraphModel, GraphNode, NodeId, NodeKind};

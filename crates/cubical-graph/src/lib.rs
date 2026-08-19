#![forbid(unsafe_code)]

mod build;
mod error;
mod model;
mod quadtree;

pub use build::build_model;
pub use error::GraphError;
pub use model::{EdgeKind, GraphEdge, GraphModel, GraphNode, NodeId, NodeKind};

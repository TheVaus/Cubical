#[derive(Debug, thiserror::Error)]
pub enum AstError {
    #[error("invalid frontmatter YAML: {0}")]
    InvalidFrontmatter(String),
}

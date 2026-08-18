use cubical_ast::{parse, Document};

pub async fn parse_off_executor(source: &str) -> Option<Document> {
    let owned = source.to_string();
    match tokio::task::spawn_blocking(move || parse(&owned)).await {
        Ok(doc) => Some(doc),
        Err(join_err) => {
            tracing::warn!(error = %join_err, "markdown parse task join failed");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parses_the_same_document_as_the_blocking_parser() {
        let src = "---\ntitle: T\n---\n\n# H\n\nbody with [[link]] and #tag\n";
        assert_eq!(parse_off_executor(src).await, Some(parse(src)));
    }

    #[tokio::test]
    async fn empty_source_parses_to_an_empty_document() {
        let doc = parse_off_executor("").await.expect("parsed");
        assert!(doc.frontmatter.is_none());
        assert!(doc.blocks.is_empty());
    }
}

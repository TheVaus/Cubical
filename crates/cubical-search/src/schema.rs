use tantivy::schema::{
    Field, IndexRecordOption, Schema, SchemaBuilder, TextFieldIndexing, TextOptions, FAST, INDEXED,
    STORED, STRING,
};
use tantivy::tokenizer::{
    Language, LowerCaser, SimpleTokenizer, Stemmer, TextAnalyzer, TokenizerManager,
};

pub const TOKENIZER_EN_STEM: &str = "en_stem";

pub const TOKENIZER_CODE: &str = "code";

#[derive(Debug, Clone, Copy)]
pub struct Fields {
    pub path: Field,
    pub title: Field,
    pub headings: Field,
    pub body: Field,
    pub code: Field,
    pub tags: Field,
    pub frontmatter: Field,
    pub mtime_secs: Field,
    pub size_bytes: Field,
}

pub fn build_schema() -> (Schema, Fields) {
    let mut sb = SchemaBuilder::new();

    let en_stem_indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER_EN_STEM)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);
    let code_indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER_CODE)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);

    let en_stem_stored = TextOptions::default()
        .set_indexing_options(en_stem_indexing)
        .set_stored();
    let code_stored = TextOptions::default()
        .set_indexing_options(code_indexing)
        .set_stored();

    let path = sb.add_text_field("path", STRING | STORED);
    let title = sb.add_text_field("title", en_stem_stored.clone());
    let headings = sb.add_text_field("headings", en_stem_stored.clone());
    let body = sb.add_text_field("body", en_stem_stored.clone());
    let code = sb.add_text_field("code", code_stored);
    let tags = sb.add_text_field("tags", STRING | STORED);
    let frontmatter = sb.add_text_field("frontmatter", en_stem_stored);
    let mtime_secs = sb.add_i64_field("mtime_secs", INDEXED | STORED | FAST);
    let size_bytes = sb.add_u64_field("size_bytes", INDEXED | STORED | FAST);

    (
        sb.build(),
        Fields {
            path,
            title,
            headings,
            body,
            code,
            tags,
            frontmatter,
            mtime_secs,
            size_bytes,
        },
    )
}

pub fn register_tokenizers(mgr: &TokenizerManager) {
    let en_stem = TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .filter(Stemmer::new(Language::English))
        .build();
    let code = TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .build();
    mgr.register(TOKENIZER_EN_STEM, en_stem);
    mgr.register(TOKENIZER_CODE, code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_all_expected_fields() {
        let (schema, f) = build_schema();
        assert_eq!(schema.get_field_name(f.path), "path");
        assert_eq!(schema.get_field_name(f.title), "title");
        assert_eq!(schema.get_field_name(f.headings), "headings");
        assert_eq!(schema.get_field_name(f.body), "body");
        assert_eq!(schema.get_field_name(f.code), "code");
        assert_eq!(schema.get_field_name(f.tags), "tags");
        assert_eq!(schema.get_field_name(f.frontmatter), "frontmatter");
        assert_eq!(schema.get_field_name(f.mtime_secs), "mtime_secs");
        assert_eq!(schema.get_field_name(f.size_bytes), "size_bytes");
    }

    #[test]
    fn prose_fields_are_stored() {
        let (schema, f) = build_schema();
        for field in [f.headings, f.body, f.code, f.frontmatter] {
            assert!(
                schema.get_field_entry(field).is_stored(),
                "expected {} to be STORED",
                schema.get_field_name(field)
            );
        }
    }

    #[test]
    fn tokenizers_register_under_expected_names() {
        let mgr = TokenizerManager::default();
        register_tokenizers(&mgr);
        assert!(
            mgr.get(TOKENIZER_EN_STEM).is_some(),
            "en_stem not registered"
        );
        assert!(
            mgr.get(TOKENIZER_CODE).is_some(),
            "code tokenizer not registered"
        );
    }
}

#[cfg(test)]
mod fixtures;
mod query;
mod repair;

pub use query::list_dangling_links;
pub use repair::repair_dangling_link;

pub(crate) const DANGLING_PREDICATE: &str =
    "(target_path IS NULL OR target_path NOT IN (SELECT path FROM files))";

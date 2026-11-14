//! Native CrossBreeze tooling integration.
//!
//! This crate depends on the protocol-independent engine, never its Node bindings.
pub use xcss_format::{FormatOptions, FormatResult, format};
pub use xcss_language_service::{LanguageService, ServiceSnapshot};

pub mod css;
pub mod documents;
pub mod setup;
pub mod transport;
pub mod typescript;
mod vite;
pub mod workspace;

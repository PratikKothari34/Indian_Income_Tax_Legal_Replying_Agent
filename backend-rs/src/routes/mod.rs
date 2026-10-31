//! HTTP route handlers.
//!
//! Paths are assembled in `crate::router`. Each module here owns its
//! request/response types so the wire shape is readable in one place —
//! that matters because an installed frontend updates independently of
//! the backend, and a renamed field ships a backend a working UI cannot
//! read.

pub mod generate;
pub mod health;
pub mod models;
pub mod rag;
pub mod upload;

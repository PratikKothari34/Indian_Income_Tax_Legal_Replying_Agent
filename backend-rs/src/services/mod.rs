//! Service layer: inference, parsing, rendering, retrieval, scheduling.

pub mod docx_writer;
pub mod llama_client;
pub mod llama_server;
pub mod parser;
pub mod prompts;
pub mod rag_embedder;
pub mod rag_scheduler;
pub mod rag_scraper;
pub mod session_store;
pub mod vector_store;

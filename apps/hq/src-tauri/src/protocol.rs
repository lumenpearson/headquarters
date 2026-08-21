//! Rust bindings generated from the repository-owned Protobuf contract.
//!
//! `build.rs` is the sole generator entry point.  It uses the vendored Protobuf
//! compiler, so a native HQ build never relies on a machine-wide `protoc` install.

#[allow(
    clippy::all,
    dead_code,
    missing_docs,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_qualifications
)]
pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/gremuchaya.protocol.v1.rs"));
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::v1::gremuchaya::{common::v1 as common, material::v1 as material};

    #[test]
    fn generated_contract_types_round_trip_across_package_boundaries() {
        let request = material::ListMaterialsRequest {
            group_id: Some(common::ResourceId {
                value: "grp_01jbxn3r8vqf12tkr6g7ndz9wq".to_owned(),
            }),
            page: Some(common::PageRequest {
                page_size: 48,
                cursor: "cursor_after_012".to_owned(),
                sort: vec![common::SortRule {
                    field: "updatedAt".to_owned(),
                    direction: common::SortDirection::Descending.into(),
                }],
                filter: None,
            }),
        };

        let encoded = request.encode_to_vec();
        let decoded = material::ListMaterialsRequest::decode(encoded.as_slice())
            .expect("generated material request must decode");

        assert_eq!(decoded, request);
    }
}

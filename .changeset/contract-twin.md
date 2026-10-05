---
"pgheal": minor
---

contract-twin: the code link to AegisForge (Temporit). A new `src/contract-twin/`
module ingests an AegisForge kanıt (the signed proof-of-work over smart-contract
security findings), re-verifies its recomputable commitment gates in pure
TypeScript, and merges it with a pgHeal scan into one **dual package** — both
halves of the "DB + contract security" sale in a single artifact, each side
still carrying its own proof. The kanıt byte format (domain-separated,
length-prefixed, canonically-sorted SHA-256 Merkle tree + preimage hash) is
implemented independently from the Rust spec and verified byte-for-byte against
a kanıt minted by the real engine (`test/fixtures/aegisforge-kanit.json`); the
secp256k1 signature and keccak address gates are honestly deferred to
`aegisforge verify` rather than faked. The merged gate reports `act` only when
both oracles delivered proof, `review` when only one did, and `clean` otherwise.

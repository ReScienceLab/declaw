---
"@resciencelab/declaw": minor
---

Add QUIC transport backend as zero-install fallback when Yggdrasil is unavailable. Introduces Transport abstraction interface, TransportManager for automatic selection, YggdrasilTransport and QUICTransport implementations with STUN-assisted NAT traversal, and multi-transport endpoint support in peer discovery.

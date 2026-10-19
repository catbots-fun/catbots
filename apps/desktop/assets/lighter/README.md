# Lighter signer

Built from elliottech/lighter-go v1.0.10, commit 9d38261d1a4cc5c7211b383ba07a4d6e41604708, using Go 1.26.2:

    GOOS=js GOARCH=wasm go build -o signer.wasm ./web-wasm

wasm_exec.js comes from the same Go toolchain (`lib/wasm/wasm_exec.js`).
The application verifies SHA-256 for both files before instantiation. No network download happens at application startup.
Upstream license is included. Go runtime code retains its BSD license header.
Each connection has an isolated VM so identical account indices on different networks cannot share signer state.
